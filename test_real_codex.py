#!/usr/bin/env python3
"""End-to-end check against the installed Codex CLI's real exec-server.

It starts a private `codex exec-server` on a loopback port, puts the recorder
proxy in front of it, runs one harmless local shell process with stdin through
the proxy, and verifies the journal and audit result. No model call is made and
no login is needed. Skipped when `codex` is not on PATH.
"""

from __future__ import annotations

import asyncio
import base64
import importlib.util
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest


HERE = pathlib.Path(__file__).resolve().parent
CODEX = shutil.which("codex")

spec = importlib.util.spec_from_file_location("terminal_web_proxy", HERE / "proxy.py")
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)


def codex_env() -> dict[str, str]:
    env = os.environ.copy()
    env.pop("CODEX_EXEC_SERVER_URL", None)
    return env


def exec_server_available() -> bool:
    if not CODEX:
        return False
    try:
        result = subprocess.run([CODEX, "exec-server", "--help"], env=codex_env(), text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0 and "--listen" in result.stdout


def first_line(process: subprocess.Popen, label: str, timeout: float = 30) -> str:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        line = process.stdout.readline()
        if line:
            return line.strip()
        if process.poll() is not None:
            raise AssertionError(f"{label} exited during startup")
    raise AssertionError(f"{label} did not announce an address")


async def run_client(url: str) -> list[dict]:
    host, port, path = proxy.parse_upstream(url)
    reader, writer = await asyncio.open_connection(host, port)
    await proxy.upstream_handshake(reader, writer, host, port, path, {})
    ws = proxy.WebSocket(reader, writer, expect_mask=False, send_mask=True)
    seen: list[dict] = []

    async def send(message: dict) -> None:
        await ws.send(1, json.dumps(message).encode("utf-8"))

    async def until(predicate) -> dict:
        while True:
            _, data = await asyncio.wait_for(ws.recv(), 20)
            message = json.loads(data)
            seen.append(message)
            if "error" in message:
                raise AssertionError(f"exec-server error: {message['error']}")
            if predicate(message):
                return message

    script = ("printf 'ready\\n'; while IFS= read -r line; do printf 'echo:%s\\n' \"$line\"; "
              "[ \"$line\" = quit ] && exit 0; done")
    await send({"id": 1, "method": "initialize", "params": {"clientName": "terminal-web-test"}})
    await until(lambda m: m.get("id") == 1)
    await send({"method": "initialized", "params": {}})
    await send({"id": 2, "method": "process/start", "params": {
        "processId": "smoke-1", "argv": ["sh", "-c", script], "cwd": pathlib.Path(tempfile.gettempdir()).as_uri(),
        "env": {"PATH": "/usr/bin:/bin"}, "tty": False, "pipeStdin": True, "arg0": None}})
    await until(lambda m: m.get("method") == "process/output")
    await send({"id": 3, "method": "process/write", "params": {
        "processId": "smoke-1", "writeId": "w-1", "chunk": base64.b64encode(b"hello\nquit\n").decode()}})
    await until(lambda m: m.get("method") == "process/closed")
    await ws.close()
    return seen


@unittest.skipUnless(exec_server_available(), "codex with `exec-server --listen` is not on PATH")
class RealExecServerTests(unittest.TestCase):
    def test_records_a_real_process_through_the_proxy(self) -> None:
        with tempfile.TemporaryDirectory(prefix="terminal-web-real-") as temp:
            capture = pathlib.Path(temp) / "capture"
            capture.mkdir(mode=0o700)
            children: list[subprocess.Popen] = []
            try:
                server = subprocess.Popen([CODEX, "exec-server", "--listen", "ws://127.0.0.1:0"],
                                          env=codex_env(), text=True, stdout=subprocess.PIPE,
                                          stderr=subprocess.DEVNULL)
                children.append(server)
                upstream = first_line(server, "exec-server")
                self.assertRegex(upstream, r"^ws://127\.0\.0\.1:\d+/?$")

                recorder = subprocess.Popen([sys.executable, str(HERE / "proxy.py"), "--listen-port", "0",
                                             "--upstream", upstream, "--capture-dir", str(capture)],
                                            text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                children.append(recorder)
                match = re.match(r"^Recorder listening at (ws://127\.0\.0\.1:\d+);",
                                 first_line(recorder, "proxy"))
                self.assertIsNotNone(match)

                messages = asyncio.run(run_client(match.group(1)))
                output = b"".join(base64.b64decode(m["params"]["chunk"]) for m in messages
                                  if m.get("method") == "process/output")
                self.assertIn(b"echo:hello\n", output)
                time.sleep(0.3)
            finally:
                for child in reversed(children):
                    child.terminate()
                    try:
                        child.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait()
                    child.stdout.close()

            events = [json.loads(line) for line in (capture / "events.jsonl").read_text("utf-8").splitlines()]
            kinds = [event["type"] for event in events if event.get("process_id") == "smoke-1"]
            for kind in ("start", "stdin", "output", "exited", "closed"):
                self.assertIn(kind, kinds)
            recorded = b"".join(base64.b64decode(event["chunk_b64"]) for event in events
                                if event.get("process_id") == "smoke-1" and event["type"] == "output")
            self.assertEqual(recorded, output, "journal bytes must match the bytes the client received")
            self.assertFalse([event for event in events if event["type"] == "gap"])

            audit = subprocess.run([sys.executable, str(HERE / "audit.py"), str(capture)],
                                   text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30)
            # A consistent recording still reports PARTIAL coverage (exit 2), never OK.
            self.assertEqual(audit.returncode, 2, audit.stdout)


if __name__ == "__main__":
    unittest.main()
