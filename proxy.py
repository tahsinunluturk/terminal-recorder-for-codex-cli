#!/usr/bin/env python3
"""Loopback-only, disk-first recorder for the Codex exec-server WebSocket protocol.

This is an opt-in development component. It does not attach to a running Codex CLI.
It records only exec-server process RPCs; it does not claim to capture commands that
bypass that executor, files written without terminal output, or another user's shell.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import binascii
import datetime as dt
import hashlib
import json
import os
import pathlib
import secrets
import signal
import stat
import struct
import sys
import urllib.parse
import uuid
from typing import Any


MAX_HEADERS = 16384
MAX_MESSAGE = 64 * 1024 * 1024
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds")


def parse_upstream(value: str) -> tuple[str, int, str]:
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme != "ws" or parsed.hostname != "127.0.0.1" or not parsed.port:
        raise ValueError("upstream must be ws://127.0.0.1:PORT[/path]")
    if parsed.username or parsed.password or parsed.fragment:
        raise ValueError("upstream URL cannot contain credentials or a fragment")
    path = parsed.path or "/"
    if parsed.query:
        path += "?" + parsed.query
    return parsed.hostname, parsed.port, path


class Journal:
    """Append-only private JSONL. An event is fsynced before its RPC is relayed."""

    def __init__(self, directory: pathlib.Path):
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        if directory.is_symlink() or not directory.is_dir():
            raise OSError("capture directory must be a real directory")
        if os.name == "posix":
            os.chmod(directory, 0o700)
        path = directory / "events.jsonl"
        if path.is_symlink():
            raise OSError("events.jsonl cannot be a symlink")
        flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
        self.fd = os.open(path, flags, 0o600)
        if not stat.S_ISREG(os.fstat(self.fd).st_mode):
            os.close(self.fd)
            raise OSError("events.jsonl must be a regular file")
        if os.name == "posix":
            os.fchmod(self.fd, 0o600)
        self.lock = asyncio.Lock()
        self.path = path

    async def append(self, event: dict[str, Any]) -> None:
        record = {"ts": utc_now(), **event}
        data = (json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        async with self.lock:
            offset = 0
            while offset < len(data):
                n = os.write(self.fd, data[offset:])
                if n <= 0:
                    raise OSError("short journal write")
                offset += n
            os.fsync(self.fd)

    def close(self) -> None:
        os.close(self.fd)


async def read_http_headers(reader: asyncio.StreamReader) -> tuple[str, dict[str, str]]:
    raw = await reader.readuntil(b"\r\n\r\n")
    if len(raw) > MAX_HEADERS:
        raise ValueError("oversized WebSocket handshake")
    lines = raw[:-4].decode("latin-1").split("\r\n")
    headers: dict[str, str] = {}
    for line in lines[1:]:
        if ":" not in line:
            raise ValueError("invalid WebSocket header")
        name, value = line.split(":", 1)
        headers[name.strip().lower()] = value.strip()
    return lines[0], headers


def accept_for(key: str) -> str:
    return base64.b64encode(hashlib.sha1((key + WS_GUID).encode("ascii")).digest()).decode("ascii")


async def client_handshake(reader: asyncio.StreamReader) -> tuple[str, dict[str, str]]:
    first, headers = await read_http_headers(reader)
    if not first.startswith("GET ") or "websocket" not in headers.get("upgrade", "").lower():
        raise ValueError("expected WebSocket upgrade")
    if headers.get("sec-websocket-version") != "13":
        raise ValueError("unsupported WebSocket version")
    key = headers.get("sec-websocket-key", "")
    try:
        if len(base64.b64decode(key, validate=True)) != 16:
            raise ValueError("invalid WebSocket key")
    except (ValueError, binascii.Error) as exc:
        raise ValueError("invalid WebSocket key") from exc
    return key, headers


async def upstream_handshake(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    host: str,
    port: int,
    path: str,
    client_headers: dict[str, str],
) -> dict[str, str]:
    key = base64.b64encode(secrets.token_bytes(16)).decode("ascii")
    lines = [
        f"GET {path} HTTP/1.1", f"Host: {host}:{port}", "Upgrade: websocket",
        "Connection: Upgrade", f"Sec-WebSocket-Key: {key}", "Sec-WebSocket-Version: 13",
    ]
    # Forward an optional local authentication token without ever putting it in
    # the journal. Do not negotiate compression; journal bytes must be plain JSON.
    for name in ("authorization", "origin", "sec-websocket-protocol"):
        if name in client_headers:
            lines.append(f"{name}: {client_headers[name]}")
    writer.write(("\r\n".join(lines) + "\r\n\r\n").encode("latin-1"))
    await writer.drain()
    status, headers = await read_http_headers(reader)
    if not status.startswith("HTTP/1.1 101") and not status.startswith("HTTP/1.0 101"):
        raise ValueError(f"upstream WebSocket upgrade failed: {status}")
    if headers.get("sec-websocket-accept") != accept_for(key):
        raise ValueError("invalid upstream WebSocket accept")
    if headers.get("sec-websocket-extensions"):
        raise ValueError("upstream unexpectedly enabled WebSocket compression")
    return headers


def frame(opcode: int, payload: bytes, mask: bool) -> bytes:
    if len(payload) > MAX_MESSAGE:
        raise ValueError("WebSocket message too large")
    header = bytearray([0x80 | opcode])
    n = len(payload)
    bit = 0x80 if mask else 0
    if n < 126:
        header.append(bit | n)
    elif n < 65536:
        header.append(bit | 126)
        header.extend(struct.pack("!H", n))
    else:
        header.append(bit | 127)
        header.extend(struct.pack("!Q", n))
    if mask:
        key = secrets.token_bytes(4)
        header.extend(key)
        payload = bytes(byte ^ key[i % 4] for i, byte in enumerate(payload))
    return bytes(header) + payload


class WebSocket:
    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, expect_mask: bool, send_mask: bool):
        self.reader = reader
        self.writer = writer
        self.expect_mask = expect_mask
        self.send_mask = send_mask

    async def send(self, opcode: int, payload: bytes) -> None:
        self.writer.write(frame(opcode, payload, self.send_mask))
        await self.writer.drain()

    async def recv(self) -> tuple[int, bytes] | None:
        parts = bytearray()
        initial_opcode: int | None = None
        while True:
            head = await self.reader.readexactly(2)
            fin = bool(head[0] & 0x80)
            opcode = head[0] & 0x0F
            if head[0] & 0x70:
                raise ValueError("unsupported WebSocket extension bits")
            masked = bool(head[1] & 0x80)
            if masked != self.expect_mask:
                raise ValueError("unexpected WebSocket masking")
            n = head[1] & 0x7F
            if n == 126:
                n = struct.unpack("!H", await self.reader.readexactly(2))[0]
            elif n == 127:
                n = struct.unpack("!Q", await self.reader.readexactly(8))[0]
            if n > MAX_MESSAGE or len(parts) + n > MAX_MESSAGE:
                raise ValueError("WebSocket message too large")
            key = await self.reader.readexactly(4) if masked else None
            payload = await self.reader.readexactly(n)
            if key:
                payload = bytes(byte ^ key[i % 4] for i, byte in enumerate(payload))
            if opcode == 0x9:  # ping, handled on this hop
                if not fin or n > 125:
                    raise ValueError("invalid ping frame")
                await self.send(0xA, payload)
                continue
            if opcode == 0xA:  # pong
                if not fin or n > 125:
                    raise ValueError("invalid pong frame")
                continue
            if opcode == 0x8:
                if not fin or n > 125:
                    raise ValueError("invalid close frame")
                return None
            if opcode not in (0x0, 0x1, 0x2):
                raise ValueError("unsupported WebSocket opcode")
            if opcode == 0x0 and initial_opcode is None:
                raise ValueError("unexpected continuation frame")
            if opcode in (0x1, 0x2):
                if initial_opcode is not None:
                    raise ValueError("new message before fragmented message ended")
                initial_opcode = opcode
            parts.extend(payload)
            if fin:
                return initial_opcode or opcode, bytes(parts)

    async def close(self) -> None:
        try:
            await self.send(0x8, b"\x03\xe8")
        except (OSError, ConnectionError, RuntimeError):
            pass
        self.writer.close()
        try:
            await self.writer.wait_closed()
        except (OSError, ConnectionError, RuntimeError):
            pass


class ConnectionRecorder:
    def __init__(self, journal: Journal):
        self.journal = journal
        self.connection_id = str(uuid.uuid4())
        self.session_id: str | None = None
        self.init_ids: set[str] = set()
        self.pending_start: dict[str, str] = {}
        self.pending_write: dict[str, str] = {}
        self.pending_read: dict[str, str] = {}
        self.active: dict[str, int] = {}
        self.next_seq: dict[str, int] = {}
        self.output_hashes: dict[str, dict[int, str]] = {}
        self.closed: set[str] = set()

    def base(self, event_type: str, process_id: str | None = None) -> dict[str, Any]:
        return {"type": event_type, "connection_id": self.connection_id,
                "session_id": self.session_id, "process_id": process_id}

    @staticmethod
    def rpc_id(obj: dict[str, Any]) -> str | None:
        return json.dumps(obj["id"], separators=(",", ":")) if "id" in obj else None

    async def check_seq(self, pid: str, seq: Any) -> None:
        if pid not in self.next_seq:
            await self.journal.append({**self.base("gap", pid), "reason": "event_without_start"})
            self.next_seq[pid] = 1
        if not isinstance(seq, int) or seq < 1:
            await self.journal.append({**self.base("gap", pid), "reason": "invalid_sequence",
                                       "observed_seq": seq})
            return
        expected = self.next_seq.get(pid, 1)
        if seq != expected:
            await self.journal.append({**self.base("gap", pid), "reason": "sequence_discontinuity",
                                       "expected_seq": expected, "observed_seq": seq})
        self.next_seq[pid] = max(expected, seq + 1)

    async def record_output(self, pid: str, params: dict[str, Any], source: str) -> None:
        seq = params.get("seq")
        stream = params.get("stream")
        chunk = params.get("chunk", "")
        if not isinstance(chunk, str):
            await self.journal.append({**self.base("gap", pid), "reason": "non_base64_output_chunk"})
            return
        try:
            base64.b64decode(chunk, validate=True)
        except (ValueError, binascii.Error):
            await self.journal.append({**self.base("gap", pid), "reason": "invalid_base64_output_chunk"})
            return
        digest = hashlib.sha256((str(stream) + "\0" + chunk).encode("utf-8")).hexdigest()
        if isinstance(seq, int):
            seen = self.output_hashes.setdefault(pid, {})
            if seq in seen:
                if seen[seq] != digest:
                    await self.journal.append({**self.base("gap", pid),
                                               "reason": "conflicting_output_duplicate", "seq": seq})
                return
            seen[seq] = digest
        await self.check_seq(pid, seq)
        await self.journal.append({**self.base("output", pid), "seq": seq,
                                   "stream": stream, "chunk_b64": chunk, "source": source})

    async def observe(self, direction: str, opcode: int, raw: bytes) -> None:
        if opcode != 0x1:
            # An opaque binary RPC would evade process-level recording.
            await self.journal.append({**self.base("gap"), "reason": "opaque_binary_message",
                                       "direction": direction})
            return
        try:
            obj = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError):
            await self.journal.append({**self.base("gap"), "reason": "unparseable_json_message",
                                       "direction": direction})
            return
        if not isinstance(obj, dict):
            return
        method = obj.get("method")
        params = obj.get("params") or {}
        if not isinstance(params, dict):
            return
        rid = self.rpc_id(obj)
        if direction == "client":
            if method == "initialize" and rid is not None:
                self.init_ids.add(rid)
            elif method == "process/start":
                pid = str(params.get("processId", ""))
                if not pid:
                    await self.journal.append({**self.base("gap"), "reason": "start_without_process_id"})
                    return
                self.pending_start[rid or str(uuid.uuid4())] = pid
                self.active[pid] = 1
                self.next_seq[pid] = 1
                await self.journal.append({**self.base("start", pid),
                    "argv": params.get("argv", []), "cwd": params.get("cwd"),
                    "tty": params.get("tty"), "pipe_stdin": params.get("pipeStdin")})
            elif method == "process/write":
                pid = str(params.get("processId", ""))
                self.pending_write[rid or str(uuid.uuid4())] = pid
                await self.journal.append({**self.base("stdin", pid),
                                           "chunk_b64": params.get("chunk", ""), "status": "requested"})
            elif method == "process/read" and rid is not None:
                self.pending_read[rid] = str(params.get("processId", ""))
            elif method == "process/terminate":
                await self.journal.append({**self.base("terminate_requested", str(params.get("processId", "")))})
        else:
            if rid in self.init_ids:
                self.init_ids.remove(rid)
                result = obj.get("result") or {}
                if isinstance(result, dict) and result.get("sessionId"):
                    self.session_id = str(result["sessionId"])
                    await self.journal.append({**self.base("session_ready")})
                else:
                    await self.journal.append({**self.base("gap"), "reason": "initialize_failed"})
            elif rid in self.pending_start:
                pid = self.pending_start.pop(rid)
                if "error" in obj:
                    self.active.pop(pid, None)
                    await self.journal.append({**self.base("start_failed", pid),
                                               "status": "error"})
                else:
                    await self.journal.append({**self.base("start_accepted", pid), "status": "accepted"})
            elif rid in self.pending_write:
                pid = self.pending_write.pop(rid)
                status = "error" if "error" in obj else "accepted"
                await self.journal.append({**self.base("stdin_ack", pid), "status": status})
            elif rid in self.pending_read:
                pid = self.pending_read.pop(rid)
                result = obj.get("result") or {}
                if "error" in obj or not isinstance(result, dict):
                    await self.journal.append({**self.base("read_failed", pid), "status": "error"})
                else:
                    chunks = result.get("chunks", [])
                    if not isinstance(chunks, list):
                        await self.journal.append({**self.base("gap", pid), "reason": "invalid_read_chunks"})
                    else:
                        for chunk in chunks:
                            if isinstance(chunk, dict):
                                await self.record_output(pid, chunk, "process/read")
                            else:
                                await self.journal.append({**self.base("gap", pid),
                                                           "reason": "invalid_read_chunk"})
                    if result.get("closed") and pid not in self.closed:
                        await self.journal.append({**self.base("gap", pid),
                            "reason": "read_reports_closed_without_notification"})
                        await self.journal.append({**self.base("closed", pid), "seq": None,
                                                   "source": "process/read"})
                        self.closed.add(pid)
                        self.active.pop(pid, None)
            elif method in ("process/output", "process/exited", "process/closed"):
                pid = str(params.get("processId", ""))
                seq = params.get("seq")
                if method == "process/output":
                    await self.record_output(pid, params, "notification")
                elif method == "process/exited":
                    await self.check_seq(pid, seq)
                    await self.journal.append({**self.base("exited", pid), "seq": seq,
                        "exit_code": params.get("exitCode"), "sandbox_denied": params.get("sandboxDenied")})
                else:
                    await self.check_seq(pid, seq)
                    await self.journal.append({**self.base("closed", pid), "seq": seq})
                    self.closed.add(pid)
                    self.active.pop(pid, None)

    async def finish(self, status: str) -> None:
        for pid in self.active:
            if pid not in self.closed:
                await self.journal.append({**self.base("gap", pid),
                    "reason": "connection_closed_before_process_closed"})
        await self.journal.append({**self.base("connection_closed"), "status": status})


async def relay(source: WebSocket, destination: WebSocket, recorder: ConnectionRecorder, direction: str) -> str:
    while True:
        try:
            message = await source.recv()
        except asyncio.IncompleteReadError:
            return f"{direction}_eof"
        if message is None:
            return f"{direction}_closed"
        opcode, payload = message
        await recorder.observe(direction, opcode, payload)
        await destination.send(opcode, payload)


async def handle_connection(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    journal: Journal,
    upstream: tuple[str, int, str],
) -> None:
    recorder = ConnectionRecorder(journal)
    client: WebSocket | None = None
    backend: WebSocket | None = None
    backend_writer: asyncio.StreamWriter | None = None
    pumps: list[asyncio.Task] = []
    status = "handshake_failed"
    try:
        client_key, client_headers = await client_handshake(reader)
        backend_reader, backend_writer = await asyncio.open_connection(upstream[0], upstream[1])
        backend_headers = await upstream_handshake(backend_reader, backend_writer, *upstream, client_headers)
        protocol = backend_headers.get("sec-websocket-protocol")
        response = ["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade",
                    f"Sec-WebSocket-Accept: {accept_for(client_key)}"]
        if protocol:
            response.append(f"Sec-WebSocket-Protocol: {protocol}")
        writer.write(("\r\n".join(response) + "\r\n\r\n").encode("ascii"))
        await writer.drain()
        client = WebSocket(reader, writer, expect_mask=True, send_mask=False)
        backend = WebSocket(backend_reader, backend_writer, expect_mask=False, send_mask=True)
        await journal.append({**recorder.base("connection_open"), "status": "connected"})
        pumps = [asyncio.create_task(relay(client, backend, recorder, "client")),
                 asyncio.create_task(relay(backend, client, recorder, "upstream"))]
        done, pending = await asyncio.wait(pumps, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        completed = next(iter(done))
        status = completed.result()
    except Exception as exc:
        status = f"error:{type(exc).__name__}"
        print(f"proxy connection {recorder.connection_id}: {exc}", file=sys.stderr)
    except asyncio.CancelledError:
        status = "recorder_stopped"
        raise
    finally:
        for task in pumps:
            if not task.done():
                task.cancel()
        await asyncio.gather(*pumps, return_exceptions=True)
        try:
            await recorder.finish(status)
        finally:
            if client is not None:
                await client.close()
            else:
                writer.close()
                await writer.wait_closed()
            if backend is not None:
                await backend.close()
            elif backend_writer is not None:
                backend_writer.close()
                await backend_writer.wait_closed()


async def serve(args: argparse.Namespace) -> None:
    if not 0 <= args.listen_port <= 65535:
        raise ValueError("listen port must be 0..65535")
    upstream = parse_upstream(args.upstream)
    if args.listen_port and upstream[1] == args.listen_port:
        raise ValueError("proxy and upstream ports must differ")
    journal = Journal(pathlib.Path(args.capture_dir))
    server: asyncio.AbstractServer | None = None
    heartbeat: asyncio.Task | None = None
    handlers: set[asyncio.Task] = set()
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    installed_signals = []
    for signum in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(signum, stop.set)
            installed_signals.append(signum)
        except (NotImplementedError, RuntimeError):
            # Windows event loops may not support add_signal_handler.
            pass
    try:
        await journal.append({"type": "recorder_start", "connection_id": None,
                              "session_id": None, "process_id": None})
        async def on_connection(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            task = asyncio.current_task()
            assert task is not None
            handlers.add(task)
            try:
                await handle_connection(reader, writer, journal, upstream)
            finally:
                handlers.discard(task)
        server = await asyncio.start_server(on_connection, host="127.0.0.1", port=args.listen_port)
        async def pulse():
            while True:
                await asyncio.sleep(2)
                await journal.append({"type": "recorder_heartbeat", "connection_id": None,
                                      "session_id": None, "process_id": None})
        heartbeat = asyncio.create_task(pulse())
        actual_port = server.sockets[0].getsockname()[1]
        if actual_port == upstream[1]:
            raise ValueError("proxy and upstream ports must differ")
        print(f"Recorder listening at ws://127.0.0.1:{actual_port}; journal: {journal.path}", flush=True)
        async with server:
            serving = asyncio.create_task(server.serve_forever())
            stopping = asyncio.create_task(stop.wait())
            done, pending = await asyncio.wait((serving, heartbeat, stopping), return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
            for task in done:
                task.result()
    except asyncio.CancelledError:
        pass
    finally:
        if heartbeat is not None and not heartbeat.done():
            heartbeat.cancel()
            await asyncio.gather(heartbeat, return_exceptions=True)
        if server is not None:
            server.close()
            await server.wait_closed()
        active_handlers = tuple(handlers)
        if active_handlers:
            await asyncio.wait(active_handlers, timeout=2)
        active_handlers = tuple(handlers)
        for task in active_handlers:
            task.cancel()
        await asyncio.gather(*active_handlers, return_exceptions=True)
        try:
            await journal.append({"type": "recorder_stop", "connection_id": None,
                                  "session_id": None, "process_id": None})
        finally:
            journal.close()
            for signum in installed_signals:
                loop.remove_signal_handler(signum)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--listen-port", type=int, default=8766)
    parser.add_argument("--upstream", default="ws://127.0.0.1:8767")
    parser.add_argument("--capture-dir", required=True)
    args = parser.parse_args()
    try:
        asyncio.run(serve(args))
    except KeyboardInterrupt:
        pass
    except (OSError, ValueError) as exc:
        raise SystemExit(str(exc)) from exc


if __name__ == "__main__":
    main()
