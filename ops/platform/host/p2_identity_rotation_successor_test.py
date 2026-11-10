#!/usr/bin/env python3
"""Owned file/command fixtures for the S06 mixed-mount guardian."""
import base64
from contextlib import ExitStack
import copy
import json
from pathlib import Path
import shutil
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import migrate
import p2_certification_parent as certification
import p2_frontend_replacement_parent as replacement
import p2_identity_rotation_successor as successor
from p2_identity_key_rotation_parent import JOINED_RECEIPT, SESSION_CLOSED_RECEIPT, P2IdentityRotationBroker
import p2_release_supervisor as supervisor
from qualification_target_profile import resolve_qualification_target_profile


class SuccessorTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        root = patch.object(successor.prior, "ROOT", self.root)
        root.start()
        self.addCleanup(root.stop)
        self.results, self.source = self.root / "results", self.root / "source"
        self.action = "p2-key-rotation-owned"
        self.directory = self.results / ("p2-identity-key-rotation-" + self.action)
        self.selected_release = "owned-managed-release"
        self.original = self.results / ("runtime-profiled-frontend-replacement-" + self.selected_release) / "configuration"
        self.rotation = self.root / "reviewed-rotation"
        self.current = self.directory / "runtime-current-only"
        self.custody_directory = self.results / ("p2-profiled-replacement-write-" + self.selected_release)
        for directory in (self.directory, self.original, self.rotation, self.custody_directory, self.original / "admission"):
            directory.mkdir(mode=0o700, parents=True)
        for name in ("ops/platform/compose.yaml", successor.FAULT_MODULE):
            path = self.source / name
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            path.write_bytes(f"owned {name}\n".encode())
        compose = (self.source / "ops/platform/compose.yaml").read_bytes()
        for phase in successor.PHASES:
            reviewed = self.rotation / phase
            reviewed.mkdir(mode=0o700)
            for name in (*successor.staging_state.CONFIGURATION_FILES, "frontend.env"):
                path = reviewed / name
                path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                value = phase if name in ("course-api.env", "community-api.env", "frontend.env") else "original"
                path.write_text(f"owned-{name}-{value}\n")
            snapshot = self.original if phase == "baseline" else self.directory / f"runtime-{phase}"
            shutil.copytree(reviewed, snapshot, dirs_exist_ok=True)
            (snapshot / "frontend.env").unlink()
            (snapshot / "compose.yaml").write_bytes(compose)
        self.profile = dict(successor.STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)
        frontend = resolve_qualification_target_profile(self.profile)["frontend"]
        self.selected = {"version": 3, "environment": "staging", "releaseId": self.selected_release,
                         "qualificationTargetProfile": self.profile,
                         "contractPhase": "p2", "phase2ContractManifestSha256": "sha256:" + "7" * 64,
                         "sources": {name: {"commit": "c" * 40, "qualificationTargetProfile": self.profile}
                                     for name in ("frontend", "course", "community")},
                         **{name: {"qualificationTargetProfile": self.profile} for name in ("sourceApproval", "integration", "approval")},
                         "workload": {"qualificationTargetProfile": self.profile, "projectId": frontend["projectId"],
                                      "environment": frontend["workloadEnvironment"]},
                         "runtime": {"composeSha256": "sha256:" + migrate.file_hash(compose)},
                         "artifacts": {name: {"image": f"owned/{name}@sha256:" + "d" * 64}
                                       for name in set(successor.runtime.IMAGE_KEYS.values())}}
        self.plan = {"environment": "staging", "actionId": self.action, "bindingSha256": "a" * 64,
                     "sourceCommit": "c" * 40, "candidateSha256": "b" * 64, "hostMachineId": "e" * 32,
                     "configuration": {phase: {"sha256": digit * 64} for phase, digit in zip(successor.PHASES, "123")}}
        self.inventories = {phase: self.inventory(index) for index, phase in enumerate(successor.PHASES)}
        replacement_original = self.write(self.custody_directory, successor.REPLACEMENT_TERMINAL, {"status": "owned-managed-terminal"})
        reviewed_original = self.write(self.custody_directory, "reviewed-plan.json", {
            "qualificationTargetProfile": self.profile, "replacement": {"managedCatalog": {"id": "owned"}}})
        self.review = {"qualificationTargetProfile": self.profile, "certificationActionId": self.action,
                       "originalReleaseId": self.selected_release, "sourceCommit": "c" * 40, "candidateSha256": "b" * 64,
                       "targetSha256": "f" * 64, "startState": "already-closed", "mode": "contain-native", "initialEpoch": "16",
                       "runtimeInventorySha256": self.digest_inventory("baseline"), "gatewayProcessSha256": "4" * 64,
                       "gatewayConfigurationSha256": migrate.file_hash((self.original / "gateway.json").read_bytes()),
                       "replacementRelease": {"reviewedPlanSha256": migrate.file_hash(reviewed_original)},
                       "originalReleaseReceiptSha256": migrate.file_hash(replacement_original),
                       "originalReleasePlanSha256": migrate.file_hash(reviewed_original)}
        self.features, self.writer = {"catalog": True}, {"sourceCommit": "c" * 40}
        self.review["nativePlan"] = {"featureControls": self.features, "writerAdmissionBinding": self.writer}
        custody = {"environment": "staging", "candidate": self.selected, "candidateSha256": "b" * 64, "sourceCommit": "c" * 40,
                   "hostMachineId": "e" * 32, "results": str(self.results), "configuration": str(self.original),
                   "configurationSha256": successor.staging_state.configuration_hashes(self.original),
                   "qualificationTargetProfile": self.profile, "certificationActionId": self.action,
                   "certification": {"featureControls": self.features}, "expectedWriterAdmissionBinding": self.writer,
                   "certificationPlan": self.review, "originalReleaseReceipt": base64.b64encode(replacement_original).decode()}
        self.initial = {**custody, "version": 2, "mode": "p2-identity-key-rotation", "frontendCustody": custody,
                        "rotationActionId": self.action, "rotationPlan": self.plan, "rotationConfiguration": str(self.rotation),
                        "privateRotationConfigurationSha256": {phase: successor._phase_hash(self.rotation / phase)
                                                                for phase in successor.PHASES},
                        "_guardLayout": supervisor.ROTATION_LAYOUT}
        self.closed = {"qualificationTargetProfile": self.profile, "status": "P2_CERTIFICATION_FRONTEND_SESSION_CLOSED",
                       "environment": "staging", "releaseId": self.selected_release, "sourceCommit": "c" * 40,
                       "targetSha256": "f" * 64, "backendAbsent": True, "migrationLockReleased": True, "nonceLockReleased": True,
                       "admission": {"epoch": "22", "newWork": False, "recovery": False, "active": 0, "uncertain": 0}}
        closed = self.write(self.directory, SESSION_CLOSED_RECEIPT, self.closed)
        self.terminal = {"status": supervisor.ROTATION_LAYOUT["terminalStatus"], "keyRemovalVerified": True,
                         **{key: self.plan[key] for key in successor.IDENTITY_FIELDS}, "configurationSha256": "3" * 64,
                         "frontendSessionCloseReceiptSha256": migrate.file_hash(closed),
                         **dict.fromkeys(("nativeSchedulesEnabled", "trafficAuthorized", "sqlExecuted", "rolesPrepared",
                                          "loginChanged", "releaseAccepted", "g2Accepted"), False)}
        self.retain_frontend_records()
        self.committed = migrate.file_hash(self.write(self.directory, JOINED_RECEIPT, self.terminal))
        self.write(self.directory, supervisor.ROTATION_LAYOUT["terminalName"], self.terminal)
        for phase, containers in self.inventories.items():
            self.write(self.directory, f"host-runtime-{phase}-inventory.json", successor._inventory_receipt(self.plan, phase, containers))
        for phase, kind in successor.MUTATIONS:
            intent = {"version": 1, "status": "P2_IDENTITY_ROTATION_MUTATION_INTENT", "environment": "staging",
                      **{key: self.plan[key] for key in successor.IDENTITY_FIELDS}, "phase": phase, "kind": kind,
                      "fromConfigurationSha256": "1" * 64 if phase == "overlap" else "2" * 64,
                      "toConfigurationSha256": self.plan["configuration"][phase]["sha256"],
                      "privateConfigurationRef": str(self.rotation / phase),
                      **dict.fromkeys(("sqlAuthorized", "rolePreparationAuthorized", "loginChangeAuthorized", "admissionAuthorized"), False)}
            self.write(self.directory, f"host-{phase}-{kind}-attempted.json",
                       {"version": 1, "status": "P2_ROTATION_HOST_MUTATION_ATTEMPTED", "intent": intent})
            self.write(self.directory, f"host-{phase}-{kind}-observed.json",
                       successor.P2IdentityRotationHostAdapter._result(intent, False))

    def retain_frontend_records(self):
        self.ready = self.directory / "frontend-current-only"
        self.post_removal = self.directory / "frontend-post-removal"
        for path in (self.ready, self.post_removal):
            path.mkdir(mode=0o700)
        self.deployment = "dpl_Current"
        self.deployment_url = "https://owned-current.vercel.app"
        identity = {"version": 2, "qualificationTargetProfile": self.profile, "environment": "staging",
                    "releaseId": self.selected_release, "sourceCommit": self.terminal["sourceCommit"],
                    "projectId": self.selected["workload"]["projectId"], "previousDeploymentId": "dpl_Overlap"}
        created = {"deploymentId": self.deployment}
        build_flags = {"trafficAuthorized": False, "promotionAuthorized": False}
        promotion = {**created, "previousAliasRequestedAt": 1}
        fields = (
            build_flags,
            build_flags | created,
            build_flags | created | {"status": "FRONTEND_STAGED", "phase": "completed", "url": self.deployment_url,
                                     "readyState": "READY"},
            created | {"status": "FRONTEND_VERIFIED", "phase": "completed", "trafficAuthorized": False,
                       "nativeSchedulerVerified": False, "checks": ["frontend-server-gateway-course-catalog-p2"],
                       **migrate.contract_identity(self.selected), "featureControls": self.features,
                       "writerAdmissionBinding": self.writer},
            promotion,
            promotion | {"status": "FRONTEND_DOMAINS_PROMOTED", "phase": "completed", "aliasRequestedAt": 2,
                         "frontendDomainsPromoted": True, "trafficAuthorized": False, "gatewayTrafficAuthorized": False},
        )
        self.ready_hashes = {name: migrate.file_hash(self.write(self.ready, name, identity | detail))
                             for name, detail in zip(certification.READY_FILES, fields)}
        alias = {"alias": successor.canonical_origin.HOST, "projectId": identity["projectId"], **created,
                 "redirect": False, "deleted": False, "microfrontends": False}
        self.signer = {"version": 1, "status": "P2_IDENTITY_ROTATION_BROWSER_READS_RECORDED", "environment": "staging",
                       "phase": "post-removal", **created, "deploymentUrl": self.deployment_url,
                       **{key: self.terminal[key] for key in (*successor.IDENTITY_FIELDS, "configurationSha256")},
                       "workloadReceiptSha256": self.ready_hashes["frontend-workload-outcome.json"],
                       "browserOrigin": successor.canonical_origin.ORIGIN,
                       "canonicalAliasReadbackSha256": migrate.file_hash(successor._canonical(alias)),
                       "canonicalProtectedWorkloadSha256": "8" * 64}
        self.signer_path = self.post_removal / "rotation-frontend-browser-source.json"
        self.write(self.post_removal, self.signer_path.name, self.signer)
        self.terminal["frontendSignerReceiptSha256"] = {"post-removal": migrate.file_hash(successor._canonical(self.signer))}

    def inventory(self, phase_index):
        return [{"service": service, "containerId": f"{index + (phase_index * 20 if service in successor.API_SERVICES else 0):064x}",
                 "image": self.selected["artifacts"][successor.runtime.IMAGE_KEYS[service]]["image"],
                 "health": "none" if service.endswith("-tls") else "healthy"}
                for index, service in enumerate(successor.runtime.SERVICES, 1)]

    def digest_inventory(self, phase):
        return migrate.file_hash(successor._canonical(self.inventories[phase]))

    @staticmethod
    def write(directory, name, value):
        migrate.write_json(directory, name, value)
        return (directory / name).read_bytes()

    def run_join(self, *, reaped=True, observe=None, pending=False):
        with ExitStack() as stack:
            stack.enter_context(patch.object(supervisor, "verify_guard_boundary"))
            stack.enter_context(patch.object(certification, "require_certification_replacement_release",
                                             return_value=self.review["replacementRelease"]))
            stack.enter_context(patch.object(replacement, "managed_catalog", return_value={"id": "owned-managed"}))
            if observe is None:
                stack.enter_context(patch.object(successor, "_observe_mixed_runtime"))
            else:
                observe(stack)
            return successor.retain_rotation_successor(self.initial, self.source, self.terminal, self.committed, self.closed,
                                                       worker_reaped=reaped, terminal_pending=pending)

    def test_rejoins_managed_predecessor_all_mutations_and_guardian_terminal(self):
        value = self.run_join()
        self.assertEqual(value["status"], successor.STATUS)
        self.assertEqual(value["kind"], "identity-key-rotation-mixed-mount-v1")
        self.assertEqual(value["frontendEpoch"], "22")
        self.assertEqual(len(value["unchangedOriginalServices"]), 8)
        self.assertEqual(value["currentOnlyRecreatedServices"], list(successor.API_SERVICES))
        self.assertEqual(value["runtimeInventorySha256"], self.digest_inventory("current-only"))
        self.assertEqual(value["frontend"], {"deploymentId": self.deployment, "deploymentUrl": self.deployment_url,
                                            "readyReceiptSha256": self.ready_hashes,
                                            "postRemovalSignerReceiptSha256": self.terminal["frontendSignerReceiptSha256"]["post-removal"]})
        self.assertEqual(value["frontend"], successor.rotation_frontend_successor(self.directory, self.terminal))
        self.assertEqual([(entry["phase"], entry["kind"]) for entry in value["mutationReceipts"]], list(successor.MUTATIONS))
        raw = (self.directory / successor.RECEIPT).read_text()
        self.assertEqual(value, json.loads(raw))
        self.assertNotIn(str(self.rotation), raw)
        self.assertNotIn(str(self.current), raw)
        with self.assertRaises(FileExistsError):
            self.run_join()

    def test_frontend_refuses_resealed_browser_identity_drift(self):
        for field, value in (("deploymentUrl", "https://wrong.vercel.app"), ("configurationSha256", "a" * 64),
                             ("workloadReceiptSha256", "a" * 64), ("canonicalAliasReadbackSha256", "a" * 64),
                             ("canonicalProtectedWorkloadSha256", "0" * 64)):
            with self.subTest(field=field):
                altered = self.signer | {field: value}
                self.signer_path.write_bytes(successor._canonical(altered))
                terminal = self.terminal | {"frontendSignerReceiptSha256": {"post-removal":
                                           migrate.file_hash(successor._canonical(altered))}}
                with self.assertRaisesRegex(ValueError, successor.REFUSED):
                    successor.rotation_frontend_successor(self.directory, terminal)

    def test_frontend_refuses_candidate_workload_drift_and_linked_receipt_directory(self):
        self.initial["frontendCustody"]["certification"] = {"featureControls": {"catalog": False}}
        self.review["nativePlan"]["featureControls"] = {"catalog": False}
        with self.assertRaisesRegex(ValueError, "P2_PROFILED_CERTIFICATION_WORKLOAD_REQUIRED"):
            self.run_join()
        relocated = self.directory / "relocated-ready"
        self.ready.rename(relocated)
        self.ready.symlink_to(relocated, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, successor.REFUSED):
            successor.rotation_frontend_successor(self.directory, self.terminal)

    def test_frontend_receipt_change_during_final_runtime_observation_refused(self):
        path = self.ready / "frontend-build-started.json"

        def change_after_first_read(stack):
            stack.enter_context(patch.object(successor, "_observe_mixed_runtime", side_effect=lambda *_: path.write_bytes(
                path.read_bytes() + b"\n")))

        with self.assertRaisesRegex(ValueError, successor.REFUSED):
            self.run_join(observe=change_after_first_read)
        self.assertFalse((self.directory / successor.RECEIPT).exists())

    def test_pending_terminal_binds_the_exact_joined_bytes_and_requires_no_prior_terminal(self):
        final = self.directory / supervisor.ROTATION_LAYOUT["terminalName"]
        with self.assertRaisesRegex(ValueError, successor.REFUSED):
            self.run_join(pending=True)
        final.unlink()
        receipt = self.run_join(pending=True)
        self.assertFalse(final.exists())
        self.assertEqual(receipt["terminalReceiptSha256"], self.committed)

    def test_requires_worker_reap_and_same_physical_closed_evidence(self):
        with self.assertRaisesRegex(ValueError, successor.REFUSED):
            self.run_join(reaped=False)
        self.closed["admission"]["epoch"] = "21"
        with self.assertRaisesRegex(ValueError, successor.REFUSED):
            self.run_join()
        self.assertFalse((self.directory / successor.RECEIPT).exists())

    def test_extra_or_reconciled_mutations_and_current_configuration_drift_refused(self):
        restore = self.directory / "host-restoration-attempted.json"
        self.write(self.directory, restore.name, {"status": "unexpected"})
        with self.assertRaisesRegex(ValueError, successor.REFUSED):
            self.run_join()
        restore.unlink()
        changed = self.directory / "host-current-only-api-observed.json"
        value = json.loads(changed.read_bytes())
        value["getFirstReconciled"] = True
        changed.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, successor.REFUSED):
            self.run_join()
        value["getFirstReconciled"] = False
        changed.write_text(json.dumps(value))
        (self.current / "course-api.env").write_text("unreviewed\n")
        with self.assertRaisesRegex(ValueError, successor.REFUSED):
            self.run_join()
        self.assertFalse((self.directory / successor.RECEIPT).exists())

    def test_refuses_missing_api_recreation_or_any_unchanged_service_drift(self):
        record = self.directory / "host-runtime-current-only-inventory.json"
        final = copy.deepcopy(self.inventories["current-only"])
        final[0]["containerId"] = self.inventories["overlap"][0]["containerId"]
        record.write_text(json.dumps(successor._inventory_receipt(self.plan, "current-only", final)))
        with self.assertRaisesRegex(ValueError, successor.REFUSED):
            self.run_join()
        final[0] = self.inventories["current-only"][0]
        final[-1]["containerId"] = "9" * 64
        record.write_text(json.dumps(successor._inventory_receipt(self.plan, "current-only", final)))
        with self.assertRaisesRegex(ValueError, successor.REFUSED):
            self.run_join()

    def test_broker_records_only_the_guarded_actual_inventory(self):
        broker = P2IdentityRotationBroker.__new__(P2IdentityRotationBroker)
        broker.initial, broker.directory, broker.runtime_phase = self.initial, self.directory, "baseline"
        broker.scope = SimpleNamespace(verify=lambda: None)
        broker._require_closed_frontend = lambda: None
        inventory = self.inventories["baseline"]
        broker.adapter = SimpleNamespace(runtime_guard_containers=lambda _public: inventory)
        record = self.directory / "host-runtime-baseline-inventory.json"
        record.unlink()
        edited = copy.deepcopy(inventory)
        edited[0]["containerId"] = "a" * 64
        with self.assertRaisesRegex(ValueError, successor.REFUSED):
            successor.record_rotation_runtime_inventory(broker, "baseline", edited)
        successor.record_rotation_runtime_inventory(broker, "baseline", inventory)
        self.assertEqual(json.loads(record.read_bytes()), successor._inventory_receipt(self.plan, "baseline", inventory))

    def mock_readbacks(self, stack, *, changed=None):
        final = self.inventories["current-only"]
        by_id = {row["containerId"]: row for row in final}
        gateway_id = final[-1]["containerId"]
        state = {"valid": True, "newWork": False, "recovery": False, "active": {"newWork": 0, "recovery": 0},
                 "uncertain": {"newWork": 0, "recovery": 0}}
        process = {"containerId": gateway_id, "running": True}
        gateway = {"process": process, "admission": state, "binding": {"configurationDirectory": str(self.original)}}
        mount = (self.original / "admission").lstat()
        gateway_read = {"version": 1, "status": "P2_FAULT_GATEWAY_CURRENT", "processSha256": self.review["gatewayProcessSha256"],
                        "gatewayConfigurationSha256": self.review["gatewayConfigurationSha256"], "faultLeasePresent": False,
                        "faultModuleSha256": migrate.file_hash((self.source / successor.FAULT_MODULE).read_bytes()),
                        "admission": state, "admissionDirectory": {"device": str(mount.st_dev), "inode": str(mount.st_ino)}}
        if changed == "gateway":
            gateway_read["processSha256"] = "7" * 64
        if changed == "uncertain":
            state["uncertain"]["recovery"] = 1
        maps = {
            "gateway": {"/config/gateway.json": self.original / "gateway.json", "/admission": self.original / "admission",
                        "/tls": self.original / "tls/gateway"},
            "course-tls": {"/config/course-tls.json": self.original / "course-tls.json", "/tls": self.original / "tls/course"},
            "community-tls": {"/config/community-tls.json": self.original / "community-tls.json", "/tls": self.original / "tls/community"},
            "course-publisher": {"/tls/ca.pem": self.original / "tls/ca.pem"},
            "community-worker": {"/tls/ca.pem": self.original / "tls/ca.pem"},
            "community-api": {"/tls/ca.pem": (self.original if changed == "mount" else self.current) / "tls/ca.pem"},
        }

        def command(args, environment, timeout):
            if args[:3] == ["docker", "container", "ls"]:
                return "\n".join([*by_id, *(["a" * 64] if changed == "extra" else [])])
            if args[:2] == ["docker", "inspect"]:
                item = by_id[args[-1]]
                service = item["service"]
                if args[-2].startswith("{{.Config.Image}}"):
                    root = self.current if service in successor.API_SERVICES else self.original
                    if changed == "labels" and service == "course-api":
                        root = self.original
                    return "|".join((item["image"], str(root), str(root / "compose.yaml")))
                return "true|" + json.dumps([{"Destination": name, "Type": "bind", "RW": False, "Source": str(path)}
                                             for name, path in maps.get(service, {}).items()])
            if args[:2] == ["docker", "exec"] and args[-1] == successor.GATEWAY_OBSERVER:
                return json.dumps(gateway_read)
            raise AssertionError(args)

        stack.enter_context(patch.object(supervisor, "verify_guard_lock"))
        stack.enter_context(patch.object(successor.runtime, "check_containers", return_value=final))
        stack.enter_context(patch.object(successor.runtime, "command", side_effect=command))
        stack.enter_context(patch.object(successor.prior, "observe_prior_gateway", return_value=gateway))
        stack.enter_context(patch.object(successor.prior, "_process", return_value=process))

    def test_mixed_compose_labels_read_only_mounts_and_exact_gateway_postflight(self):
        for drift in ("extra", "labels", "mount", "gateway", "uncertain"):
            with self.subTest(drift=drift), self.assertRaises(ValueError):
                self.run_join(observe=lambda stack: self.mock_readbacks(stack, changed=drift))
            self.assertFalse((self.directory / successor.RECEIPT).exists())
        self.assertEqual(self.run_join(observe=self.mock_readbacks)["status"], successor.STATUS)


if __name__ == "__main__":
    unittest.main()
