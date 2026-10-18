#!/usr/bin/env python3
"""Localhost viewer for a Codex exec-server recorder's events.jsonl.

The capture file is the authoritative record. This server never starts a command, connects to
Codex, or changes the capture. A separate private file stores reversible viewer
preferences; browsers only read committed JSONL records.
"""

import argparse
import base64
import binascii
import json
import os
import pathlib
import shutil
import stat
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit


HERE = pathlib.Path(__file__).resolve().parent
MAX_EVENTS_PER_REQUEST = 350
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_PREFERENCE_REQUEST_BYTES = 4096
MAX_BULK_REQUEST_BYTES = 256 * 1024
MAX_BULK_KEYS = 1000
MAX_NOTE_LENGTH = 1000
HIDDEN_STATE_NAME = ".terminal-viewer-hidden.json"
ASSETS = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/terminal_render.js": ("terminal_render.js", "text/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
}


def process_key(event):
    process_id = event.get("process_id")
    if process_id is None:
        return None
    owner = event.get("connection_id")
    if owner is None:
        return None
    return f"{owner}:{process_id}"


class CaptureServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, handler, capture_dir, demo=False):
        super().__init__(address, handler)
        self.capture_dir = capture_dir.resolve(strict=True)
        if not self.capture_dir.is_dir():
            raise ValueError("Capture path must be a directory")
        self.event_path = self.capture_dir / "events.jsonl"
        self.hidden_state_path = self.capture_dir / HIDDEN_STATE_NAME
        self.hidden_state_lock = threading.Lock()
        self.demo = demo

    def safe_event_path(self):
        path = self.event_path
        if path.is_symlink():
            raise ValueError("Refusing linked capture file")
        if not path.exists():
            return None
        resolved = path.resolve(strict=True)
        if not resolved.is_relative_to(self.capture_dir):
            raise ValueError("Capture file escaped its directory")
        if not stat.S_ISREG(resolved.stat().st_mode):
            raise ValueError("Capture file is not regular")
        return resolved

    def recorded_process_keys(self):
        """Collect process tabs from complete, committed JSONL records only."""
        keys = set()
        path = self.safe_event_path()
        if path is None:
            return keys
        with path.open("rb") as capture:
            for line in capture:
                if not line.endswith(b"\n"):
                    break
                try:
                    event = json.loads(line)
                except (UnicodeDecodeError, json.JSONDecodeError):
                    continue
                if (isinstance(event, dict) and
                        event.get("type") not in ("recorder_start", "recorder_heartbeat",
                                                  "recorder_stop", "connection_closed") and
                        process_key(event) is not None):
                    keys.add(process_key(event))
        return keys

    def recorded_process_exists(self, key):
        """Match a committed event that creates a process tab in the viewer."""
        return key in self.recorded_process_keys()

    def read_viewer_state(self):
        path = self.hidden_state_path
        if path.is_symlink():
            raise ValueError("Refusing linked viewer state file")
        try:
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
            fd = os.open(path, flags)
        except FileNotFoundError:
            return {"hidden": set(), "notes": {}}
        with os.fdopen(fd, "r", encoding="utf-8") as state_file:
            if not stat.S_ISREG(os.fstat(state_file.fileno()).st_mode):
                raise ValueError("Viewer state file is not regular")
            state = json.load(state_file)
        if not isinstance(state, dict) or state.get("version") != 1:
            raise ValueError("Invalid viewer state file")
        hidden = state.get("hidden")
        if not isinstance(hidden, list) or any(not isinstance(key, str) for key in hidden):
            raise ValueError("Invalid viewer state file")
        notes = state.get("notes", {})
        if (not isinstance(notes, dict) or
                any(not isinstance(key, str) or not isinstance(note, str)
                    for key, note in notes.items())):
            raise ValueError("Invalid viewer state file")
        return {"hidden": set(hidden), "notes": notes}

    def write_viewer_state(self, state):
        """Replace only the sidecar atomically; never modify events.jsonl."""
        path = self.hidden_state_path
        if path.is_symlink() or (path.exists() and not path.is_file()):
            raise ValueError("Unsafe viewer state file")
        payload = json.dumps({"version": 1, "hidden": sorted(state["hidden"]),
                              "notes": state["notes"]},
                             ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        fd, temp_name = tempfile.mkstemp(prefix=".terminal-viewer-hidden-", dir=self.capture_dir)
        try:
            with os.fdopen(fd, "wb") as temp_file:
                os.chmod(temp_name, 0o600)
                temp_file.write(payload)
                temp_file.flush()
                os.fsync(temp_file.fileno())
            # Recheck immediately before replacement. os.replace itself replaces
            # a symlink entry rather than following it if one appears meanwhile.
            if path.is_symlink() or (path.exists() and not path.is_file()):
                raise ValueError("Unsafe viewer state file")
            os.replace(temp_name, path)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)

    def read_hidden_state(self):
        return self.read_viewer_state()["hidden"]

    def write_hidden_state(self, hidden):
        state = self.read_viewer_state()
        state["hidden"] = hidden
        self.write_viewer_state(state)


class Handler(BaseHTTPRequestHandler):
    server: CaptureServer
    protocol_version = "HTTP/1.0"

    def log_message(self, format, *args):
        # Avoid leaking process IDs, argv, or other capture metadata into a
        # second, uncontrolled server log.
        pass

    def send_common(self, status, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'none'; script-src 'self'; style-src 'self'; "
            "connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        )

    def json_response(self, status, value):
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_common(status, "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def localhost_host(self):
        hostname = self.headers.get("Host", "").split(":", 1)[0].lower()
        return hostname in ("127.0.0.1", "localhost")

    def do_GET(self):
        if not self.localhost_host():
            self.json_response(403, {"error": "localhost_only"})
            return
        parsed = urlsplit(self.path)
        if parsed.path in ASSETS:
            name, content_type = ASSETS[parsed.path]
            body = (HERE / name).read_bytes()
            self.send_common(200, content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == "/api/events":
            self.serve_events(parse_qs(parsed.query))
            return
        if parsed.path == "/api/meta":
            self.json_response(200, {"demo": self.server.demo})
            return
        if parsed.path == "/api/hidden":
            self.serve_hidden()
            return
        if parsed.path == "/api/notes":
            self.serve_notes()
            return
        if parsed.path == "/api/raw":
            self.serve_raw(parse_qs(parsed.query))
            return
        if parsed.path == "/api/capture":
            self.serve_capture()
            return
        self.json_response(404, {"error": "not_found"})

    def do_POST(self):
        # Browsers only send JSON with a matching Origin for this local page.
        # This rejects cross-site forms and JavaScript calls through a user's
        # browser, including DNS-rebinding attempts with a nonlocal Host.
        host = self.headers.get("Host", "")
        if (not self.localhost_host() or
                self.headers.get("Origin") != f"http://{host}" or
                getattr(self, "client_address", (None,))[0] not in ("127.0.0.1", "::1")):
            self.json_response(403, {"error": "local_origin_required"})
            return
        route = urlsplit(self.path).path
        if route not in ("/api/hidden", "/api/hidden/bulk", "/api/notes"):
            self.json_response(404, {"error": "not_found"})
            return
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            self.json_response(415, {"error": "json_required"})
            return
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            self.json_response(411, {"error": "content_length_required"})
            return
        request_limit = (MAX_BULK_REQUEST_BYTES if route == "/api/hidden/bulk"
                         else MAX_PREFERENCE_REQUEST_BYTES)
        if length < 1 or length > request_limit:
            self.json_response(413, {"error": "invalid_request_size"})
            return
        try:
            request = json.loads(self.rfile.read(length))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.json_response(400, {"error": "invalid_json"})
            return
        if route == "/api/hidden/bulk":
            self.hide_all_recorded(request)
        elif route == "/api/notes":
            self.save_note(request)
        else:
            self.set_hidden(request)

    def set_hidden(self, request):
        if (not isinstance(request, dict) or
                not isinstance(request.get("key"), str) or
                not 0 < len(request["key"]) <= 300 or
                not isinstance(request.get("hidden"), bool)):
            self.json_response(400, {"error": "invalid_hidden_request"})
            return
        key = request["key"]
        try:
            with self.server.hidden_state_lock:
                if not self.server.recorded_process_exists(key):
                    self.json_response(404, {"error": "process_not_found"})
                    return
                hidden = self.server.read_hidden_state()
                updated = hidden | {key} if request["hidden"] else hidden - {key}
                if updated != hidden:
                    self.server.write_hidden_state(updated)
                self.json_response(200, {"hidden": sorted(updated)})
        except (OSError, ValueError):
            self.json_response(500, {"error": "viewer_state_unavailable"})

    def hide_all_recorded(self, request):
        if (not isinstance(request, dict) or
                set(request) != {"keys"} or
                not isinstance(request["keys"], list) or
                len(request["keys"]) > MAX_BULK_KEYS or
                any(not isinstance(key, str) or not 0 < len(key) <= 300
                    for key in request["keys"])):
            self.json_response(400, {"error": "invalid_bulk_request"})
            return
        keys = set(request["keys"])
        try:
            with self.server.hidden_state_lock:
                if not keys.issubset(self.server.recorded_process_keys()):
                    self.json_response(404, {"error": "process_not_found"})
                    return
                hidden = self.server.read_hidden_state()
                updated = hidden | keys
                if updated != hidden:
                    self.server.write_hidden_state(updated)
                self.json_response(200, {"hidden": sorted(updated)})
        except (OSError, ValueError):
            self.json_response(500, {"error": "viewer_state_unavailable"})

    def save_note(self, request):
        if (not isinstance(request, dict) or
                not isinstance(request.get("key"), str) or
                not 0 < len(request["key"]) <= 300 or
                not isinstance(request.get("note"), str) or
                len(request["note"]) > MAX_NOTE_LENGTH):
            self.json_response(400, {"error": "invalid_note_request"})
            return
        key, note = request["key"], request["note"]
        try:
            with self.server.hidden_state_lock:
                if not self.server.recorded_process_exists(key):
                    self.json_response(404, {"error": "process_not_found"})
                    return
                state = self.server.read_viewer_state()
                notes = state["notes"]
                if note:
                    notes[key] = note
                else:
                    notes.pop(key, None)
                self.server.write_viewer_state(state)
                self.json_response(200, {"notes": notes})
        except (OSError, ValueError):
            self.json_response(500, {"error": "viewer_state_unavailable"})

    def serve_hidden(self):
        try:
            with self.server.hidden_state_lock:
                hidden = self.server.read_hidden_state()
            self.json_response(200, {"hidden": sorted(hidden)})
        except (OSError, ValueError):
            self.json_response(500, {"error": "viewer_state_unavailable"})

    def serve_notes(self):
        try:
            with self.server.hidden_state_lock:
                notes = self.server.read_viewer_state()["notes"]
            self.json_response(200, {"notes": notes})
        except (OSError, ValueError):
            self.json_response(500, {"error": "viewer_state_unavailable"})

    def serve_events(self, params):
        try:
            cursor = int(params.get("cursor", ["0"])[0])
            if cursor < 0:
                raise ValueError("negative cursor")
            path = self.server.safe_event_path()
            if path is None:
                self.json_response(200, {"events": [], "cursor": 0, "size": 0, "waiting": True})
                return
            size = path.stat().st_size
            if cursor > size:
                self.json_response(409, {"error": "capture_truncated", "size": size})
                return
            events = []
            consumed = 0
            with path.open("rb") as capture:
                capture.seek(cursor)
                while len(events) < MAX_EVENTS_PER_REQUEST and consumed < MAX_RESPONSE_BYTES:
                    line_start = capture.tell()
                    line = capture.readline()
                    if not line:
                        break
                    if not line.endswith(b"\n"):
                        # The recorder may be appending this line. Never expose
                        # an uncommitted partial event or advance beyond it.
                        capture.seek(line_start)
                        break
                    consumed += len(line)
                    try:
                        event = json.loads(line)
                        if not isinstance(event, dict):
                            raise ValueError("JSONL event is not an object")
                        events.append(event)
                    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
                        events.append({"type": "gap", "reason": "malformed_jsonl_line", "line_offset": line_start})
                next_cursor = capture.tell()
            self.json_response(200, {
                "events": events,
                "cursor": next_cursor,
                "size": size,
                "waiting": next_cursor >= size,
            })
        except (OSError, ValueError) as exc:
            self.json_response(400, {"error": str(exc)})

    def serve_raw(self, params):
        key = params.get("key", [""])[0]
        stream = params.get("stream", ["all"])[0]
        if not key or len(key) > 300 or stream not in ("all", "output", "stdout", "stderr", "pty", "stdin"):
            self.json_response(400, {"error": "invalid_raw_request"})
            return
        try:
            path = self.server.safe_event_path()
            if path is None:
                self.json_response(404, {"error": "capture_not_found"})
                return
            self.send_common(200, "application/octet-stream")
            self.send_header("Content-Disposition", f'attachment; filename="terminal-{stream}.raw"')
            self.end_headers()
            with path.open("rb") as capture:
                for line in capture:
                    if not line.endswith(b"\n"):
                        break
                    try:
                        event = json.loads(line)
                        if process_key(event) != key or event.get("type") not in ("output", "stdin"):
                            continue
                        kind = event.get("stream") if event["type"] == "output" else "stdin"
                        if stream == "output":
                            if event["type"] != "output":
                                continue
                        elif stream != "all" and stream != kind:
                            continue
                        self.wfile.write(base64.b64decode(event["chunk_b64"], validate=True))
                    except (ValueError, KeyError, TypeError, binascii.Error, json.JSONDecodeError):
                        continue
        except (OSError, ValueError):
            # The browser will report the broken download. No capture changes.
            return

    def serve_capture(self):
        try:
            path = self.server.safe_event_path()
            if path is None:
                self.json_response(404, {"error": "capture_not_found"})
                return
            self.send_common(200, "application/x-ndjson; charset=utf-8")
            self.send_header("Content-Disposition", 'attachment; filename="events.jsonl"')
            self.end_headers()
            with path.open("rb") as capture:
                shutil.copyfileobj(capture, self.wfile, length=1024 * 1024)
        except (OSError, ValueError):
            return


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture-dir", required=True, type=pathlib.Path,
                        help="Directory containing the recorder's events.jsonl")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--demo", action="store_true", help="Prominently label synthetic demo data")
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("Port must be in 0..65535")
    server = CaptureServer(("127.0.0.1", args.port), Handler, args.capture_dir, args.demo)
    host, port = server.server_address
    print(f"Terminal viewer: http://{host}:{port}/", flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
