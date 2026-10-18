#!/usr/bin/env python3
"""Offline synthetic checks for the terminal viewer."""

import base64
import io
import json
import os
import pathlib
import stat
import tempfile
import threading
import unittest
from urllib.parse import quote

from server import CaptureServer, Handler, HIDDEN_STATE_NAME


def event(**fields):
    base = {"ts": "2026-10-17T12:00:00Z", "connection_id": "connection-a",
            "session_id": None, "process_id": None}
    base.update(fields)
    return base


def encoded(value):
    return base64.b64encode(value).decode("ascii")


class ViewerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=pathlib.Path(__file__).resolve().parent)
        self.path = pathlib.Path(self.temp.name) / "events.jsonl"
        self.lines = [
            event(type="recorder_start"),
            event(type="start", process_id="one", argv=["printf", "ok"], cwd="/tmp", tty=False, pipe_stdin=False),
            event(type="start_accepted", session_id="session-a", process_id="one"),
            event(type="output", session_id="session-a", process_id="one", seq=1,
                  stream="stdout", chunk_b64=encoded(b"exact\x1b[31m\n")),
            event(type="stdin", session_id="session-a", process_id="one", chunk_b64=encoded(b"typed\n")),
            event(type="exited", session_id="session-a", process_id="one", seq=2, exit_code=0),
            event(type="closed", session_id="session-a", process_id="one", seq=3),
            event(type="start", process_id="two", argv=["listener"], cwd="/tmp", tty=True, pipe_stdin=True),
            event(type="output", session_id="session-a", process_id="two", seq=1,
                  stream="pty", chunk_b64=encoded(b"listening\n")),
            event(type="gap", session_id="session-a", process_id="two", reason="connection_closed_before_process_closed"),
            event(type="connection_closed", status="peer_closed"),
        ]
        self.path.write_bytes(b"".join((json.dumps(item) + "\n").encode() for item in self.lines))
        class FakeServer:
            capture_dir = pathlib.Path(self.temp.name)
            event_path = self.path
            hidden_state_path = capture_dir / HIDDEN_STATE_NAME
            hidden_state_lock = threading.Lock()
            demo = True
            safe_event_path = CaptureServer.safe_event_path
            recorded_process_keys = CaptureServer.recorded_process_keys
            recorded_process_exists = CaptureServer.recorded_process_exists
            read_viewer_state = CaptureServer.read_viewer_state
            write_viewer_state = CaptureServer.write_viewer_state
            read_hidden_state = CaptureServer.read_hidden_state
            write_hidden_state = CaptureServer.write_hidden_state
        self.server = FakeServer()

    def tearDown(self):
        self.temp.cleanup()

    def get(self, route):
        return self.request("GET", route)

    def post(self, route, payload, headers=None, client_address="127.0.0.1"):
        body = json.dumps(payload).encode("utf-8") if not isinstance(payload, bytes) else payload
        request_headers = {"Host": "127.0.0.1:8765", "Origin": "http://127.0.0.1:8765",
                           "Content-Type": "application/json", "Content-Length": str(len(body))}
        if headers:
            request_headers.update(headers)
        return self.request("POST", route, body=body, headers=request_headers,
                            client_address=client_address)

    def request(self, method, route, body=b"", headers=None, client_address="127.0.0.1"):
        handler = Handler.__new__(Handler)
        handler.server = self.server
        handler.path = route
        handler.headers = headers or {"Host": "127.0.0.1"}
        handler.client_address = (client_address, 54545)
        handler.rfile = io.BytesIO(body)
        handler.wfile = io.BytesIO()
        handler.status = None
        handler.response_headers = {}
        handler.send_response = lambda status: setattr(handler, "status", status)
        handler.send_header = lambda name, value: handler.response_headers.__setitem__(name, value)
        handler.end_headers = lambda: None
        if method == "GET":
            handler.do_GET()
        else:
            handler.do_POST()
        return handler.status, handler.response_headers, handler.wfile.getvalue()

    def test_replay_closed_and_unclosed_processes(self):
        _, headers, body = self.get("/api/events?cursor=0")
        result = json.loads(body)
        self.assertEqual(result["events"], self.lines)
        self.assertEqual(result["cursor"], self.path.stat().st_size)
        self.assertTrue(result["waiting"])
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertIn("default-src 'none'", headers["Content-Security-Policy"])
        _, _, follow = self.get("/api/events?cursor=" + str(result["cursor"]))
        self.assertEqual(json.loads(follow)["events"], [])

    def test_raw_keeps_bytes_and_channels_separate(self):
        key = quote("connection-a:one")
        _, _, stdout = self.get(f"/api/raw?key={key}&stream=stdout")
        _, _, stdin = self.get(f"/api/raw?key={key}&stream=stdin")
        _, _, output = self.get(f"/api/raw?key={key}&stream=output")
        self.assertEqual(stdout, b"exact\x1b[31m\n")
        self.assertEqual(stdin, b"typed\n")
        self.assertEqual(output, stdout)
        _, _, capture = self.get("/api/capture")
        self.assertEqual(capture, self.path.read_bytes())

    def test_terminal_renderer_asset_is_served_locally(self):
        status, headers, body = self.get("/terminal_render.js")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "text/javascript; charset=utf-8")
        self.assertIn(b"TerminalRenderer", body)

    def test_partial_line_is_not_exposed_then_recovers(self):
        partial = json.dumps(event(type="output", process_id="two", seq=2,
                                   stream="pty", chunk_b64=encoded(b"later"))).encode()
        with self.path.open("ab") as capture:
            capture.write(partial)
        _, _, data = self.get("/api/events?cursor=0")
        first = json.loads(data)
        self.assertEqual(first["events"], self.lines)
        self.assertEqual(first["cursor"], self.path.stat().st_size - len(partial))
        with self.path.open("ab") as capture:
            capture.write(b"\n")
        _, _, data = self.get("/api/events?cursor=" + str(first["cursor"]))
        self.assertEqual(len(json.loads(data)["events"]), 1)

    def test_demo_and_file_truncation_alert(self):
        _, _, body = self.get("/api/meta")
        self.assertTrue(json.loads(body)["demo"])
        status, _, _ = self.get("/api/events?cursor=9999999")
        self.assertEqual(status, 409)
        _, _, html = self.get("/")
        self.assertIn(b"demo-banner", html)
        self.assertIn(b'id="terminal-screen"', html)
        self.assertIn(b'id="terminal-reason"', html)

    def test_large_committed_line_does_not_stall_cursor(self):
        old_size = self.path.stat().st_size
        large = event(type="gap", reason="x" * (2 * 1024 * 1024 + 100))
        with self.path.open("ab") as capture:
            capture.write((json.dumps(large) + "\n").encode())
        _, _, body = self.get("/api/events?cursor=" + str(old_size))
        result = json.loads(body)
        self.assertEqual(len(result["events"]), 1)
        self.assertEqual(result["events"][0]["reason"], large["reason"])
        self.assertEqual(result["cursor"], self.path.stat().st_size)

    def test_hide_and_restore_are_persistent_and_do_not_change_capture(self):
        original = self.path.read_bytes()
        status, _, body = self.get("/api/hidden")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"hidden": []})
        for key in ("connection-a:one", "connection-a:two"):
            status, _, body = self.post("/api/hidden", {"key": key, "hidden": True})
            self.assertEqual(status, 200)
            self.assertIn(key, json.loads(body)["hidden"])
        sidecar = pathlib.Path(self.temp.name) / HIDDEN_STATE_NAME
        self.assertEqual(json.loads(sidecar.read_text())["hidden"],
                         ["connection-a:one", "connection-a:two"])
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE(sidecar.stat().st_mode), 0o600)
        self.assertEqual(self.path.read_bytes(), original)
        self.assertEqual(self.server.read_hidden_state(),
                         {"connection-a:one", "connection-a:two"})
        status, _, body = self.post("/api/hidden", {"key": "connection-a:one", "hidden": False})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"hidden": ["connection-a:two"]})
        _, _, body = self.get("/api/hidden")
        self.assertEqual(json.loads(body), {"hidden": ["connection-a:two"]})
        self.assertEqual(self.path.read_bytes(), original)

    def test_only_committed_process_events_can_be_hidden(self):
        sidecar = pathlib.Path(self.temp.name) / HIDDEN_STATE_NAME
        for key in ("connection-a:missing", "../../events.jsonl", "connection-b:one"):
            status, _, body = self.post("/api/hidden", {"key": key, "hidden": True})
            self.assertEqual(status, 404)
            self.assertEqual(json.loads(body), {"error": "process_not_found"})
        with self.path.open("ab") as capture:
            capture.write((json.dumps(event(type="output", process_id="orphan",
                                           stream="stdout", chunk_b64=encoded(b"seen"))) + "\n").encode())
            capture.write(json.dumps(event(type="output", process_id="partial",
                                           stream="stdout", chunk_b64=encoded(b"not committed"))).encode())
        status, _, body = self.post("/api/hidden", {"key": "connection-a:orphan", "hidden": True})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"hidden": ["connection-a:orphan"]})
        status, _, _ = self.post("/api/hidden", {"key": "connection-a:partial", "hidden": True})
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(sidecar.read_text())["hidden"], ["connection-a:orphan"])

    def test_bulk_hide_uses_frozen_keys_without_erasing_notes_or_capture(self):
        original = self.path.read_bytes()
        status, _, body = self.post("/api/notes", {"key": "connection-a:one", "note": "Local test"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["notes"], {"connection-a:one": "Local test"})
        confirmed_keys = ["connection-a:one", "connection-a:two"]
        with self.path.open("ab") as capture:
            capture.write((json.dumps(event(type="output", process_id="orphan",
                                           stream="stdout", chunk_b64=encoded(b"seen"))) + "\n").encode())
            capture.write(json.dumps(event(type="start", process_id="incomplete",
                                           argv=["never committed"])).encode())
        journal = self.path.read_bytes()
        status, _, body = self.post("/api/hidden/bulk", {"keys": confirmed_keys})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"hidden": confirmed_keys})
        self.assertNotIn("connection-a:orphan", json.loads(body)["hidden"])
        self.assertEqual(self.path.read_bytes(), journal)
        self.assertTrue(self.path.read_bytes().startswith(original))
        _, _, body = self.get("/api/notes")
        self.assertEqual(json.loads(body), {"notes": {"connection-a:one": "Local test"}})
        status, _, body = self.post("/api/hidden/bulk", {"keys": ["connection-a:incomplete"]})
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body), {"error": "process_not_found"})
        status, _, body = self.post("/api/hidden/bulk", {"keys": ["connection-a:missing"]})
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body), {"error": "process_not_found"})
        status, _, body = self.post("/api/hidden/bulk", {"delete": True})
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body), {"error": "invalid_bulk_request"})

    def test_notes_can_be_changed_and_cleared_without_changing_hidden_or_capture(self):
        original = self.path.read_bytes()
        self.assertEqual(json.loads(self.get("/api/notes")[2]), {"notes": {}})
        status, _, _ = self.post("/api/hidden", {"key": "connection-a:two", "hidden": True})
        self.assertEqual(status, 200)
        for value in ("Why: local test", "Request returned 200 OK"):
            status, _, body = self.post("/api/notes", {"key": "connection-a:one", "note": value})
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body), {"notes": {"connection-a:one": value}})
        state = json.loads((pathlib.Path(self.temp.name) / HIDDEN_STATE_NAME).read_text())
        self.assertEqual(state["hidden"], ["connection-a:two"])
        self.assertEqual(self.path.read_bytes(), original)
        status, _, body = self.post("/api/notes", {"key": "connection-a:one", "note": ""})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"notes": {}})
        self.assertEqual(json.loads(self.get("/api/hidden")[2]), {"hidden": ["connection-a:two"]})
        for payload, expected in (({"key": "connection-a:missing", "note": "x"}, 404),
                                  ({"key": "connection-a:one", "note": 2}, 400),
                                  ({"key": "connection-a:one", "note": "x" * 1001}, 400)):
            status, _, _ = self.post("/api/notes", payload)
            self.assertEqual(status, expected)
        self.assertEqual(self.path.read_bytes(), original)

    def test_post_rejects_cross_site_and_malformed_requests(self):
        key = "connection-a:one"
        rejected = [
            ({"Origin": "http://evil.example"}, "127.0.0.1", 403),
            ({"Origin": ""}, "127.0.0.1", 403),
            ({"Host": "evil.example", "Origin": "http://evil.example"}, "127.0.0.1", 403),
            ({}, "192.0.2.4", 403),
            ({"Content-Type": "text/plain"}, "127.0.0.1", 415),
            ({"Content-Length": "not-a-number"}, "127.0.0.1", 411),
            ({"Content-Length": "99999"}, "127.0.0.1", 413),
        ]
        for headers, client, expected in rejected:
            status, _, _ = self.post("/api/hidden", {"key": key, "hidden": True},
                                     headers=headers, client_address=client)
            self.assertEqual(status, expected)
        status, _, _ = self.post("/api/hidden", {"key": key, "hidden": "true"})
        self.assertEqual(status, 400)
        status, _, _ = self.post("/api/hidden", b"not json")
        self.assertEqual(status, 400)
        self.assertFalse((pathlib.Path(self.temp.name) / HIDDEN_STATE_NAME).exists())

    def test_new_mutations_require_same_origin_and_preserve_legacy_state(self):
        sidecar = pathlib.Path(self.temp.name) / HIDDEN_STATE_NAME
        sidecar.write_text(json.dumps({"version": 1, "hidden": ["connection-a:two"]}))
        for route, payload in (("/api/hidden/bulk", {"keys": ["connection-a:one"]}),
                               ("/api/notes", {"key": "connection-a:one", "note": "x"})):
            status, _, body = self.post(route, payload, headers={"Origin": "http://evil.example"})
            self.assertEqual(status, 403)
            self.assertEqual(json.loads(body), {"error": "local_origin_required"})
        self.assertEqual(json.loads(self.get("/api/notes")[2]), {"notes": {}})
        status, _, body = self.post("/api/notes", {"key": "connection-a:one", "note": "Added later"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["notes"], {"connection-a:one": "Added later"})
        self.assertEqual(json.loads(self.get("/api/hidden")[2]), {"hidden": ["connection-a:two"]})

    def test_linked_sidecar_is_not_read_or_written(self):
        outside = pathlib.Path(self.temp.name) / "outside.json"
        outside.write_text('DO NOT ALTER')
        sidecar = pathlib.Path(self.temp.name) / HIDDEN_STATE_NAME
        try:
            sidecar.symlink_to(outside)
        except (NotImplementedError, OSError):
            self.skipTest("Symlinks unavailable")
        status, _, body = self.get("/api/hidden")
        self.assertEqual(status, 500)
        self.assertEqual(json.loads(body), {"error": "viewer_state_unavailable"})
        status, _, body = self.post("/api/hidden", {"key": "connection-a:one", "hidden": True})
        self.assertEqual(status, 500)
        status, _, body = self.post("/api/notes", {"key": "connection-a:one", "note": "unsafe"})
        self.assertEqual(status, 500)
        status, _, body = self.post("/api/hidden/bulk", {"keys": ["connection-a:one"]})
        self.assertEqual(status, 500)
        self.assertEqual(outside.read_text(), 'DO NOT ALTER')


if __name__ == "__main__":
    unittest.main()
