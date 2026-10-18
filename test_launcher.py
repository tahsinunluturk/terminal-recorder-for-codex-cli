"""Launcher checks using a fake Codex CLI, never the real CLI."""

from __future__ import annotations

import json
import os
import pathlib
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import unittest


HERE = pathlib.Path(__file__).resolve().parent
LAUNCHER = HERE / "start-recorded-codex"
BASH = shutil.which("bash")


def write_executable(path: pathlib.Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")
    path.chmod(0o700)


@unittest.skipUnless(os.name == "posix" and BASH, "requires a POSIX Bash host")
class LauncherTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="terminal-web-launcher-")
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.bin_dir = self.root / "bin"
        self.bin_dir.mkdir()
        self.marker = self.root / "cli-url.txt"
        self.env = os.environ.copy()
        self.env.update({
            "PATH": str(self.bin_dir) + os.pathsep + self.env.get("PATH", ""),
            "XDG_STATE_HOME": str(self.root / "state"),
            "FAKE_CLI_URL_FILE": str(self.marker),
            "FAKE_EXEC_SERVER_PROGRAM": str(self.root / "fake_server.py"),
            "PYTHON_BIN": sys.executable,
        })
        write_executable(self.bin_dir / "id", """#!/bin/sh
if [ "${1:-}" = "-u" ]; then printf '%s\\n' "${FAKE_ID_UID:-1000}"; exit 0; fi
printf '%s\\n' "${FAKE_ID_NAME:-tester}"
""")
        write_executable(self.bin_dir / "codex", """#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "--version" ]]; then
    printf 'codex-cli 0.0.0-fake\\n'
    exit 0
fi
if [[ "${1:-}" == "exec-server" && "${2:-}" == "--help" ]]; then
    [[ "${FAKE_EXEC_HELP_FAIL:-0}" == 0 ]] || exit 2
    printf 'Usage: codex exec-server --listen URL\\n'
    exit 0
fi
if [[ "${1:-}" == "exec-server" && "${2:-}" == "--listen" ]]; then
    exec "$PYTHON_BIN" -u "$FAKE_EXEC_SERVER_PROGRAM"
fi
printf '%s\\n' "${CODEX_EXEC_SERVER_URL:-missing}" > "$FAKE_CLI_URL_FILE"
""")
        (self.root / "fake_server.py").write_text("""import socket
import time
s = socket.socket()
s.bind(("127.0.0.1", 0))
s.listen(1)
print(f"ws://127.0.0.1:{s.getsockname()[1]}", flush=True)
while True:
    time.sleep(1)
""", encoding="utf-8")

    def launch(self, extra_env: dict[str, str] | None = None,
               args: tuple[str, ...] = ()) -> subprocess.CompletedProcess[str]:
        env = self.env.copy()
        env.update(extra_env or {})
        return subprocess.run([BASH, str(LAUNCHER), *args], env=env, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              timeout=25, check=False)

    def test_rejects_invalid_viewer_port_before_starting_anything(self) -> None:
        result = self.launch(args=("--viewer-port", "99999"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("viewer port must be at most 65535", result.stderr)
        self.assertFalse(self.marker.exists())
        self.assertFalse((self.root / "state").exists())

    def test_rejects_root_before_starting_anything(self) -> None:
        result = self.launch({"FAKE_ID_NAME": "root", "FAKE_ID_UID": "0"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("refusing to run as root", result.stderr)
        self.assertFalse(self.marker.exists())
        self.assertFalse((self.root / "state").exists())

    def test_rejects_incompatible_exec_server_before_starting_anything(self) -> None:
        result = self.launch({"FAKE_EXEC_HELP_FAIL": "1"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no usable exec-server", result.stderr)
        self.assertFalse(self.marker.exists())
        self.assertFalse((self.root / "state").exists())

    def test_starts_isolated_session_and_retains_capture(self) -> None:
        unrelated = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        self.addCleanup(lambda: (unrelated.terminate(), unrelated.wait(timeout=5))
                        if unrelated.poll() is None else None)
        result = self.launch()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIsNone(unrelated.poll(), "launcher must not stop unrelated processes")
        proxy_url = self.marker.read_text(encoding="utf-8").strip()
        self.assertRegex(proxy_url, r"^ws://127\.0\.0\.1:\d+$")
        captures = list((self.root / "state" / "terminal-recorder-for-codex-cli").glob("session-*"))
        self.assertEqual(len(captures), 1)
        capture = captures[0]
        self.assertEqual(stat.S_IMODE(capture.stat().st_mode), 0o700)
        events = [json.loads(line) for line in (capture / "events.jsonl").read_text().splitlines()]
        self.assertIn("recorder_start", [event["type"] for event in events])
        self.assertIn("Live viewer: http://127.0.0.1:", result.stderr)
        self.assertIn("Capture retained:", result.stderr)
        for log, pattern in (
            ("exec-server.stdout", r"ws://127\.0\.0\.1:(\d+)"),
            ("proxy.stdout", r"ws://127\.0\.0\.1:(\d+)"),
            ("viewer.stdout", r"http://127\.0\.0\.1:(\d+)/"),
        ):
            match = re.search(pattern, (capture / log).read_text(encoding="utf-8"))
            self.assertIsNotNone(match, log)
            with socket.socket() as probe:
                probe.settimeout(0.3)
                self.assertNotEqual(probe.connect_ex(("127.0.0.1", int(match.group(1)))), 0,
                                    f"{log} listener remained active after launcher exit")

    def test_capture_directory_override(self) -> None:
        custom = self.root / "custom-captures"
        result = self.launch({"CODEX_TERMINAL_RECORDER_DIR": str(custom)})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(list(custom.glob("session-*"))), 1)
        self.assertFalse((self.root / "state").exists())

    def test_check_reports_ready_without_starting_anything(self) -> None:
        result = self.launch(args=("--check",))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("codex-cli 0.0.0-fake", result.stdout)
        self.assertIn("supports --listen", result.stdout)
        self.assertIn("Ready.", result.stdout)
        self.assertFalse(self.marker.exists())
        self.assertFalse((self.root / "state").exists())

    def test_check_reports_each_problem(self) -> None:
        result = self.launch({"FAKE_ID_UID": "0", "FAKE_EXEC_HELP_FAIL": "1"}, args=("--check",))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("FAIL   running as root", result.stdout)
        self.assertIn("FAIL   codex exec-server --listen is unavailable", result.stdout)
        self.assertIn("2 problem(s) found", result.stdout)
        self.assertFalse((self.root / "state").exists())


if __name__ == "__main__":
    unittest.main()
