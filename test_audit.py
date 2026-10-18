#!/usr/bin/env python3
"""Synthetic tests of the independent terminal journal audit."""

import base64
import hashlib
import importlib.util
import json
import pathlib
import tempfile
import unittest


HERE = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("terminal_web_audit", HERE / "audit.py")
assert SPEC and SPEC.loader
audit = importlib.util.module_from_spec(SPEC)
import sys
sys.modules[SPEC.name] = audit
SPEC.loader.exec_module(audit)


def item(kind, process_id=None, connection_id="c1", **fields):
    return {"type": kind, "connection_id": connection_id,
            "process_id": process_id, "session_id": "synthetic", **fields}


def output(pid, seq, raw, stream="pty", connection_id="c1"):
    return item("output", pid, connection_id, seq=seq, stream=stream,
                chunk_b64=base64.b64encode(raw).decode("ascii"))


class AuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = pathlib.Path(self.temp.name) / "events.jsonl"

    def write(self, *events):
        with self.path.open("ab") as journal:
            for event in events:
                journal.write(json.dumps(event, separators=(",", ":")).encode() + b"\n")

    def test_parallel_closed_processes_persist_and_hash_raw_bytes(self):
        self.write(item("recorder_start"),
                   item("connection_open"),
                   item("start", "listener"),
                   item("start", "payload"),
                   item("start_accepted", "listener"),
                   item("start_accepted", "payload"),
                   output("listener", 1, b"listen\x00\xff"),
                   output("payload", 1, b"request\n", "stdout"),
                   item("stdin", "listener", chunk_b64=base64.b64encode(b"go\n").decode()),
                   item("stdin_ack", "listener", status="accepted"),
                   output("listener", 2, b"connection\n"),
                   item("exited", "payload", seq=2, exit_code=0),
                   item("closed", "payload", seq=3),
                   item("exited", "listener", seq=3, exit_code=0),
                   item("closed", "listener", seq=4))
        first = audit.audit_capture(self.path)
        self.assertEqual(first["overall"], "PARTIAL")  # capture scope stays partial
        self.assertEqual({p["lifecycle"] for p in first["processes"]}, {"Closed"})
        self.assertEqual({p["integrity"] for p in first["processes"]}, {"OK"})
        listener = next(p for p in first["processes"] if p["process_id"] == "listener")
        self.assertEqual(listener["streams"]["pty"]["bytes"], len(b"listen\x00\xffconnection\n"))
        self.assertEqual(listener["streams"]["pty"]["sha256"],
                         hashlib.sha256(b"listen\x00\xffconnection\n").hexdigest())
        self.assertEqual(listener["streams"]["stdin"]["bytes"], 3)
        self.assertIn("stdin_requested", audit.format_report(first))
        # A closed process remains in the journal after recorder shutdown/re-read.
        self.write(item("connection_closed"), item("recorder_stop"))
        second = audit.audit_capture(self.path)
        self.assertEqual([p["lifecycle"] for p in second["processes"]],
                         [p["lifecycle"] for p in first["processes"]])
        self.assertEqual(second["processes"][0]["streams"], first["processes"][0]["streams"])

    def test_missing_sequence_is_incomplete_even_when_closed(self):
        self.write(item("recorder_start"), item("start", "p"),
                   item("start_accepted", "p"), output("p", 2, b"lost first"),
                   item("exited", "p", seq=3), item("closed", "p", seq=4),
                   item("recorder_stop"))
        report = audit.audit_capture(self.path)
        self.assertEqual(report["overall"], "INCOMPLETE")
        self.assertEqual(report["processes"][0]["lifecycle"], "Closed")
        self.assertIn("expected 1", " ".join(report["processes"][0]["issues"]))

    def test_terminate_request_after_close_is_normal_codex_cleanup(self):
        self.write(item("recorder_start"), item("start", "p"),
                   item("start_accepted", "p"), output("p", 1, b"/tmp\n", "stdout"),
                   item("exited", "p", seq=2, exit_code=0),
                   item("closed", "p", seq=3),
                   item("terminate_requested", "p"),
                   item("connection_closed"), item("recorder_stop"))
        report = audit.audit_capture(self.path)
        self.assertEqual(report["overall"], "PARTIAL")
        self.assertEqual(report["processes"][0]["integrity"], "OK")

    def test_truncated_jsonl_is_incomplete(self):
        self.write(item("recorder_start"))
        with self.path.open("ab") as journal:
            journal.write(b'{"type":"output","connection_id":"c1"')
        report = audit.audit_capture(self.path)
        self.assertEqual(report["overall"], "INCOMPLETE")
        self.assertIn("truncated", " ".join(report["issues"]))

    def test_malformed_complete_jsonl_line_is_incomplete(self):
        self.write(item("recorder_start"))
        with self.path.open("ab") as journal:
            journal.write(b"{bad-json}\n")
        report = audit.audit_capture(self.path)
        self.assertEqual(report["overall"], "INCOMPLETE")
        self.assertIn("malformed", " ".join(report["issues"]))

    def test_connection_interruption_never_marks_process_closed(self):
        self.write(item("recorder_start"), item("start", "listener"),
                   item("start_accepted", "listener"), output("listener", 1, b"waiting"),
                   item("connection_closed", status="client_closed"),
                   item("recorder_stop"))
        report = audit.audit_capture(self.path)
        self.assertEqual(report["overall"], "INCOMPLETE")
        self.assertEqual(report["processes"][0]["lifecycle"], "Unknown")
        self.assertNotIn("Closed", audit.format_report(report))

    def test_live_unclosed_process_is_partial(self):
        self.write(item("recorder_start"), item("start", "listener"),
                   item("start_accepted", "listener"), output("listener", 1, b"waiting"))
        report = audit.audit_capture(self.path)
        self.assertEqual(report["overall"], "PARTIAL")
        self.assertEqual(report["processes"][0]["integrity"], "PARTIAL")
        self.assertEqual(report["processes"][0]["lifecycle"], "Unknown")

    def test_invalid_base64_and_stream_are_incomplete(self):
        self.write(item("recorder_start"), item("start", "p"),
                   item("start_accepted", "p"),
                   item("output", "p", seq=1, stream="stdout", chunk_b64="!!!"),
                   output("p", 2, b"x", "secret"),
                   item("exited", "p", seq=3), item("closed", "p", seq=4))
        report = audit.audit_capture(self.path)
        self.assertEqual(report["overall"], "INCOMPLETE")
        self.assertIn("invalid stdout base64", " ".join(report["processes"][0]["issues"]))
        self.assertIn("invalid output stream", " ".join(report["processes"][0]["issues"]))

    def test_failed_start_is_not_a_closed_terminal(self):
        self.write(item("recorder_start"), item("start", "p"),
                   item("start_failed", "p", status="error"), item("recorder_stop"))
        report = audit.audit_capture(self.path)
        self.assertEqual(report["processes"][0]["lifecycle"], "Launch failed")
        self.assertEqual(report["processes"][0]["integrity"], "OK")
        self.assertNotIn("Closed", audit.format_report(report))


if __name__ == "__main__":
    unittest.main()
