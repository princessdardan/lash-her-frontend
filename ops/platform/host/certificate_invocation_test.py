import copy
import json
import unittest
from unittest.mock import patch

import certificate_invocation as invocation

BOOT = "b" * 32
ID = "a" * 32


def fixture(identity=ID, start=100):
    manager = {"_BOOT_ID": BOOT, "UNIT": invocation.UNIT, "_SYSTEMD_UNIT": "init.scope", "INVOCATION_ID": identity}
    return [
        {**manager, "MESSAGE_ID": invocation.STARTED, "JOB_TYPE": "start", "__MONOTONIC_TIMESTAMP": str(start)},
        {"_BOOT_ID": BOOT, "_SYSTEMD_UNIT": invocation.UNIT, "_SYSTEMD_INVOCATION_ID": identity,
         "__MONOTONIC_TIMESTAMP": str(start + 1), "MESSAGE": json.dumps({"status": "TLS_CERTIFICATES_CURRENT", "renewed": [], "servicesStopped": False})},
        {**manager, "MESSAGE_ID": invocation.FINISHED, "JOB_TYPE": "start", "JOB_RESULT": "done", "__MONOTONIC_TIMESTAMP": str(start + 2)},
    ]


class CertificateInvocationTests(unittest.TestCase):
    def test_completed_unloaded_oneshot_needs_no_live_invocation_property(self):
        calls = []
        def command(args):
            calls.append(args)
            return "Result=success\nExecMainStatus=0\nActiveState=inactive" if args[0] == "systemctl" else "\n".join(map(json.dumps, fixture()))
        with patch.object(invocation, "current_boot_id", return_value=BOOT):
            result = invocation.read(command, expected_id=ID)
        self.assertEqual(result["invocationId"], ID)
        self.assertEqual(result["status"], "TLS_CERTIFICATES_CURRENT")
        self.assertNotIn("MESSAGE", json.dumps(result))
        self.assertEqual(len(calls), 2)
        self.assertTrue(all("start" not in args for args in calls))

    def test_wrong_boot_unit_invocation_or_missing_manager_refuses(self):
        for mutate in [lambda r: r[1].update(_BOOT_ID="c" * 32), lambda r: r[1].update(_SYSTEMD_UNIT="other.service"),
                       lambda r: r[1].update(_SYSTEMD_INVOCATION_ID="c" * 32), lambda r: r.pop(0), lambda r: r.pop(2)]:
            records = fixture(); mutate(records)
            with self.assertRaises(ValueError):
                invocation.validate(records, BOOT, ID)

    def test_failed_or_incomplete_latest_job_cannot_reuse_older_success(self):
        records = fixture(); records[2]["JOB_RESULT"] = "failed"
        with self.assertRaises(ValueError):
            invocation.validate(records, BOOT, ID)
        records = fixture() + fixture("c" * 32, 200)[:1]
        with self.assertRaisesRegex(ValueError, "LATEST_INVOCATION"):
            invocation.validate(records, BOOT, ID)
        with self.assertRaisesRegex(ValueError, "ACTUAL_CERTIFICATE_UNIT"):
            invocation.validate(records, BOOT)

    def test_application_result_must_be_between_start_and_completion(self):
        for timestamp in ["99", "103", "missing"]:
            records = fixture(); records[1]["__MONOTONIC_TIMESTAMP"] = timestamp
            with self.assertRaises(ValueError):
                invocation.validate(records, BOOT)
        with self.assertRaisesRegex(ValueError, "ACTUAL_CERTIFICATE_UNIT"):
            invocation.validate(fixture(), BOOT, minimum_started_usec=101)

    def test_busy_renewed_stopped_duplicate_or_invalid_result_refuses(self):
        for result in [{"status": "TLS_RENEWAL_SKIPPED_RELEASE_BUSY", "renewed": [], "servicesStopped": False},
                       {"status": "TLS_CERTIFICATES_CURRENT", "renewed": ["gateway"], "servicesStopped": False},
                       {"status": "TLS_CERTIFICATES_CURRENT", "renewed": [], "servicesStopped": True}, None]:
            records = fixture(); records[1]["MESSAGE"] = json.dumps(result)
            with self.assertRaisesRegex(ValueError, "CURRENT_CERTIFICATE_NOOP"):
                invocation.validate(records, BOOT)
        records = fixture(); records.append(copy.deepcopy(records[1]))
        with self.assertRaises(ValueError):
            invocation.validate(records, BOOT)

    def test_failed_running_or_oversized_state_refuses(self):
        for state in ["Result=failed\nExecMainStatus=1\nActiveState=inactive", "Result=success\nExecMainStatus=0\nActiveState=active"]:
            with self.assertRaisesRegex(ValueError, "ACTUAL_CERTIFICATE_UNIT"):
                invocation.read(lambda _args: state)
        with self.assertRaises(ValueError):
            invocation.validate(fixture() * 100, BOOT)
        with self.assertRaises(ValueError):
            invocation.validate(fixture(), None)
