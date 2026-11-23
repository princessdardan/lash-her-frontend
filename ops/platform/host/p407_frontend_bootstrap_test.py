import copy
import json
import unittest
from pathlib import Path
from unittest.mock import patch

import p407_frontend_bootstrap as bootstrap


class BootstrapTest(unittest.TestCase):
    def plans(self):
        release = {"releaseId": "p4-07-test", "environment": "staging"}
        before = {"image": "bootstrap", "schema": b"schema",
                  "job": {"sourceCommit": "1" * 40, "migrationImageDigest": "sha256:" + "2" * 64,
                          "recoveryRef": "p4-07/lightsail/empty-schema/" + "a" * 64,
                          "target": bootstrap.TARGET | {"allowEmptyBootstrap": True, "approvedPendingTags": ["0000_test"]}}}
        after = copy.deepcopy(before)
        after["image"] = "current"
        after["job"].update(sourceCommit="3" * 40, migrationImageDigest="sha256:" + "4" * 64)
        after["job"]["target"].update(allowEmptyBootstrap=False, approvedPendingTags=[])
        return [(copy.deepcopy(release), {"frontend": before}), (copy.deepcopy(release), {"frontend": after})]

    def test_bundles_must_bind_the_same_release_image_and_target(self):
        cases = [
            lambda _: None,
            lambda plans: plans[1][0].update(releaseId="p4-07-other"),
            lambda plans: plans[1][1]["frontend"].update(image="bootstrap"),
            lambda plans: plans[1][1]["frontend"]["job"].update(sourceCommit="1" * 40),
            lambda plans: plans[1][1]["frontend"]["job"].update(schemaBaselineSha256="drift"),
            lambda plans: plans[1][1]["frontend"]["job"]["target"].update(approvedPendingTags=["0000_test"]),
            lambda plans: plans[0][1]["frontend"]["job"]["target"].update(database="lash_her_p407_course"),
            lambda plans: plans[0][1]["frontend"]["job"].update(recoveryRef="staging/shared"),
        ]
        for index, change in enumerate(cases):
            plans = self.plans()
            change(plans)
            with self.subTest(index=index), patch.object(bootstrap.migrate, "make_plan", side_effect=plans):
                if index:
                    with self.assertRaisesRegex(ValueError, bootstrap.REFUSED):
                        bootstrap.checked_inputs(Path("/bootstrap"), Path("/verify"), "a" * 64)
                else:
                    bootstrap.checked_inputs(Path("/bootstrap"), Path("/verify"), "a" * 64)

    def test_verify_current_receipt_cannot_admit_or_omit_the_terminal(self):
        _, jobs = self.plans()[1]
        job = jobs["frontend"]["job"] | {
            "releaseId": "p4-07-test", "environment": "staging", "sourceCommit": "1" * 40,
            "migrationImageDigest": "sha256:" + "2" * 64, "sqlArtifactSha256": "3" * 64,
            "schemaBaselineSha256": "4" * 64, "contractManifestSha256": "sha256:" + "5" * 64,
        }
        record = {key: value for key, value in job.items() if key != "target"}
        record.update(qualificationTargetProfile=dict(bootstrap.PROFILE),
                      target={key: bootstrap.TARGET[key] for key in ("host", "port", "database", "user", "serverMajor")},
                      status="DATABASE_VERIFIED", service="frontend", trafficAuthorized=False,
                      readOnlyVerified=True, migrationMode="verify-current-only")
        receipt = record | {"schemaVerified": True, "runtimeRoleVerified": True,
                            "before": [{"hash": "6" * 64}], "after": [{"hash": "6" * 64}], "applied": []}
        for terminal in (record, record | {"trafficAuthorized": True}, record | {"sourceCommit": "7" * 40}):
            with self.subTest(terminal=terminal), patch.object(bootstrap.migrate, "read_json", side_effect=[receipt, terminal]):
                if terminal == record:
                    self.assertEqual(bootstrap.verify_receipts(Path("/receipt"), job, True), receipt)
                else:
                    with self.assertRaisesRegex(ValueError, bootstrap.REFUSED):
                        bootstrap.verify_receipts(Path("/receipt"), job, True)

    def test_host_denies_an_attached_relay_and_non_loopback_postgres(self):
        postgres = {"State": {"Running": True}, "Config": {"Labels": {"lash.candidate": "p4-07"}},
                    "Mounts": [{"Source": str(bootstrap.HOST_ROOT / "pg_hba.conf"),
                                "Destination": "/p407-pg_hba.conf", "RW": False}]}
        bridge = {"Labels": {"lash.candidate": "p4-07"}, "IPAM": {"Config": [{"Subnet": "172.29.40.0/24"}]},
                  "Containers": {"db": {"Name": bootstrap.CONTAINER, "IPv4Address": "172.29.40.2/24"}}}
        active_bridge = copy.deepcopy(bridge)
        active_bridge["Containers"]["relay"] = {"Name": "relay", "IPv4Address": "172.29.40.10/24"}
        cases = [
            (b"127.0.0.1:5432", b"", bridge),
            (b"0.0.0.0:5432", b"", bridge),
            (b"127.0.0.1:5432", b"*:443", bridge),
            (b"127.0.0.1:5432", b"", active_bridge),
        ]
        for index, (port, listener, network) in enumerate(cases):
            responses = [port, listener, json.dumps([postgres]).encode(), json.dumps([network]).encode()]
            with self.subTest(index=index), patch.object(bootstrap.os, "getuid", return_value=0), \
                 patch.object(Path, "resolve", return_value=bootstrap.HOST_ROOT), \
                 patch.object(bootstrap.migrate, "private_directory"), patch.object(bootstrap.migrate, "read_input"), \
                 patch.object(bootstrap.migrate, "file_hash", return_value=bootstrap.HBA_SHA256), \
                 patch.object(bootstrap, "command", side_effect=responses):
                if index:
                    with self.assertRaisesRegex(ValueError, bootstrap.REFUSED):
                        bootstrap.verify_host()
                else:
                    bootstrap.verify_host()


if __name__ == "__main__":
    unittest.main()
