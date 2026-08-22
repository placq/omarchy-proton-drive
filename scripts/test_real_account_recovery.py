import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest

from real_account_recovery import atomic_json, load_evidence, redaction_findings, write_payload


class RecoveryGateHelpersTest(unittest.TestCase):
    def evidence(self):
        return {
            "schema": 1,
            "runName": "recovery-123",
            "files": {"offline": {"name": "offline-reboot.bin"}},
        }

    def test_evidence_is_private_atomic_and_validated(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "private/evidence.json"
            atomic_json(path, self.evidence())
            self.assertEqual(load_evidence(path)["runName"], "recovery-123")
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            path.write_text(json.dumps({"schema": 1, "runName": "outside-scope"}), encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "Invalid recovery evidence"):
                load_evidence(path)

    def test_payload_is_deterministic_exact_and_streamed(self):
        with tempfile.TemporaryDirectory() as directory:
            first = Path(directory) / "first.bin"
            second = Path(directory) / "second.bin"
            first_digest = write_payload(first, "same-label", 1_000_003)
            second_digest = write_payload(second, "same-label", 1_000_003)
            self.assertEqual(first.stat().st_size, 1_000_003)
            self.assertEqual(first_digest, second_digest)
            self.assertEqual(first_digest, hashlib.sha256(first.read_bytes()).hexdigest())

    def test_log_scan_reports_categories_without_echoing_secrets(self):
        evidence = self.evidence()
        findings = redaction_findings(
            "Authorization: Bearer hidden\nopened offline-reboot.bin\nuser@example.test",
            evidence,
            ["user@example.test"],
        )
        self.assertIn("authorization header", findings)
        self.assertIn("bearer credential", findings)
        self.assertIn("test filename offline-reboot.bin", findings)
        self.assertIn("operator forbidden value 1", findings)
        self.assertNotIn("hidden", " ".join(findings))


if __name__ == "__main__":
    unittest.main()
