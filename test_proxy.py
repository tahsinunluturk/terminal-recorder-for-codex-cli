#!/usr/bin/env python3
"""Offline loopback tests. The fake executor never starts a real command."""

import asyncio
import base64
import importlib.util
import json
import pathlib
import tempfile
import unittest


spec = importlib.util.spec_from_file_location("terminal_web_proxy", pathlib.Path(__file__).with_name("proxy.py"))
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)


async def open_websocket(port):
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    key = base64.b64encode(b"0123456789abcdef").decode()
    writer.write((
        "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n"
        "Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n"
        f"Sec-WebSocket-Key: {key}\r\n\r\n"
    ).encode("ascii"))
    await writer.drain()
    first, headers = await proxy.read_http_headers(reader)
    assert first.startswith("HTTP/1.1 101"), first
    assert headers["sec-websocket-accept"] == proxy.accept_for(key)
    return proxy.WebSocket(reader, writer, expect_mask=False, send_mask=True)


async def fake_handshake(reader, writer):
    _, headers = await proxy.read_http_headers(reader)
    key = headers["sec-websocket-key"]
    writer.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                  "Connection: Upgrade\r\n"
                  f"Sec-WebSocket-Accept: {proxy.accept_for(key)}\r\n\r\n").encode("ascii"))
    await writer.drain()
    return proxy.WebSocket(reader, writer, expect_mask=True, send_mask=False)


async def send_json(ws, obj):
    await ws.send(0x1, json.dumps(obj, separators=(",", ":")).encode("utf-8"))


async def recv_json(ws):
    opcode, payload = await asyncio.wait_for(ws.recv(), timeout=3)
    assert opcode == 0x1
    return json.loads(payload)


class ProxyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.journal = proxy.Journal(pathlib.Path(self.temp.name))
        self.tasks = []

    async def asyncTearDown(self):
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        self.journal.close()
        self.temp.cleanup()

    async def setup_pair(self, fake):
        upstream = await asyncio.start_server(fake, host="127.0.0.1", port=0)
        upstream_port = upstream.sockets[0].getsockname()[1]
        recorder = await asyncio.start_server(
            lambda r, w: proxy.handle_connection(r, w, self.journal,
                                                 ("127.0.0.1", upstream_port, "/")),
            host="127.0.0.1", port=0)
        recorder_port = recorder.sockets[0].getsockname()[1]
        self.addAsyncCleanup(upstream.wait_closed)
        self.addAsyncCleanup(recorder.wait_closed)
        self.addAsyncCleanup(upstream.close)
        self.addAsyncCleanup(recorder.close)
        return recorder_port

    def events(self):
        return [json.loads(line) for line in pathlib.Path(self.temp.name, "events.jsonl").read_text().splitlines()]

    async def test_full_duplex_processes_closed_retained_and_no_env(self):
        async def fake(reader, writer):
            ws = await fake_handshake(reader, writer)
            req = await recv_json(ws)
            self.assertEqual(req["method"], "initialize")
            await send_json(ws, {"id": req["id"], "result": {"sessionId": "session-demo"}})
            self.assertEqual((await recv_json(ws))["method"], "initialized")
            for idx, pid in enumerate(("listener", "payload"), start=2):
                req = await recv_json(ws)
                self.assertEqual(req["method"], "process/start")
                # Recording is durable before the process request reaches executor.
                self.assertTrue(any(e["type"] == "start" and e["process_id"] == pid
                                    for e in self.events()))
                await send_json(ws, {"id": req["id"], "result": {"processId": pid}})
                await send_json(ws, {"method": "process/output", "params": {
                    "processId": pid, "seq": 1, "stream": "pty",
                    "chunk": base64.b64encode(f"{pid}: ready\n".encode()).decode()}})
            req = await recv_json(ws)
            self.assertEqual(req["method"], "process/write")
            self.assertEqual(req["params"]["processId"], "listener")
            await send_json(ws, {"id": req["id"], "result": {"status": "accepted"}})
            await send_json(ws, {"method": "process/output", "params": {
                "processId": "listener", "seq": 2, "stream": "pty",
                "chunk": base64.b64encode(b"received payload\n").decode()}})
            for pid, seq in (("payload", 2), ("listener", 3)):
                await send_json(ws, {"method": "process/exited", "params": {
                    "processId": pid, "seq": seq, "exitCode": 0}})
                await send_json(ws, {"method": "process/closed", "params": {
                    "processId": pid, "seq": seq + 1}})
            await asyncio.sleep(0.05)
            await ws.close()

        port = await self.setup_pair(fake)
        client = await open_websocket(port)
        await send_json(client, {"id": 1, "method": "initialize", "params": {"clientName": "test"}})
        self.assertEqual((await recv_json(client))["result"]["sessionId"], "session-demo")
        await send_json(client, {"method": "initialized", "params": {}})
        for idx, pid in enumerate(("listener", "payload"), start=2):
            await send_json(client, {"id": idx, "method": "process/start", "params": {
                "processId": pid, "argv": ["bash", "-lc", pid], "cwd": "file:///tmp",
                "env": {"SECRET": "never-in-journal"}, "tty": True, "pipeStdin": False}})
            self.assertEqual((await recv_json(client))["result"]["processId"], pid)
            self.assertEqual((await recv_json(client))["params"]["processId"], pid)
        await send_json(client, {"id": 4, "method": "process/write", "params": {
            "processId": "listener", "chunk": base64.b64encode(b"send\n").decode()}})
        self.assertEqual((await recv_json(client))["result"]["status"], "accepted")
        # Drain output and both pairs of lifecycle notifications.
        for _ in range(5):
            await recv_json(client)
        await client.close()
        await asyncio.sleep(0.1)
        events = self.events()
        self.assertEqual({e["process_id"] for e in events if e["type"] == "closed"},
                         {"listener", "payload"})
        self.assertEqual(len([e for e in events if e["type"] == "gap"]), 0)
        self.assertTrue(any(e["type"] == "stdin" and e["chunk_b64"] == "c2VuZAo=" for e in events))
        self.assertEqual(len([e for e in events if e["type"] == "output"]), 3)
        output_by_pid = {}
        for event in events:
            if event["type"] == "output":
                output_by_pid.setdefault(event["process_id"], b"")
                output_by_pid[event["process_id"]] += base64.b64decode(event["chunk_b64"])
        self.assertEqual(output_by_pid, {"listener": b"listener: ready\nreceived payload\n",
                                         "payload": b"payload: ready\n"})
        self.assertTrue(all(e["session_id"] == "session-demo" for e in events
                            if e["type"] in {"start", "output", "closed"}))
        self.assertNotIn("never-in-journal", pathlib.Path(self.temp.name, "events.jsonl").read_text())

    async def test_sequence_gap_and_unclosed_process_are_visible(self):
        async def fake(reader, writer):
            ws = await fake_handshake(reader, writer)
            req = await recv_json(ws)
            await send_json(ws, {"id": req["id"], "result": {"sessionId": "s2"}})
            await recv_json(ws)
            req = await recv_json(ws)
            await send_json(ws, {"id": req["id"], "result": {"processId": "p"}})
            await send_json(ws, {"method": "process/output", "params": {
                "processId": "p", "seq": 2, "stream": "stdout", "chunk": "YQ=="}})
            await ws.close()

        port = await self.setup_pair(fake)
        client = await open_websocket(port)
        await send_json(client, {"id": 1, "method": "initialize", "params": {}})
        await recv_json(client)
        await send_json(client, {"method": "initialized", "params": {}})
        await send_json(client, {"id": 2, "method": "process/start", "params": {
            "processId": "p", "argv": ["echo", "a"], "cwd": "file:///tmp", "tty": False}})
        await recv_json(client)
        await recv_json(client)
        await client.close()
        await asyncio.sleep(0.1)
        gaps = [e["reason"] for e in self.events() if e["type"] == "gap"]
        self.assertIn("sequence_discontinuity", gaps)
        self.assertIn("connection_closed_before_process_closed", gaps)

    async def test_fragmented_text_ping_and_binary_pass_through(self):
        async def fake(reader, writer):
            ws = await fake_handshake(reader, writer)
            opcode, payload = await ws.recv()
            self.assertEqual((opcode, payload), (0x1, b'{"method":"initialized"}'))
            await ws.send(0x2, b"opaque")
            await ws.close()

        port = await self.setup_pair(fake)
        client = await open_websocket(port)
        # Send masked Ping, then a JSON message split across two frames.
        await client.send(0x9, b"ping")
        first = bytearray(proxy.frame(0x1, b'{"method":', True))
        first[0] &= 0x7F  # FIN=0
        second = proxy.frame(0x0, b'"initialized"}', True)
        client.writer.write(bytes(first) + second)
        await client.writer.drain()
        self.assertEqual(await asyncio.wait_for(client.reader.readexactly(2), 3), b"\x8a\x04")
        self.assertEqual(await client.reader.readexactly(4), b"ping")
        self.assertEqual(await asyncio.wait_for(client.recv(), 3), (0x2, b"opaque"))
        await client.close()
        await asyncio.sleep(0.1)
        self.assertIn("opaque_binary_message", [e.get("reason") for e in self.events()])

    async def test_read_recovery_deduplicates_raw_large_output(self):
        # Exceeds exec-server's approximate 1 MiB retained-output window; the
        # recorder must persist the pushed bytes as they pass through.
        raw_output = b"Z" * 1_200_000 + b"\x00\xff"
        encoded = base64.b64encode(raw_output).decode()

        async def fake(reader, writer):
            ws = await fake_handshake(reader, writer)
            req = await recv_json(ws)
            await send_json(ws, {"id": req["id"], "result": {"sessionId": "read-session"}})
            await recv_json(ws)
            req = await recv_json(ws)
            await send_json(ws, {"id": req["id"], "result": {"processId": "big"}})
            req = await recv_json(ws)
            self.assertEqual(req["method"], "process/read")
            chunk = {"seq": 1, "stream": "stdout", "chunk": encoded}
            await send_json(ws, {"id": req["id"], "result": {"chunks": [chunk], "nextSeq": 2,
                                                            "exited": False, "closed": False}})
            await send_json(ws, {"method": "process/output", "params": {"processId": "big", **chunk}})
            await send_json(ws, {"method": "process/exited", "params": {
                "processId": "big", "seq": 2, "exitCode": 0}})
            await send_json(ws, {"method": "process/closed", "params": {"processId": "big", "seq": 3}})
            await ws.close()

        port = await self.setup_pair(fake)
        client = await open_websocket(port)
        await send_json(client, {"id": 1, "method": "initialize", "params": {}})
        await recv_json(client)
        await send_json(client, {"method": "initialized", "params": {}})
        await send_json(client, {"id": 2, "method": "process/start", "params": {
            "processId": "big", "argv": ["big-output"], "cwd": "file:///tmp", "tty": False}})
        await recv_json(client)
        await send_json(client, {"id": 3, "method": "process/read", "params": {
            "processId": "big", "afterSeq": None}})
        await recv_json(client)
        for _ in range(3):
            await recv_json(client)
        await client.close()
        await asyncio.sleep(0.1)
        events = self.events()
        outputs = [e for e in events if e["type"] == "output"]
        self.assertEqual(len(outputs), 1)
        self.assertEqual(outputs[0]["source"], "process/read")
        self.assertEqual(base64.b64decode(outputs[0]["chunk_b64"]), raw_output)
        self.assertFalse(any(e["type"] == "gap" for e in events))

    def test_only_loopback_upstream(self):
        for url in ("ws://192.0.2.1:9000", "wss://127.0.0.1:9000", "ws://localhost:9000"):
            with self.assertRaises(ValueError):
                proxy.parse_upstream(url)


if __name__ == "__main__":
    unittest.main()
