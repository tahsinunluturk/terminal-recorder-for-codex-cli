#!/usr/bin/env python3
"""Read-only integrity audit for an exec-server recorder's events.jsonl.

This checks only processes that appeared in this journal. Even a clean audit
cannot establish that every Codex CLI execution route passed through the proxy.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import pathlib
import stat
import sys
from dataclasses import dataclass, field
from typing import Any


STREAMS = ("stdin", "stdout", "stderr", "pty")
OUTPUT_STREAMS = STREAMS[1:]
PROCESS_EVENTS = {
    "start", "start_accepted", "start_failed", "stdin", "stdin_ack",
    "output", "exited", "closed", "gap", "terminate_requested", "read_failed",
}
CONNECTION_EVENTS = {"connection_open", "connection_closed", "session_ready"}
RECORDER_EVENTS = {"recorder_start", "recorder_stop", "recorder_heartbeat"}


@dataclass
class StreamDigest:
    length: int = 0
    chunks: int = 0
    digest: Any = field(default_factory=hashlib.sha256)

    def add(self, chunk: bytes) -> None:
        self.length += len(chunk)
        self.chunks += 1
        self.digest.update(chunk)

    def summary(self) -> dict[str, Any]:
        return {"bytes": self.length, "chunks": self.chunks,
                "sha256": self.digest.hexdigest()}


@dataclass
class Process:
    connection_id: str
    process_id: str
    start: bool = False
    accepted: bool = False
    start_failed: bool = False
    exited: bool = False
    closed: bool = False
    connection_closed: bool = False
    next_seq: int = 1
    stdin_count: int = 0
    stdin_ack_count: int = 0
    event_count: int = 0
    issues: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    streams: dict[str, StreamDigest] = field(
        default_factory=lambda: {name: StreamDigest() for name in STREAMS})

    def sequence(self, event: dict[str, Any], line_number: int) -> None:
        sequence = event.get("seq")
        if type(sequence) is not int or sequence < 1:
            self.issues.append(f"line {line_number}: invalid sequence {sequence!r}")
            return
        if sequence != self.next_seq:
            self.issues.append(
                f"line {line_number}: sequence {sequence}, expected {self.next_seq}")
        self.next_seq = max(self.next_seq, sequence + 1)

    def add_chunk(self, event: dict[str, Any], stream: str,
                  line_number: int) -> None:
        encoded = event.get("chunk_b64")
        if not isinstance(encoded, str):
            self.issues.append(f"line {line_number}: {stream} chunk is not base64 text")
            return
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error):
            self.issues.append(f"line {line_number}: invalid {stream} base64 chunk")
            return
        self.streams[stream].add(raw)

    def observe(self, event: dict[str, Any], line_number: int) -> None:
        kind = event["type"]
        self.event_count += 1
        if kind != "start" and not self.start:
            self.issues.append(f"line {line_number}: {kind} without process/start")
        # Codex may send process/terminate while cleaning up an already closed
        # process. It carries no output and does not reopen the lifecycle.
        if self.closed and kind not in ("gap", "terminate_requested"):
            self.issues.append(f"line {line_number}: {kind} after process/closed")
        if kind == "start":
            if self.start:
                self.issues.append(f"line {line_number}: duplicate process/start")
            self.start = True
        elif kind == "start_accepted":
            if self.accepted or self.start_failed:
                self.issues.append(f"line {line_number}: contradictory start result")
            self.accepted = True
        elif kind == "start_failed":
            if self.accepted or self.start_failed:
                self.issues.append(f"line {line_number}: contradictory start result")
            self.start_failed = True
        elif kind == "stdin":
            self.stdin_count += 1
            self.add_chunk(event, "stdin", line_number)
        elif kind == "stdin_ack":
            self.stdin_ack_count += 1
            if self.stdin_ack_count > self.stdin_count:
                self.issues.append(f"line {line_number}: stdin acknowledgement without request")
            if event.get("status") != "accepted":
                self.notes.append(f"line {line_number}: stdin write not accepted")
        elif kind == "output":
            self.sequence(event, line_number)
            stream = event.get("stream")
            if stream not in OUTPUT_STREAMS:
                self.issues.append(f"line {line_number}: invalid output stream {stream!r}")
            else:
                self.add_chunk(event, stream, line_number)
        elif kind == "exited":
            self.sequence(event, line_number)
            if self.exited:
                self.issues.append(f"line {line_number}: duplicate process/exited")
            self.exited = True
        elif kind == "closed":
            # A process/read response may report closure without a numbered
            # notification. The proxy records an explicit gap for that case.
            if event.get("seq") is None and event.get("source") == "process/read":
                self.issues.append(f"line {line_number}: unnumbered process/read closure")
            else:
                self.sequence(event, line_number)
            self.closed = True
        elif kind == "gap":
            self.issues.append(f"line {line_number}: recorder gap: {event.get('reason', 'unknown')}")
        elif kind == "read_failed":
            self.notes.append(f"line {line_number}: process/read failed")

    def summary(self) -> dict[str, Any]:
        notes = self.notes.copy()
        issues = self.issues.copy()
        if not self.start:
            issues.append("process/start missing")
        if self.start and not (self.accepted or self.start_failed):
            notes.append("start result not recorded")
        if self.start_failed:
            if self.exited or self.closed:
                issues.append("failed start has exit/closure events")
            lifecycle = "Launch failed"
        elif self.closed:
            lifecycle = "Closed"
            if not self.exited:
                notes.append("process/exited missing")
        else:
            lifecycle = "Unknown"
            notes.append("process/closed not recorded")
        if self.stdin_ack_count < self.stdin_count:
            notes.append(f"{self.stdin_count - self.stdin_ack_count} stdin acknowledgement(s) missing")
        if self.connection_closed and not self.closed and not self.start_failed:
            issues.append("connection closed before process/closed")
        integrity = "INCOMPLETE" if issues else "PARTIAL" if notes else "OK"
        return {
            "connection_id": self.connection_id,
            "process_id": self.process_id,
            "lifecycle": lifecycle,
            "integrity": integrity,
            "events": self.event_count,
            "streams": {name: digest.summary() for name, digest in self.streams.items()},
            "notes": notes,
            "issues": issues,
        }


def audit_capture(source: str | pathlib.Path) -> dict[str, Any]:
    """Audit a capture directory or an explicit events.jsonl path."""
    path = pathlib.Path(source)
    if path.is_symlink():
        raise ValueError("refusing symlink capture path")
    if path.is_dir():
        path = path / "events.jsonl"
    if path.is_symlink():
        raise ValueError("refusing symlink capture file")
    if not stat.S_ISREG(path.stat().st_mode):
        raise ValueError("capture must be a regular file")
    processes: dict[tuple[str, str], Process] = {}
    connection_closed: set[str] = set()
    connection_gaps: dict[str, list[str]] = {}
    global_issues: list[str] = []
    global_notes: list[str] = []
    recorder_starts = 0
    recorder_stops = 0
    line_count = 0
    with path.open("rb") as capture:
        for line_count, line in enumerate(capture, 1):
            if not line.endswith(b"\n"):
                global_issues.append(f"line {line_count}: truncated final JSONL record")
                continue
            try:
                event = json.loads(line)
            except (UnicodeDecodeError, json.JSONDecodeError):
                global_issues.append(f"line {line_count}: malformed JSONL record")
                continue
            if not isinstance(event, dict) or not isinstance(event.get("type"), str):
                global_issues.append(f"line {line_count}: invalid event object")
                continue
            kind = event["type"]
            if kind not in PROCESS_EVENTS | CONNECTION_EVENTS | RECORDER_EVENTS:
                global_issues.append(f"line {line_count}: unknown event type {kind!r}")
                continue
            if kind == "recorder_start":
                recorder_starts += 1
                continue
            if kind == "recorder_stop":
                recorder_stops += 1
                continue
            if kind == "recorder_heartbeat":
                continue
            connection_id = event.get("connection_id")
            if kind == "gap" and not isinstance(connection_id, str):
                global_issues.append(
                    f"line {line_count}: global recorder gap: {event.get('reason', 'unknown')}")
                continue
            if not isinstance(connection_id, str) or not connection_id:
                global_issues.append(f"line {line_count}: {kind} without connection ID")
                continue
            if kind == "connection_closed":
                connection_closed.add(connection_id)
                for (cid, _), process in processes.items():
                    if cid == connection_id:
                        process.connection_closed = True
                continue
            if kind == "gap" and not event.get("process_id"):
                connection_gaps.setdefault(connection_id, []).append(
                    f"line {line_count}: connection recorder gap: {event.get('reason', 'unknown')}")
                continue
            if kind in CONNECTION_EVENTS:
                continue
            process_id = event.get("process_id")
            if not isinstance(process_id, str) or not process_id:
                global_issues.append(f"line {line_count}: {kind} without process ID")
                continue
            key = (connection_id, process_id)
            process = processes.setdefault(key, Process(*key))
            if connection_id in connection_closed:
                process.connection_closed = True
                process.issues.append(f"line {line_count}: event after connection closed")
            process.observe(event, line_count)
    if recorder_starts == 0:
        global_notes.append("recorder_start not recorded")
    if recorder_stops == 0:
        global_notes.append("recorder_stop not recorded; capture may still be live")
    if recorder_stops > recorder_starts:
        global_issues.append("more recorder stops than starts")
    if not processes:
        global_notes.append("no processes recorded")
    summaries = []
    for (connection_id, _), process in processes.items():
        process.issues.extend(connection_gaps.get(connection_id, []))
        summaries.append(process.summary())
    for connection_id, gaps in connection_gaps.items():
        if not any(key[0] == connection_id for key in processes):
            global_issues.extend(gaps)
    overall = "INCOMPLETE" if global_issues or any(
        p["integrity"] == "INCOMPLETE" for p in summaries) else "PARTIAL"
    return {
        "overall": overall,
        "coverage": "PARTIAL: only processes routed through this recorder are auditable",
        "records": line_count,
        "recorder_starts": recorder_starts,
        "recorder_stops": recorder_stops,
        "processes": summaries,
        "notes": global_notes,
        "issues": global_issues,
    }


def format_report(report: dict[str, Any]) -> str:
    lines = [f"OVERALL: {report['overall']}", f"COVERAGE: {report['coverage']}",
             f"JSONL records: {report['records']}; processes: {len(report['processes'])}"]
    for issue in report["issues"]:
        lines.append(f"ISSUE: {issue}")
    for note in report["notes"]:
        lines.append(f"NOTE: {note}")
    for process in report["processes"]:
        lines.append(
            f"PROCESS {process['connection_id']}:{process['process_id']} — "
            f"{process['lifecycle']} / {process['integrity']}")
        for stream, digest in process["streams"].items():
            label = "stdin_requested" if stream == "stdin" else stream
            lines.append(f"  {label}: {digest['bytes']} bytes, "
                         f"{digest['chunks']} chunks, sha256 {digest['sha256']}")
        for issue in process["issues"]:
            lines.append(f"  ISSUE: {issue}")
        for note in process["notes"]:
            lines.append(f"  NOTE: {note}")
    return "\n".join(lines)


def main() -> int:
    if sys.platform == "win32" and hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("capture", type=pathlib.Path,
                        help="capture directory or its events.jsonl file")
    parser.add_argument("--json", action="store_true", help="emit machine-readable audit")
    args = parser.parse_args()
    try:
        report = audit_capture(args.capture)
    except (OSError, ValueError) as exc:
        print(f"capture audit error: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(report, ensure_ascii=False, indent=2) if args.json else format_report(report))
    return 1 if report["overall"] == "INCOMPLETE" else 2


if __name__ == "__main__":
    raise SystemExit(main())
