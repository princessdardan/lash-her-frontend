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
from p2_certification_profile import PROFILE as CERTIFICATION_PROFILE


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
                 ("same-previous", [{**valid, "uid": "dpl_Previous123"}], "dpl_Previous123"),
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
        for key, name in (("deployStarted", "p2-profiled-current-deploy-started.json"),
                          ("buildIntent", "provider-mutation-intent-002.json")):
            with self.subTest(duplicate_key=key):
                initial, provider, attempt = self.lost_build_fixture()
                path = attempt / name; encoded = path.read_text().rstrip()
                path.write_text(encoded[:-1] + ',"version":2}\n')
                digest = subject.sha(path.read_bytes())
                initial["lostBuildReceiptSha256"][key] = digest
                initial["plan"]["lostBuildReceiptSha256"][key] = digest
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
        self.exercise_profiled_deploy()

    def test_replacement_deploy_preserves_apply_forward_proof_and_observes_without_mutations(self):
        self.exercise_profiled_deploy(replacement=True)

    def test_replacement_deploy_refuses_initial_alias_drift_before_any_provider_write(self):
        self.exercise_profiled_deploy(replacement=True, alias_drift="initial")

    def test_replacement_deploy_refuses_alias_drift_after_workload_check(self):
        self.exercise_profiled_deploy(replacement=True, alias_drift="workload")

    def exercise_profiled_deploy(self, replacement=False, alias_drift=None):
        root = self.private(); checks = []
        previous = "dpl_Previous123"
        controls = {name: name != "INTEGRATION_CHECKOUT_ENABLED" for name in subject.FEATURES}
        if replacement:
            controls = CERTIFICATION_PROFILE["featureControls"]
        runtime_role = subject.REPLACEMENT_ROLES[1] if replacement else "frontend_runtime"
        job_target = {"qualificationTargetProfile": PROFILE, "host": "db.example.com", "port": 5432,
                      "database": "frontend", "user": "operator", "runtimeRole": runtime_role, "serverMajor": 18,
                      "allowEmptyBootstrap": replacement, "approvedPendingTags": ["0001_owned"] if replacement else []}
        target_sha = subject.json_sha({"environment": "staging", **{key: job_target[key]
                                      for key in ("host", "port", "database", "user", "serverMajor")}})
        writer = {"mode": "enforce", "targetSha256": target_sha, "producerSha256": "c" * 64,
                  "sourceCommit": SOURCE, "roleName": runtime_role}
        gateway = {"owned": True}
        plan = {"version": 2, "qualificationTargetProfile": PROFILE, "environment": "staging", "actionId": "owned-release",
            "sourceCommit": SOURCE, "targetSha256": target_sha, "restoration": {"gatewayBindingSha256": subject.json_sha(gateway)}}
        candidate = {"version": 3, "qualificationTargetProfile": PROFILE, "environment": "staging", "releaseId": "owned-release",
            "contractPhase": "p2", "phase2ContractManifestSha256": "sha256:" + "d" * 64,
            "sourceApproval": {"qualificationTargetProfile": PROFILE}, "integration": {"qualificationTargetProfile": PROFILE},
            "approval": {"qualificationTargetProfile": PROFILE},
            "workload": {"qualificationTargetProfile": PROFILE, "projectId": PROJECT, "environment": "production"},
            "sources": {"frontend": {"commit": SOURCE, "qualificationTargetProfile": PROFILE, "requiredChecks": "passed",
                         "repository": "https://github.com/princessdardan/lash-her-frontend.git"},
                        **{service: {"qualificationTargetProfile": PROFILE} for service in ("course", "community")}},
            "frontendMigration": {"qualificationTargetProfile": PROFILE}}
        job = {"version": 2, "qualificationTargetProfile": PROFILE, "environment": "staging", "releaseId": "owned-release",
               "sourceCommit": SOURCE, "target": job_target}
        configuration = {name: str(index % 9 + 1) * 64 for index, name in enumerate(sorted(subject.CONFIGURATION_NAMES))}
        target = {"qualificationTargetProfile": PROFILE, "environment": "staging", "targetSha256": target_sha,
                  "host": "db.example.com", "port": 5432, "database": "frontend", "user": runtime_role, "serverMajor": 18}
        context = {"qualificationTargetProfile": PROFILE, "plan": plan, "candidate": candidate, "job": job,
            "candidateSha256": "e" * 64, "inventorySha256": subject.json_sha(plan), "configurationSha256": configuration,
            "directory": str(root), "vercelToken": "private-token", "bindings": {"gatewayObservation": gateway},
            "expectedFeatureControls": controls, "writerAdmissionBinding": writer, "bootstrapRuntimeTarget": target,
            "frontendRuntimeDatabaseUrl": f"postgresql://{runtime_role}:private@db.example.com/frontend?sslmode=verify-full"}
        if replacement:
            plan.update(owner={"name": subject.REPLACEMENT_ROLES[0], "oid": "17001"},
                        producers=[{"producerSha256": writer["producerSha256"], "role": {"name": runtime_role, "oid": "17002"}}],
                        runtimeProducerSha256=writer["producerSha256"], certification=CERTIFICATION_PROFILE,
                        configurationSha256=configuration, predecessorDeploymentId=previous)
            job.update(contractPhase=candidate["contractPhase"], phase2ContractManifestSha256=candidate["phase2ContractManifestSha256"])
            context.update(inventorySha256=subject.json_sha(plan), replacementProvenance={
                key: str(index + 1) * 64 for index, key in enumerate(sorted(subject.REPLACEMENT_PINS))})
        environment_rows, workload = [], []
        state = {"cronDisabled": False, "built": False, "promoted": False,
                 "alias": "dpl_OtherAlias" if alias_drift == "initial" else previous}

        class Provider:
            calls = []
            def __init__(self, _token): pass
            def request(self, method, path, body=None):
                self.calls.append((method, path, body))
                if method == "GET" and path in (f"/v9/projects/{PROJECT}", f"/v9/projects/{PROJECT}?rollbackInfo=true"):
                    return {"id": PROJECT, "accountId": subject.vercel.TEAM, "link": {"type": "github", "repoId": subject.vercel.REPOSITORY_ID},
                            "targets": {"production": {"id": DEPLOYMENT if state["promoted"] else state["alias"]}},
                            "crons": {"disabledAt": 1 if state["cronDisabled"] else None, "deploymentId": DEPLOYMENT,
                                      "definitions": [{"path": "/api/cron/account-lifecycle", "schedule": "* * * * *", "host": "owned.vercel.app"}]},
                            "lastAliasRequest": {"jobStatus": "succeeded", "type": "promote", "toDeploymentId": DEPLOYMENT,
                                                 "requestedAt": 11} if state["promoted"] else None,
                            "protectionBypass": {"fixture-bypass": {"scope": "automation-bypass"}}}
                if method == "PATCH" and path == f"/v1/projects/{PROJECT}/crons" and body == {"enabled": False}:
                    state["cronDisabled"] = True
                    return {}
                if method == "GET" and path == f"/v10/projects/{PROJECT}/env?decrypt=false":
                    return {"envs": environment_rows}
                if method == "POST" and path == f"/v10/projects/{PROJECT}/env?upsert=true":
                    environment_rows.append({"key": body["key"], "value": body["value"], "type": body["type"],
                                             "target": ["production"], "gitBranch": None, "customEnvironmentIds": []})
                    return {"failed": [], "created": environment_rows[-1]}
                if method == "POST" and path == "/v13/deployments" and not state["built"]:
                    state["built"] = True
                    return {"id": DEPLOYMENT}
                if method == "GET" and path == f"/v13/deployments/{DEPLOYMENT}?withGitRepoInfo=true" and state["built"]:
                    return {"id": DEPLOYMENT, "projectId": PROJECT, "url": "owned.vercel.app", "readyState": "READY",
                            "target": "production", "gitSource": {"type": "github", "repoId": subject.vercel.REPOSITORY_ID,
                                                                  "sha": SOURCE}, "meta": {"lashReleaseId": "owned-release"}}
                if method == "POST" and path == f"/v10/projects/{PROJECT}/promote/{DEPLOYMENT}" and workload and not state["promoted"]:
                    state["promoted"] = True
                    return {}
                raise AssertionError("unexpected provider operation")

        class Workload:
            def request(self, url, secret, bypass, challenge, mode=None):
                if (url, bypass, mode) != ("https://owned.vercel.app", "fixture-bypass", "phase2") or state["promoted"]:
                    raise AssertionError("workload was not checked before promotion")
                if not any(row["key"] == "LASH_RELEASE_PROBE_SECRET" and row["value"] == secret for row in environment_rows):
                    raise AssertionError("workload probe used a different credential")
                workload.append(challenge)
                if alias_drift == "workload":
                    state["alias"] = "dpl_OtherAlias"
                return {"version": 1, "status": "FRONTEND_WORKLOAD_PROBE_PASS", "challenge": challenge,
                        "checks": ["gateway-course-catalog-p2"], "contractPhase": "p2",
                        "featureControls": controls, "writerAdmissionBinding": writer, "gatewayOrigin": "https://api-staging.lashher.com",
                        "environment": "staging", "projectId": PROJECT, "sourceCommit": SOURCE}

        with mock.patch.object(subject.vercel, "Client", Provider), \
             mock.patch.object(subject.frontend_probe, "ProbeClient", Workload):
            if replacement:
                with self.assertRaisesRegex(ValueError, "PROFILED_CURRENT_ORIGINAL_JOB_REQUIRED"):
                    subject.deploy(context, lambda: self.fail("unexpected checkpoint"))
                self.assertEqual(Provider.calls, [])
                for supplied in ({**context, "replacementProvenance": {}}, {**context, "job": {**job,
                    "target": {**job_target, "allowEmptyBootstrap": False, "approvedPendingTags": []}}}):
                    with self.assertRaises(ValueError):
                        subject.deploy(supplied, lambda: self.fail("unexpected checkpoint"), replacement=True)
                self.assertEqual(Provider.calls, [])
            if alias_drift:
                error = ("PROFILED_REPLACEMENT_PREDECESSOR_CHANGED" if alias_drift == "initial" else
                         "VERCEL_PROJECT_CHANGED_BEFORE_PROMOTION")
                with self.assertRaisesRegex(ValueError, error):
                    subject.deploy(context, lambda: checks.append("checked"), replacement=True)
                writes = [(method, path) for method, path, _ in Provider.calls if method != "GET"]
                if alias_drift == "initial":
                    self.assertEqual(writes, [])
                else:
                    self.assertIn(("POST", "/v13/deployments"), writes)
                    self.assertFalse(any("/promote/" in path for _, path in writes))
                return
            result = subject.deploy(context, lambda: checks.append("checked"), replacement=replacement)
            if replacement:
                calls = list(Provider.calls)
                read_context = {key: value for key, value in context.items() if key != "frontendRuntimeDatabaseUrl"}
                self.assertEqual(subject.observe(read_context, lambda: checks.append("checked"), replacement=True), result)
                self.assertTrue(all(call[0] == "GET" for call in Provider.calls[len(calls):]))
                wrong_plan = {**plan, "predecessorDeploymentId": "dpl_OtherAlias"}
                with self.assertRaisesRegex(ValueError, "PROFILED_REPLACEMENT_PREDECESSOR_CHANGED"):
                    subject.observe({**read_context, "plan": wrong_plan, "inventorySha256": subject.json_sha(wrong_plan)},
                                    lambda: self.fail("unbound readback checkpoint"), replacement=True)
                saved = (root / "vercel" / "frontend-promotion-outcome.json").read_bytes()
                self.assertEqual(result["frontendPromotionReceiptSha256"], subject.sha(saved))
                self.assertTrue(result["frontendSqlApplied"])
                self.assertFalse(result["frontendSqlReplayed"])
                for key, value in context["replacementProvenance"].items():
                    self.assertEqual(result[key], value)
                self.assertEqual([(body["key"], body["value"], body["type"]) for _, path, body in Provider.calls
                    if "/env?upsert=true" in path and body["key"] in ("DATABASE_URL", "FRONTEND_WRITER_ADMISSION_DATABASE_URL")],
                    [("FRONTEND_WRITER_ADMISSION_DATABASE_URL", context["frontendRuntimeDatabaseUrl"], "sensitive"),
                     ("DATABASE_URL", context["frontendRuntimeDatabaseUrl"], "sensitive")])
        self.assertEqual(result["status"], subject.REPLACEMENT_STATUS if replacement else "P2_PROFILED_CURRENT_FRONTEND_VERIFIED")
        self.assertEqual(len(workload), 1)
        self.assertEqual([path for method, path, _ in Provider.calls if method == "POST" and
                          (path == "/v13/deployments" or "/promote/" in path)],
                         ["/v13/deployments", f"/v10/projects/{PROJECT}/promote/{DEPLOYMENT}"])
        build = next(body for _, path, body in Provider.calls if path == "/v13/deployments")
        self.assertEqual(build["gitSource"]["sha"], SOURCE)
        self.assertFalse(build["autoAssignCustomDomains"])
        self.assertEqual(len(checks), len(Provider.calls))
        intents = sorted((root / "vercel").glob("provider-mutation-intent-*.json"))
        self.assertEqual(len(intents), len([call for call in Provider.calls if call[0] in ("POST", "PATCH", "DELETE")]))


if __name__ == "__main__":
    unittest.main()
