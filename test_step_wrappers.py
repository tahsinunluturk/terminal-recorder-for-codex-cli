"""Install the example step wrappers into a temporary project and run them."""

from __future__ import annotations

import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest


HERE = pathlib.Path(__file__).resolve().parent
EXAMPLES = HERE / "examples" / "step-wrappers"
BASH = shutil.which("bash")


@unittest.skipUnless(os.name == "posix" and BASH, "requires a POSIX Bash host")
class StepWrapperTests(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory(prefix="step-wrappers-")
        self.addCleanup(temp.cleanup)
        self.project = pathlib.Path(temp.name) / "My Project"
        self.project.mkdir()
        (self.project / "AGENTS.md").write_text("# Existing rules\n", encoding="utf-8")
        (self.project / "data.json").write_text('{\n  "status": "ok"\n}\n', encoding="utf-8")

    def run_in_project(self, *argv: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(list(argv), cwd=self.project, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=False)

    def install(self) -> subprocess.CompletedProcess[str]:
        return subprocess.run([BASH, str(EXAMPLES / "install.sh"), str(self.project)], text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=False)

    def test_install_is_idempotent_and_keeps_existing_files(self) -> None:
        first = self.install()
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertIn('engagement "my-project"', first.stdout)
        agents = (self.project / "AGENTS.md").read_text(encoding="utf-8")
        self.assertTrue(agents.startswith("# Existing rules\n"))
        self.assertIn("bash tools/run-step my-project", agents)
        self.assertNotIn("ENGAGEMENT_NAME", agents)
        self.assertTrue((self.project / "engagements" / "my-project" / "evidence").is_dir())
        for name in ("run-step", "run-service", "report-step"):
            self.assertTrue(os.access(self.project / "tools" / name, os.X_OK), name)
        second = self.install()
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertNotIn("added", second.stdout)
        self.assertEqual((self.project / "AGENTS.md").read_text(encoding="utf-8"), agents)

    def test_steps_save_evidence_and_report(self) -> None:
        self.assertEqual(self.install().returncode, 0)
        evidence = "engagements/my-project/evidence/data-01.json"
        saved = self.run_in_project(BASH, "tools/run-step", "my-project", "data-01",
                                    "--purpose", "Save the data file", "--artifact", evidence,
                                    "--", "cp", "data.json", evidence)
        self.assertEqual(saved.returncode, 0, saved.stderr)
        self.assertIn(f"[run-step] artifact {evidence} 21 bytes", saved.stdout)
        read = self.run_in_project(BASH, "tools/run-step", "my-project", "data-01-read", "--offline",
                                   "--purpose", "Show the data", "--", "nl", "-ba", evidence)
        self.assertIn('"status": "ok"', read.stdout)
        report = self.run_in_project(sys.executable, "tools/report-step", "my-project", "data-01",
                                     "--purpose", "Check the status", "--observed", "Status is ok.",
                                     "--excerpt", "evidence/data-01.json@2:2",
                                     "--excerpt", "action=data-01-read@1:3", "--decision", "Stop here.")
        self.assertEqual(report.returncode, 0, report.stderr)
        text = (self.project / "engagements" / "my-project" / "report.md").read_text(encoding="utf-8")
        self.assertIn('  "status": "ok"', text)
        self.assertIn("Output of action `data-01-read`, lines 1-3", text)
        self.assertIn("**Next step (proposed, not run):** Stop here.", text)
        activity = (self.project / "engagements" / "my-project" / "activity.md").read_text(encoding="utf-8")
        self.assertIn("`data-01` exit 0: Save the data file", activity)
        self.assertIn("`data-01-read` exit 0 (offline): Show the data", activity)

    def test_errors_are_reported(self) -> None:
        self.assertEqual(self.install().returncode, 0)
        failed = self.run_in_project(BASH, "tools/run-step", "my-project", "fails", "--purpose", "Fail", "--", "false")
        self.assertEqual(failed.returncode, 1, "run-step returns the command's exit status")
        missing = self.run_in_project(BASH, "tools/run-step", "my-project", "no-purpose", "--", "true")
        self.assertEqual(missing.returncode, 64)
        self.assertIn("--purpose is required", missing.stderr)
        outside = self.run_in_project(sys.executable, "tools/report-step", "my-project", "x", "--purpose", "p",
                                      "--observed", "o", "--excerpt", "data.json@1:1")
        self.assertNotEqual(outside.returncode, 0)
        self.assertIn("excerpts must come from", outside.stderr)


if __name__ == "__main__":
    unittest.main()
