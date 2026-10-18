#!/usr/bin/env python3
"""Create a synthetic terminal capture for the local web preview.

The commands below are examples in a JSONL fixture. This script never runs them.
The fixture covers parallel terminals, interactive stdin, a curl response saved
to a file, optional run-step/report-step wrapper links, ANSI output, stderr, a failed command, a launch failure, a large
output, and an interrupted connection.
"""

from __future__ import annotations

import argparse
import base64
import json
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path


def encoded(value: str) -> str:
    return base64.b64encode(value.encode("utf-8")).decode("ascii")


CWD = "/home/demo/webapp"
ENGAGEMENT = "webapp"
EVIDENCE = f"engagements/{ENGAGEMENT}/evidence"


class Timeline:
    """Collect synthetic events with explicit offsets so parallel work overlaps."""

    def __init__(self) -> None:
        self.events: list[tuple[float, int, str | None, str | None, str, dict]] = []
        self.seq: dict[tuple[str, str], int] = {}

    def add(self, at: float, connection: str | None, process: str | None, kind: str, **details) -> None:
        if kind in ("output", "exited", "closed") and connection and process:
            key = (connection, process)
            self.seq[key] = self.seq.get(key, 0) + 1
            details = {"seq": self.seq[key], **details}
        self.events.append((at, len(self.events), connection, process, kind, details))

    def start(self, at: float, connection: str, process: str, argv: list[str], *,
              tty: bool = False, reason: str | None = None) -> None:
        details = {"argv": argv, "cwd": CWD, "tty": tty, "pipe_stdin": False}
        if reason:
            details["reason"] = reason
        self.add(at, connection, process, "start", **details)
        self.add(at + 0.05, connection, process, "start_accepted", status="accepted")

    def out(self, at: float, connection: str, process: str, text: str, stream: str = "stdout") -> None:
        self.add(at, connection, process, "output", stream=stream, chunk_b64=encoded(text))

    def finish(self, at: float, connection: str, process: str, code: int = 0) -> None:
        self.add(at, connection, process, "exited", exit_code=code)
        self.add(at + 0.02, connection, process, "closed")

    def ordered(self):
        return sorted(self.events, key=lambda item: (item[0], item[1]))


def run_step(action: str, *options: str) -> list[str]:
    return ["bash", "tools/run-step", ENGAGEMENT, action, *options]


def build() -> Timeline:
    t = Timeline()
    main, lost = "demo-main", "demo-interrupted"
    t.add(0, None, None, "recorder_start")
    t.add(0.2, main, None, "connection_open", status="connected")

    # Terminal #1: a git overview.
    t.start(1, main, "git-status", ["git", "status", "--short", "--branch"])
    t.out(1.2, main, "git-status", "## main...origin/main\n M src/server.py\n?? notes.txt\n")
    t.finish(1.3, main, "git-status")

    # Terminal #2 and #3: a development server in a PTY and a request against it,
    # with a captured event reason and interactive stdin to stop the server.
    t.start(3, main, "dev-server", ["python3", "-u", "src/server.py", "--port", "8766"], tty=True,
            reason="Start the development server and watch it handle a request.")
    t.out(3.4, main, "dev-server", "\x1b[32mINFO\x1b[0m listening on 127.0.0.1:8766\r\n", "pty")
    t.start(6, main, "request", ["curl", "-isS", "http://127.0.0.1:8766/health"],
            reason="Check that the server answers on its health endpoint.")
    t.out(6.3, main, "dev-server",
          "\x1b[36mREQ\x1b[0m 127.0.0.1 \"GET /health HTTP/1.1\" \x1b[1;32m200\x1b[0m 15\r\n", "pty")
    t.out(6.4, main, "request", "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"status\": \"ok\"}\n")
    t.finish(6.5, main, "request")

    # Terminal #4: curl saving the body to a file, so stdout stays empty.
    t.start(9, main, "save-response", ["curl", "-sS", "-o", "build/health.json",
                                       "http://127.0.0.1:8766/health"])
    t.finish(9.3, main, "save-response")

    # Terminal #5: a search across the source tree.
    t.start(12, main, "search-todo", ["rg", "-n", "TODO", "src"])
    t.out(12.2, main, "search-todo",
          "src/server.py:41:    # TODO: validate the port range\n"
          "src/routes.py:12:# TODO: add pagination\n")
    t.finish(12.3, main, "search-todo")

    # Terminal #6: a failing test run with colored output and a non-zero exit.
    t.start(16, main, "tests", ["python3", "-m", "pytest", "-q"])
    t.out(16.8, main, "tests", "..\x1b[31mF\x1b[0m....\n")
    t.out(17.4, main, "tests",
          "\x1b[31mFAILED\x1b[0m tests/test_routes.py::test_pagination - AssertionError: 20 != 10\n"
          "\x1b[31m1 failed\x1b[0m, \x1b[32m6 passed\x1b[0m in 0.42s\n")
    t.finish(17.5, main, "tests", 1)

    # Terminal #7: a command printing to stderr.
    t.start(21, main, "lint", ["sh", "-c", "python3 -m pyflakes src || true"])
    t.out(21.3, main, "lint", "src/routes.py:3:1: 'json' imported but unused\n", "stderr")
    t.finish(21.4, main, "lint")

    # Terminals #8-#10: optional step wrappers (see "Step wrappers" in README.md).
    # A run-step saves an API response to declared artifacts, an offline reader
    # shows the saved body, and a report-step cites both.
    t.start(22, main, "config-01", run_step(
        "config-01", "--purpose", "Save the public config endpoint response",
        "--artifact", f"{EVIDENCE}/config-01.headers", "--artifact", f"{EVIDENCE}/config-01.json", "--",
        "curl", "-sS", "-D", f"{EVIDENCE}/config-01.headers", "-o", f"{EVIDENCE}/config-01.json",
        "http://127.0.0.1:8766/api/config"))
    t.out(22.4, main, "config-01",
          "[run-step] exit 0 · stdout 0 bytes\n"
          f"[run-step] artifact {EVIDENCE}/config-01.headers 96 bytes\n"
          f"[run-step] artifact {EVIDENCE}/config-01.json 141 bytes\n")
    t.finish(22.5, main, "config-01")
    body = ['{', '  "name": "webapp",', '  "version": "1.4.2",', '  "features": ["search", "export"],',
            '  "debug": false', '}']
    t.start(22.8, main, "config-01-read", run_step(
        "config-01-read", "--offline", "--purpose", "Show the saved config with line numbers", "--",
        "nl", "-ba", f"{EVIDENCE}/config-01.json"))
    t.out(23.0, main, "config-01-read", "".join(f"{i:6}\t{line}\n" for i, line in enumerate(body, 1)))
    t.finish(23.1, main, "config-01-read")
    t.start(23.4, main, "report-config-01", [
        "python3", "tools/report-step", ENGAGEMENT, "config-01", "--purpose", "Record the app version",
        "--excerpt", "evidence/config-01.json@1:6", "--excerpt", "action=config-01-read@1:6",
        "--observed", "The config endpoint reports version 1.4.2 with debug off.",
        "--decision", "Compare with the version in package.json next."])
    t.out(23.7, main, "report-config-01", "Recorded step config-01 in report.md\n")
    t.finish(23.8, main, "report-config-01")

    # Terminal #11: a launch failure.
    t.add(24, main, "missing-tool", "start", argv=["cargo", "build"], cwd=CWD,
          tty=False, pipe_stdin=False)
    t.add(24.05, main, "missing-tool", "start_failed", status="error")

    # Terminal #12: a large output delivered in many chunks.
    t.start(27, main, "list-files", ["find", "assets", "-type", "f"])
    for block in range(15):
        first = block * 200 + 1
        text = "".join(f"assets/icons/icon-{n:04d}.svg\n" for n in range(first, first + 200))
        t.out(27.2 + block * 0.25, main, "list-files", text)
    t.finish(31.2, main, "list-files")

    t.add(34, main, "dev-server", "stdin", chunk_b64=encoded("q\n"), status="requested")
    t.add(34.05, main, "dev-server", "stdin_ack", status="accepted")
    t.out(34.2, main, "dev-server", "\x1b[33mWARN\x1b[0m shutting down\r\n", "pty")
    t.finish(34.4, main, "dev-server")
    t.add(35, main, None, "connection_closed", status="normal")

    # Terminal #13: a second connection that is lost before process closure.
    t.add(36, lost, None, "connection_open", status="connected")
    t.start(37, lost, "interrupted", ["python3", "-u", "scripts/migrate.py"],
            reason="Show how an incomplete capture appears after a connection loss.")
    t.out(37.5, lost, "interrupted", "migrating 1/3\nmigrating 2/3\n")
    t.add(39, lost, "interrupted", "gap", reason="Synthetic recorder connection lost before process closure")
    t.add(39.1, lost, None, "connection_closed", status="unexpected")
    t.add(42, None, None, "recorder_stop")
    return t


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("capture_dir", type=Path)
    parser.add_argument("--delay", type=float, default=0, help="Seconds between demo events")
    args = parser.parse_args()
    if args.delay < 0:
        parser.error("--delay must be non-negative")

    destination = args.capture_dir / "events.jsonl"
    args.capture_dir.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        parser.error(f"Refusing to replace an existing capture: {destination}")

    session = "SYNTHETIC-DEMO"
    base = datetime.now(timezone.utc) - timedelta(minutes=5)
    with destination.open("x", encoding="utf-8", newline="\n") as handle:
        for at, _, connection_id, process_id, kind, details in build().ordered():
            # With --delay, events are written live and stamped with the real time.
            stamp = datetime.now(timezone.utc) if args.delay else base + timedelta(seconds=at)
            event = {
                "ts": stamp.isoformat(),
                "type": kind,
                "connection_id": connection_id,
                "session_id": session,
                "process_id": process_id,
                **details,
            }
            handle.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
            handle.flush()
            if args.delay:
                time.sleep(args.delay)
    print(destination)


if __name__ == "__main__":
    main()
