import io
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest import mock

import p2_profiled_current_frontend as subject


PROFILE = dict(subject.PROFILE)
PROJECT = "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM"
DEPLOYMENT = "dpl_Owned123"
SOURCE = "a" * 40


class RequestClient:
    def __init__(self):
        self.calls = []

    def request(self, method, path, body=None):
        self.calls.append((method, path, body))
        return {"ok": True}


class ProfiledCurrentFrontendTest(unittest.TestCase):
    def private(self):
        value = Path(tempfile.mkdtemp(prefix="profiled-current-provider-")).resolve()
        os.chmod(value, 0o700)
        self.addCleanup(lambda: __import__("shutil").rmtree(value, ignore_errors=True))
        return value

    def test_guarded_client_retains_intent_before_mutation_and_read_only_never_calls_provider(self):
        directory, actual, checks = self.private(), RequestClient(), []
        client = subject.GuardedClient(actual, directory, lambda: checks.append("checked"))
        client.request("POST", "/v13/deployments", {"owned": True})
        intent = json.loads((directory / "provider-mutation-intent-001.json").read_text())
        self.assertEqual((intent["method"], intent["providerMutationCompleted"], intent["trafficAuthorized"]),
                         ("POST", False, False))
        self.assertEqual(checks, ["checked"])
        denied = subject.GuardedClient(actual, directory, lambda: checks.append("unexpected"), read_only=True)
        with self.assertRaises(ValueError):
            denied.request("POST", "/v13/deployments", {})
        self.assertEqual(len(actual.calls), 1)

    def recovery_fixture(self):
        root = self.private()
        attempt, private = root / "vercel", root / "vercel-private"
        attempt.mkdir(mode=0o700); private.mkdir(mode=0o700)
        staged = {"version": 2, "qualificationTargetProfile": PROFILE, "environment": "staging", "projectId": PROJECT,
            "sourceCommit": SOURCE, "releaseId": "owned-release", "deploymentId": DEPLOYMENT, "previousDeploymentId": "dpl_Previous123"}
        build = {**staged, "status": "FRONTEND_STAGED", "readyState": "READY", "trafficAuthorized": False, "promotionAuthorized": False}
        promotion = {**staged, "previousAliasRequestedAt": 10}
        controls = {name: name != "INTEGRATION_CHECKOUT_ENABLED" for name in subject.FEATURES}
        writer = {"mode": "enforce", "targetSha256": "b" * 64, "producerSha256": "c" * 64,
                  "sourceCommit": SOURCE, "roleName": "frontend_runtime"}
        workload = {**staged, "status": "FRONTEND_VERIFIED", "contractPhase": "p2",
            "phase2ContractManifestSha256": "sha256:" + "d" * 64, "featureControls": controls,
            "writerAdmissionBinding": writer}
        records = {"frontendBuildOutcome": ("frontend-build-outcome.json", build),
                   "frontendPromotionStarted": ("frontend-promotion-started.json", promotion),
                   "frontendWorkloadOutcome": ("frontend-workload-outcome.json", workload)}
        pins = {"candidate": "1" * 64, "frontendDatabase": "2" * 64, "frontendContinuationStarted": "3" * 64,
                "apiMigrationOutcome": "4" * 64, "apiRuntimeOutcome": "5" * 64}
        for key, (name, value) in records.items():
            raw = json.dumps(value).encode() + b"\n"
            (attempt / name).write_bytes(raw); os.chmod(attempt / name, 0o600); pins[key] = subject.sha(raw)
        candidate = {"version": 3, "qualificationTargetProfile": PROFILE, "environment": "staging", "releaseId": "owned-release",
            "contractPhase": "p2", "phase2ContractManifestSha256": "sha256:" + "d" * 64,
            "sources": {"frontend": {"commit": SOURCE, "repository": "https://github.com/princessdardan/lash-her-frontend.git",
                "requiredChecks": "passed"}}, "workload": {"projectId": PROJECT, "environment": "production"},
            "frontendMigration": {"qualificationTargetProfile": PROFILE}}
        target = {"qualificationTargetProfile": PROFILE, "approvedPendingTags": [], "allowEmptyBootstrap": False,
                  "runtimeRole": "frontend_runtime"}
        job = {"version": 2, "qualificationTargetProfile": PROFILE, "environment": "staging", "releaseId": "owned-release",
               "sourceCommit": SOURCE, "target": target}
        configuration = {name: str(index % 9 + 1) * 64 for index, name in enumerate(sorted(subject.CONFIGURATION_NAMES))}
        plan = {"version": 2, "qualificationTargetProfile": PROFILE, "mode": "p2-profiled-current-recovery",
            "environment": "staging", "disposition": "reconcile-frontend-get-first", "originalReleaseId": "owned-release",
            "sourceCommit": SOURCE, "candidateSha256": "e" * 64, "configurationSha256": configuration,
            "targetSha256": "b" * 64, "originalReceiptSha256": pins}
        initial = {"qualificationTargetProfile": PROFILE, "plan": plan, "candidate": candidate, "job": job,
                   "originalReceiptSha256": pins}
        provider = {"version": 2, "qualificationTargetProfile": PROFILE, "vercelToken": "private-token",
                    "originalDirectory": str(root), "bindings": {"gatewayObservation": {"owned": True}}}
        return initial, provider, staged, workload

    def lost_build_fixture(self, *, outcome=False):
        root = self.private(); attempt = root / "vercel"; attempt.mkdir(mode=0o700)
        configuration = {name: str(index % 9 + 1) * 64 for index, name in enumerate(sorted(subject.CONFIGURATION_NAMES))}
        candidate = {"version": 3, "qualificationTargetProfile": PROFILE, "environment": "staging",
            "releaseId": "owned-release", "contractPhase": "p2", "phase2ContractManifestSha256": "sha256:" + "d" * 64,
            "sourceApproval": {"qualificationTargetProfile": PROFILE}, "integration": {"qualificationTargetProfile": PROFILE},
            "sources": {"frontend": {"qualificationTargetProfile": PROFILE, "commit": SOURCE,
                "repository": "https://github.com/princessdardan/lash-her-frontend.git", "requiredChecks": "passed"},
                "course": {"qualificationTargetProfile": PROFILE}, "community": {"qualificationTargetProfile": PROFILE}},
            "workload": {"qualificationTargetProfile": PROFILE, "projectId": PROJECT, "environment": "production"},
            "approval": {"qualificationTargetProfile": PROFILE},
            "frontendMigration": {"qualificationTargetProfile": PROFILE}}
        target = {"qualificationTargetProfile": PROFILE, "approvedPendingTags": [], "allowEmptyBootstrap": False,
                  "runtimeRole": "frontend_runtime"}
        job = {"version": 2, "qualificationTargetProfile": PROFILE, "environment": "staging", "releaseId": "owned-release",
               "sourceCommit": SOURCE, "target": target}
        plan = {"version": 2, "qualificationTargetProfile": PROFILE, "mode": "p2-profiled-current-recovery",
            "environment": "staging", "disposition": "reconcile-frontend-lost-build-get-first",
            "originalReleaseId": "owned-release", "sourceCommit": SOURCE, "candidateSha256": "e" * 64,
            "configurationSha256": configuration, "targetSha256": "b" * 64}
        deploy = {"version": 2, "qualificationTargetProfile": PROFILE, "environment": "staging",
            "releaseId": "owned-release", "sourceCommit": SOURCE, "candidateSha256": plan["candidateSha256"],
            "configurationSha256": configuration, "trafficAuthorized": False}
        build = {"version": 2, "qualificationTargetProfile": PROFILE, "environment": "staging", "projectId": PROJECT,
            "sourceCommit": SOURCE, "releaseId": "owned-release", "previousDeploymentId": "dpl_Previous123",
            "trafficAuthorized": False, "promotionAuthorized": False}
        intent = {"version": 2, "qualificationTargetProfile": PROFILE, "sequence": 2, "method": "POST",
            "pathSha256": subject.sha(b"/v13/deployments"), "bodyKeys": list(subject.BUILD_BODY_KEYS),
            "providerMutationCompleted": False, "trafficAuthorized": False}
        other = {**intent, "sequence": 1, "pathSha256": subject.sha(b"/v10/projects/owned/env?upsert=true"),
                 "bodyKeys": ["key", "value"]}
        records = [("p2-profiled-current-deploy-started.json", deploy, "deployStarted"),
                   ("frontend-build-started.json", build, "buildStarted"),
                   ("provider-mutation-intent-001.json", other, None),
                   ("provider-mutation-intent-002.json", intent, "buildIntent")]
        if outcome:
            records.append(("frontend-build-outcome.json", {**build, "status": "FRONTEND_BUILD_FAILED_REQUIRES_REVIEW",
                "phase": "create", "failureCode": "VERCEL_REQUEST_FAILED_REQUIRES_REVIEW"}, "buildOutcome"))
        pins = {}
        for name, value, key in records:
            subject.migrate.write_json(attempt, name, value)
            if key: pins[key] = subject.sha((attempt / name).read_bytes())
        plan["lostBuildReceiptSha256"] = dict(pins)
        initial = {"version": 2, "qualificationTargetProfile": PROFILE, "plan": plan, "candidate": candidate,
                   "job": job, "lostBuildReceiptSha256": pins}
        provider = {"version": 2, "qualificationTargetProfile": PROFILE, "vercelToken": "private-token",
                    "originalDirectory": str(root), "bindings": {"gatewayObservation": {"owned": True}}}
        return initial, provider, attempt

    def lost_build_provider(self, rows, *, current="dpl_Previous123"):
        class Provider:
            calls = []
            def __init__(self, _token): pass
            def request(self, method, path, body=None):
                self.calls.append((method, path, body))
                if method != "GET": raise AssertionError("mutation")
                if path.startswith("/v7/deployments?"):
                    return {"deployments": rows, "pagination": {"count": len(rows), "next": None}}
                if path.startswith("/v13/deployments/"):
                    deployment_id = path.split("/")[3].split("?")[0]
                    return {"id": deployment_id, "projectId": PROJECT, "target": "production", "readyState": "READY",
                        "url": "owned.vercel.app", "gitSource": {"type": "github", "repoId": subject.vercel.REPOSITORY_ID,
                        "sha": SOURCE}, "meta": {"lashReleaseId": "owned-release"}}
                if path.startswith("/v9/projects/"):
                    return {"id": PROJECT, "accountId": subject.vercel.TEAM,
                        "link": {"type": "github", "repoId": subject.vercel.REPOSITORY_ID},
                        "targets": {"production": {"id": current}}, "crons": {"disabledAt": 1}}
                raise AssertionError(path)
        return Provider

    def test_lost_build_observation_proves_only_one_pending_effect_with_or_without_failure_outcome(self):
        row = {"uid": DEPLOYMENT, "target": "production",
               "gitSource": {"type": "github", "repoId": subject.vercel.REPOSITORY_ID, "sha": SOURCE},
               "meta": {"lashReleaseId": "owned-release"}}
        for outcome in (False, True):
            with self.subTest(outcome=outcome):
                initial, provider, _attempt = self.lost_build_fixture(outcome=outcome)
                selected = self.lost_build_provider([row]); checks = []
                with mock.patch.object(subject.vercel, "Client", selected):
                    result = subject.observe_lost_build_post_ack(initial, provider, lambda: checks.append("checked"))
                expected_fields = {"version", "qualificationTargetProfile", "status", "environment", "actionId", "releaseId",
                    "sourceCommit", "candidateSha256", "configurationSha256", "targetSha256", "projectId", "deploymentId",
                    "previousDeploymentId", "lostBuildReceiptSha256", "deployStartedSha256", "buildStartedSha256",
                    "buildIntentSha256", "getFirst", "newProviderPost", "ambiguous", "deploymentEffectObserved",
                    "frontendActionPending", "originalBuildAckObserved", "providerMutationReplayed", "buildReadyVerified",
                    "workloadVerified", "aliasQualificationVerified", "promotionVerified", "cronQualificationVerified",
                    "trafficAuthorized", "releaseAccepted"} | ({"buildOutcomeSha256"} if outcome else set())
                self.assertEqual(set(result), expected_fields)
                self.assertEqual(result["status"], "P2_PROFILED_CURRENT_FRONTEND_BUILD_EFFECT_OBSERVED")
                self.assertEqual(result["deploymentId"], DEPLOYMENT)
                self.assertTrue(result["deploymentEffectObserved"] and result["frontendActionPending"])
                for key in ("originalBuildAckObserved", "providerMutationReplayed", "buildReadyVerified", "workloadVerified",
                            "aliasQualificationVerified", "promotionVerified", "cronQualificationVerified",
                            "trafficAuthorized", "releaseAccepted"):
                    self.assertFalse(result[key], key)
                self.assertNotIn("readyState", result); self.assertNotIn("aliasJob", result)
                self.assertEqual("buildOutcomeSha256" in result, outcome)
                self.assertTrue(selected.calls and all(call[0] == "GET" for call in selected.calls))
                self.assertEqual(len(checks), len(selected.calls))

    def test_lost_build_observation_refuses_absent_ambiguous_wrong_target_changed_prior_and_later_receipt(self):
        valid = {"uid": DEPLOYMENT, "target": "production",
                 "gitSource": {"type": "github", "repoId": subject.vercel.REPOSITORY_ID, "sha": SOURCE},
                 "meta": {"lashReleaseId": "owned-release"}}
        cases = (("absent", [], "dpl_Previous123"),
                 ("ambiguous", [valid, {**valid, "uid": "dpl_Other123"}], "dpl_Previous123"),
                 ("wrong-target", [{**valid, "target": "preview"}], "dpl_Previous123"),
                 ("changed-prior", [valid], "dpl_Unrelated123"))
        for name, rows, current in cases:
            with self.subTest(name=name):
                initial, provider, _attempt = self.lost_build_fixture()
                selected = self.lost_build_provider(rows, current=current)
                with mock.patch.object(subject.vercel, "Client", selected), self.assertRaises(ValueError):
                    subject.observe_lost_build_post_ack(initial, provider, lambda: None)
                self.assertTrue(all(call[0] == "GET" for call in selected.calls))
        for later in ("frontend-build-created.json", "frontend-promotion-observation-0.json"):
            with self.subTest(later=later):
                initial, provider, attempt = self.lost_build_fixture()
                subject.migrate.write_json(attempt, later, {"deploymentId": DEPLOYMENT})
                with mock.patch.object(subject.vercel, "Client", side_effect=AssertionError("provider read")):
                    with self.assertRaises(ValueError): subject.observe_lost_build_post_ack(initial, provider, lambda: None)
        initial, provider, _attempt = self.lost_build_fixture(outcome=True)
        del initial["lostBuildReceiptSha256"]["buildOutcome"]
        initial["plan"]["lostBuildReceiptSha256"] = dict(initial["lostBuildReceiptSha256"])
        with mock.patch.object(subject.vercel, "Client", side_effect=AssertionError("provider read")):
            with self.assertRaises(ValueError): subject.observe_lost_build_post_ack(initial, provider, lambda: None)

    def test_main_routes_only_the_fixed_lost_build_operation_to_the_internal_helper(self):
        payload = {"operation": "recovery-observe-lost-build", "version": 2, "qualificationTargetProfile": PROFILE,
                   "vercelToken": "private-token", "originalDirectory": "/private/source-owned",
                   "bindings": {"owned": True}, "plan": {"owned": "source"}}
        result = {"version": 2, "qualificationTargetProfile": PROFILE,
                  "status": "P2_PROFILED_CURRENT_FRONTEND_BUILD_EFFECT_OBSERVED"}
        stdin = io.TextIOWrapper(io.BytesIO((json.dumps(payload) + "\n").encode()))
        stdout = io.StringIO()
        with mock.patch.object(sys, "stdin", stdin), mock.patch.object(sys, "stdout", stdout), \
             mock.patch.object(subject, "observe_lost_build_post_ack", return_value=result) as observed:
            subject.main()
        self.assertEqual(json.loads(stdout.getvalue()), {"type": "result", "value": result})
        initial, provider = observed.call_args.args
        self.assertEqual(initial, payload)
        self.assertEqual(provider, {"version": 2, "qualificationTargetProfile": PROFILE,
            "vercelToken": "private-token", "originalDirectory": "/private/source-owned", "bindings": {"owned": True}})

    def test_recovery_is_get_only_unique_and_returns_exact_pinned_workload_with_inner_proof(self):
        initial, provider, staged, workload = self.recovery_fixture()

        class Provider:
            calls = []
            def __init__(self, _token): pass
            def request(self, method, path, body=None):
                self.calls.append((method, path, body))
                if method != "GET": raise AssertionError("mutation")
                return {"deployments": [{"uid": DEPLOYMENT, "target": "production",
                    "gitSource": {"type": "github", "repoId": subject.vercel.REPOSITORY_ID, "sha": SOURCE},
                    "meta": {"lashReleaseId": "owned-release"}}], "pagination": {"count": 1, "next": None}}

        project = {"targets": {"production": {"id": DEPLOYMENT}}, "protectionBypass": {"private-bypass": {"scope": "automation-bypass"}},
            "crons": {"disabledAt": 1, "deploymentId": DEPLOYMENT,
            "definitions": [{"path": "/api/cron/account-lifecycle", "schedule": "* * * * *", "host": "owned.vercel.app"}]}}
        class Probe:
            def request(self, _url, _secret, _bypass, challenge, mode=None):
                self.assert_mode = mode
                return {"version": 1, "status": "FRONTEND_WORKLOAD_PROBE_PASS", "challenge": challenge,
                    "checks": ["gateway-course-catalog-p2"], "contractPhase": "p2",
                    "featureControls": workload["featureControls"], "writerAdmissionBinding": workload["writerAdmissionBinding"],
                    "gatewayOrigin": "https://api-staging.lashher.com", "environment": "staging", "projectId": PROJECT,
                    "sourceCommit": SOURCE}
        with mock.patch.object(subject.vercel, "Client", Provider), \
             mock.patch.object(subject.vercel, "release_identity", return_value=("staging", PROJECT, SOURCE)), \
             mock.patch.object(subject.vercel, "_staged_identity", return_value=staged), \
             mock.patch.object(subject.vercel, "deployment_state", return_value={"readyState": "READY", "url": "https://owned.vercel.app"}), \
             mock.patch.object(subject.vercel, "promotion_state", return_value={"cronsEnabled": False, "productionDeploymentId": DEPLOYMENT,
                 "aliasJob": {"jobStatus": "succeeded", "type": "promote", "toDeploymentId": DEPLOYMENT, "requestedAt": 11}}), \
             mock.patch.object(subject.vercel, "_project", return_value=project), \
             mock.patch.object(subject.frontend_probe, "_private_input", return_value={"expiresAt": int(time.time() * 1000) + 1_000,
                 "secret": "private", "gatewayOrigin": "https://api-staging.lashher.com"}), \
             mock.patch.object(subject.frontend_probe, "ProbeClient", Probe):
            result = subject.observe_recovery(initial, provider, lambda: None)
        self.assertEqual(result["observation"]["status"], "P2_PROFILED_CURRENT_FRONTEND_CURRENT")
        self.assertTrue(result["observation"]["originalEffectReconciled"])
        self.assertEqual(result["proof"]["status"], "P2_PROFILED_CURRENT_FRONTEND_VERIFIED")
        self.assertEqual(result["proof"]["configurationSha256"], initial["plan"]["configurationSha256"])
        self.assertEqual(json.loads(result["workload"]), workload)
        self.assertTrue(Provider.calls and all(call[0] == "GET" for call in Provider.calls))

    def test_recovery_rejects_missing_pin_before_provider_construction(self):
        initial, provider, _staged, _workload = self.recovery_fixture()
        del initial["originalReceiptSha256"]["frontendWorkloadOutcome"]
        with mock.patch.object(subject.vercel, "Client", side_effect=AssertionError("provider read")):
            with self.assertRaises(ValueError): subject.observe_recovery(initial, provider, lambda: None)

    def test_deploy_uses_profiled_primitives_and_checkpoints_every_provider_request(self):
        root = self.private(); checks = []
        controls = {name: name != "INTEGRATION_CHECKOUT_ENABLED" for name in subject.FEATURES}
        writer = {"mode": "enforce", "targetSha256": "b" * 64, "producerSha256": "c" * 64,
                  "sourceCommit": SOURCE, "roleName": "frontend_runtime"}
        gateway = {"owned": True}
        plan = {"version": 2, "qualificationTargetProfile": PROFILE, "environment": "staging", "actionId": "owned-release",
            "sourceCommit": SOURCE, "targetSha256": "b" * 64, "restoration": {"gatewayBindingSha256": subject.json_sha(gateway)}}
        candidate = {"version": 3, "qualificationTargetProfile": PROFILE, "environment": "staging", "releaseId": "owned-release",
            "contractPhase": "p2", "phase2ContractManifestSha256": "sha256:" + "d" * 64,
            "sources": {"frontend": {"commit": SOURCE}}, "frontendMigration": {"qualificationTargetProfile": PROFILE}}
        job = {"version": 2, "qualificationTargetProfile": PROFILE, "environment": "staging", "releaseId": "owned-release",
               "sourceCommit": SOURCE, "target": {"qualificationTargetProfile": PROFILE}}
        configuration = {name: str(index % 9 + 1) * 64 for index, name in enumerate(sorted(subject.CONFIGURATION_NAMES))}
        target = {"qualificationTargetProfile": PROFILE, "environment": "staging", "targetSha256": "b" * 64,
                  "host": "db.example.com", "port": 5432, "database": "frontend", "user": "frontend_runtime", "serverMajor": 18}
        context = {"qualificationTargetProfile": PROFILE, "plan": plan, "candidate": candidate, "job": job,
            "candidateSha256": "e" * 64, "inventorySha256": subject.json_sha(plan), "configurationSha256": configuration,
            "directory": str(root), "vercelToken": "private-token", "bindings": {"gatewayObservation": gateway},
            "expectedFeatureControls": controls, "writerAdmissionBinding": writer, "bootstrapRuntimeTarget": target,
            "frontendRuntimeDatabaseUrl": "postgresql://frontend_runtime:private@db.example.com/frontend?sslmode=verify-full"}
        environment_rows = []

        class Provider:
            calls = []
            def __init__(self, _token): pass
            def request(self, method, path, body=None):
                self.calls.append((method, path, body))
                if path.endswith("/env?decrypt=false"): return {"envs": environment_rows}
                if "/env?upsert=true" in path:
                    environment_rows.append({"key": body["key"], "value": body["value"], "type": body["type"],
                                             "target": ["production"], "gitBranch": None, "customEnvironmentIds": []})
                    return {"failed": [], "created": environment_rows[-1]}
                return {}

        staged = {"version": 2, "qualificationTargetProfile": PROFILE, "environment": "staging", "projectId": PROJECT,
            "sourceCommit": SOURCE, "releaseId": "owned-release", "deploymentId": DEPLOYMENT, "previousDeploymentId": "dpl_Previous123"}

        def disable(client, _candidate, **_kwargs): client.request("PATCH", "/v1/projects/owned/crons", {"enabled": False})
        def prepare(client, *_args, **_kwargs): client.request("POST", "/v10/projects/owned/env?upsert=true", {
            "key": "LASH_RELEASE_PROBE_SECRET", "value": "private", "type": "sensitive", "target": ["production"],
            "gitBranch": None, "customEnvironmentIds": []})
        def stage(client, _candidate, attempt, **_kwargs):
            client.request("POST", "/v13/deployments", {}); subject.migrate.write_json(attempt, "frontend-build-outcome.json",
                {**staged, "status": "FRONTEND_STAGED", "readyState": "READY", "trafficAuthorized": False, "promotionAuthorized": False})
        def promote(client, _candidate, attempt, _verify, **_kwargs):
            subject.migrate.write_json(attempt, "frontend-promotion-started.json", {**staged, "previousAliasRequestedAt": 10})
            client.request("POST", "/v10/projects/owned/promote/dpl_Owned123", {})
            subject.migrate.write_json(attempt, "frontend-workload-outcome.json", {**staged, "status": "FRONTEND_VERIFIED",
                "contractPhase": "p2", "phase2ContractManifestSha256": candidate["phase2ContractManifestSha256"],
                "featureControls": controls, "writerAdmissionBinding": writer})

        project = {"targets": {"production": {"id": DEPLOYMENT}}, "crons": {"disabledAt": 1, "deploymentId": DEPLOYMENT,
            "definitions": [{"path": "/api/cron/account-lifecycle", "schedule": "* * * * *", "host": "owned.vercel.app"}]}}
        with mock.patch.object(subject.vercel, "Client", Provider), \
             mock.patch.object(subject.vercel, "release_identity", return_value=("staging", PROJECT, SOURCE)), \
             mock.patch.object(subject.vercel, "disable_schedules", side_effect=disable), \
             mock.patch.object(subject.vercel, "stage_frontend", side_effect=stage), \
             mock.patch.object(subject.vercel, "promote_frontend", side_effect=promote), \
             mock.patch.object(subject.vercel, "_staged_identity", return_value=staged), \
             mock.patch.object(subject.vercel, "deployment_state", return_value={"readyState": "READY", "url": "https://owned.vercel.app"}), \
             mock.patch.object(subject.vercel, "promotion_state", return_value={"cronsEnabled": False, "productionDeploymentId": DEPLOYMENT,
                 "aliasJob": {"jobStatus": "succeeded", "type": "promote", "toDeploymentId": DEPLOYMENT, "requestedAt": 11}}), \
             mock.patch.object(subject.vercel, "_project", return_value=project), \
             mock.patch.object(subject.frontend_probe, "prepare", side_effect=prepare):
            result = subject.deploy(context, lambda: checks.append("checked"))
        self.assertEqual(result["status"], "P2_PROFILED_CURRENT_FRONTEND_VERIFIED")
        self.assertEqual(len(checks), len(Provider.calls))
        intents = sorted((root / "vercel").glob("provider-mutation-intent-*.json"))
        self.assertEqual(len(intents), len([call for call in Provider.calls if call[0] in ("POST", "PATCH", "DELETE")]))


if __name__ == "__main__":
    unittest.main()
