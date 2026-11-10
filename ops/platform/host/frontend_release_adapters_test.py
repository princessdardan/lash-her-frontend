from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import subprocess
import hashlib
import hmac
from pathlib import Path
import re
import socket
import ssl
import tempfile
import threading
import unittest
from unittest.mock import patch

import frontend_probe
import frontend_release_adapters as adapter
import frontend_resend_retirement
import frontend_square_retirement
import frontend_google_fencing
import migrate
import vercel
import vercel_test


class ConcreteFrontendAdapterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        vercel_test.VercelControlTests.setUpClass()

    @classmethod
    def tearDownClass(cls):
        vercel_test.VercelControlTests.tearDownClass()

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        root = Path(self.directory.name).resolve()
        self.parent, self.private = root / "receipts", root / "private"
        self.parent.mkdir(mode=0o700); self.private.mkdir(mode=0o700)
        self.calls, self.variables, self.verify_calls = [], {}, 0
        self.current, self.disabled, self.alias = "dpl_previous", True, None
        self.lost_promotion, self.lost_lock, self.fail_lock_after_build, self.ignore_pin = False, False, False, False
        self.lost_build, self.failed_build = False, False
        self.bootstrap_probe_wrong = False
        self.lost_delete, self.historical_source_wrong, self.switch_current_after_delete = False, False, False
        self.previous = {"uid": "dpl_previous", "state": "READY", "target": "production", "created": 20,
                         "url": "previous.vercel.app", "meta": {"githubCommitSha": "b" * 40}}
        self.failed = {"uid": "dpl_error", "state": "ERROR", "target": None, "created": 10,
                       "url": "failed.vercel.app", "meta": {"githubCommitSha": "c" * 40}}
        self.deployments = [self.previous, self.failed]
        self.related_deployments, self.related_current, self.related_disabled = [], "dpl_production", False
        self.built_features, self.built_crons, self.built_writer, self.probed_deployment = {}, {}, {}, None
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    body = json.loads(self.rfile.read(length)) if length else None
                    owner.calls.append({"method": self.command, "path": self.path, "body": body})
                    path = self.path.split("?", 1)[0]
                    if path == "/api/internal/release-probe":
                        owner.assertEqual(self.headers.get("Authorization"), "Bearer " + owner.variables["LASH_RELEASE_PROBE_SECRET"]["value"])
                        owner.assertEqual(self.headers.get("x-vercel-protection-bypass"), "owned-bypass-marker")
                        result = {"version": 1, "status": "FRONTEND_WORKLOAD_PROBE_PASS", "challenge": self.headers.get("x-lash-release-challenge"),
                                  "checks": ["gateway-course-catalog"], "gatewayOrigin": "https://gateway.example.invalid",
                                  "environment": "staging", "projectId": vercel.PROJECTS["staging"], "sourceCommit": "a" * 40}
                        if self.headers.get("x-lash-release-mode") == "phase2":
                            result.update(contractPhase="p2", checks=["gateway-course-catalog-p2"],
                                featureControls=owner.built_features[owner.probed_deployment], writerAdmissionBinding=owner.built_writer[owner.probed_deployment])
                        if self.headers.get("x-lash-release-mode") in ("admission-bootstrap", "resend-binding", "square-binding", "google-binding"):
                            result.update(checks=["gateway-course-catalog", "frontend-admission-bootstrap"],
                                schemaCatalogSha256="f" * 64 if owner.bootstrap_probe_wrong else owner.context["preapplicationSchema"]["schemaCatalogSha256"],
                                featureControls={key: False for key in adapter.BOOTSTRAP_FLAGS}, admission={"environment": "staging",
                                    "targetSha256": owner.context["plan"]["targetSha256"], "producerSha256": "5" * 64,
                                    "sourceCommit": "a" * 40, "epoch": "1", "newWork": False, "recovery": False})
                            if self.headers.get("x-lash-release-mode") == "resend-binding":
                                selected = owner.context["bindings"]["resendRetirement"]
                                observed = frontend_resend_retirement.domain(frontend_resend_retirement.Client(owner.variables["RESEND_API_KEY"]["value"]), selected)
                                result["checks"].append("resend-binding")
                                result["resendBinding"] = observed
                            if self.headers.get("x-lash-release-mode") == "square-binding":
                                selected = owner.context["bindings"]["squareRetirement"]
                                observed = frontend_square_retirement.binding(frontend_square_retirement.Client(owner.variables["SQUARE_ACCESS_TOKEN"]["value"]), selected)
                                result["checks"].append("square-binding")
                                result["squareBinding"] = {"environment": "sandbox", "applicationId": selected["applicationId"], **observed}
                            if self.headers.get("x-lash-release-mode") == "google-binding":
                                result["checks"].append("google-binding")
                                result["googleBinding"] = {"projectId": "lash-her-staging-20261022", "projectNumber": "185770842371"}
                                for kind, prefix in (("identity", "AUTH_GOOGLE"), ("calendar", "GOOGLE_CLIENT")):
                                    proof = hmac.new(owner.variables[prefix + "_SECRET"]["value"].encode(),
                                        ("lash-her:frontend-google-binding:v1:" + kind + ":" + result["challenge"]).encode(), hashlib.sha256).hexdigest()
                                    result["googleBinding"][kind] = {"clientId": frontend_google_fencing.CLIENTS[kind], "proof": proof}
                                default_calendar = owner.variables.get("GOOGLE_CALENDAR_ID", {}).get("value")
                                result["googleBinding"]["calendar"]["calendarIdSha256"] = hashlib.sha256(default_calendar.encode()).hexdigest() if default_calendar else None
                        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Cache-Control", "no-store")
                        self.end_headers(); self.wfile.write(json.dumps(result).encode()); return
                    owner.assertEqual(self.headers.get("Authorization"), "Bearer owned-token-marker")
                    if path == "/v9/projects":
                        result = {"projects": [{"id": project, "accountId": vercel.TEAM, "link": {"type": "github", "repoId": vercel.REPOSITORY_ID}}
                            for project in (vercel.PROJECTS["staging"], vercel.PROJECTS["production"])], "pagination": {"count": 2, "next": None}}
                    elif path.startswith("/v9/projects/"):
                        related = path == "/v9/projects/" + vercel.PROJECTS["production"]
                        result = {"id": vercel.PROJECTS["production"] if related else vercel.PROJECTS["staging"], "accountId": vercel.TEAM,
                                  "link": {"type": "github", "repoId": vercel.REPOSITORY_ID},
                                  "targets": {"production": {"id": owner.related_current if related else owner.current}},
                                  "crons": {"disabledAt": 10 if (owner.related_disabled if related else owner.disabled) else None},
                                  "protectionBypass": {"owned-bypass-marker": {"scope": "automation-bypass"}},
                                  "env": [{"value": "provider-private-marker"}]}
                        if not related and owner.current in owner.built_crons:
                            result["crons"].update(deploymentId=owner.current, definitions=owner.built_crons[owner.current])
                        if not related and owner.alias is not None and "rollbackInfo=true" in self.path:
                            result["lastAliasRequest"] = owner.alias
                    elif path == "/v7/deployments":
                        rows = owner.related_deployments if "projectId=" + vercel.PROJECTS["production"] in self.path else owner.deployments
                        result = {"deployments": rows, "pagination": {"count": len(rows), "next": None}}
                    elif path == "/v13/deployments" and self.command == "POST":
                        owner.assertEqual(body["gitSource"]["sha"], "a" * 40); owner.assertEqual(body["gitSource"]["ref"], "staging")
                        owner.assertFalse(body["autoAssignCustomDomains"])
                        deployment_id = "dpl_candidate" + (str(len([row for row in owner.deployments if row["uid"].startswith("dpl_candidate")]) + 1)
                            if any(row["uid"].startswith("dpl_candidate") for row in owner.deployments) else "")
                        owner.deployments.append({"uid": deployment_id, "state": "ERROR" if owner.failed_build else "READY", "target": "production", "created": 30,
                                                  "url": "owned.vercel.app", "meta": {"githubCommitSha": "a" * 40}})
                        owner.built_features[deployment_id] = {key: owner.variables.get(key, {}).get("value") == "true" for key in adapter.BOOTSTRAP_FLAGS}
                        target = json.loads(owner.variables.get("FRONTEND_WRITER_ADMISSION_TARGET_JSON", {}).get("value", "{}"))
                        owner.built_writer[deployment_id] = {"mode": "enforce", "targetSha256": target.get("targetSha256"),
                            "producerSha256": owner.variables.get("FRONTEND_WRITER_PRODUCER_SHA256", {}).get("value"),
                            "sourceCommit": "a" * 40, "roleName": target.get("user")} if owner.variables.get("FRONTEND_WRITER_ADMISSION_MODE", {}).get("value") == "enforce" else None
                        owner.built_crons[deployment_id] = ([{"host": "owned.vercel.app", "path": "/api/cron/account-lifecycle", "schedule": "* * * * *"}]
                            if owner.variables.get("LASH_P2_CERTIFICATION_SCHEDULES", {}).get("value") == "account-lifecycle" else [])
                        if owner.lost_build:
                            self.connection.shutdown(socket.SHUT_RDWR); self.connection.close(); return
                        result = {"id": deployment_id}
                    elif path.startswith("/v13/deployments/") and self.command == "DELETE":
                        deployment_id = path.rsplit("/", 1)[-1]
                        if any(row["uid"] == deployment_id for row in owner.related_deployments):
                            owner.related_deployments = [row for row in owner.related_deployments if row["uid"] != deployment_id]
                        else:
                            owner.assertTrue(any(row["uid"] == deployment_id for row in owner.deployments))
                            owner.deployments = [row for row in owner.deployments if row["uid"] != deployment_id]
                        if owner.switch_current_after_delete:
                            owner.current = "dpl_previous"
                        if owner.lost_delete:
                            self.connection.shutdown(socket.SHUT_RDWR); self.connection.close(); return
                        result = {"state": "DELETED", "uid": deployment_id}
                    elif path.startswith("/v13/deployments/"):
                        deployment_id = path.rsplit("/", 1)[-1]
                        source = "a" * 40 if deployment_id.startswith("dpl_candidate") else "c" * 40 if deployment_id == "dpl_error" else "b" * 40
                        if deployment_id == "dpl_error" and owner.historical_source_wrong:
                            source = "f" * 40
                        related_row = next((row for row in owner.related_deployments if row["uid"] == deployment_id), None)
                        if related_row:
                            source = related_row["meta"]["githubCommitSha"]
                        result = {"id": deployment_id, "projectId": vercel.PROJECTS["production"] if related_row else vercel.PROJECTS["staging"],
                                  "target": related_row["target"] if related_row else "production",
                                  "readyState": next((row["state"] for row in owner.deployments if row["uid"] == deployment_id), "READY"),
                                  "url": "owned.vercel.app", "gitSource": {"type": "github", "repoId": vercel.REPOSITORY_ID, "sha": source},
                                  "meta": {"lashReleaseId": "adapter-owned"}}
                        owner.probed_deployment = deployment_id
                        if owner.fail_lock_after_build and deployment_id == "dpl_candidate":
                            owner.lost_lock = True
                    elif path.endswith("/env") and self.command == "POST":
                        if not owner.ignore_pin:
                            owner.variables[body["key"]] = dict(body)
                        result = {"failed": [], "created": dict(body)}
                    elif path.endswith("/env"):
                        result = {"envs": list(owner.variables.values())}
                    elif path.endswith("/crons") and self.command == "PATCH":
                        owner.disabled = not body["enabled"]; result = {}
                    elif "/promote/" in path and self.command == "POST":
                        owner.current = path.rsplit("/", 1)[-1]
                        owner.alias = {"jobStatus": "succeeded", "requestedAt": 200 if owner.alias is None else owner.alias["requestedAt"] + 100,
                            "toDeploymentId": owner.current, "type": "promote"}
                        if owner.lost_promotion:
                            self.connection.shutdown(socket.SHUT_RDWR); self.connection.close(); return
                        result = {}
                    else:
                        raise ValueError("OWNED_UNEXPECTED_REQUEST")
                    self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
                    self.wfile.write(json.dumps(result).encode())
                except (BrokenPipeError, ssl.SSLError):
                    pass
                except BaseException:
                    self.send_response(500); self.end_headers()

            do_POST = do_GET
            do_PATCH = do_GET
            do_DELETE = do_GET

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(vercel_test.VercelControlTests.cert, vercel_test.VercelControlTests.key)
        self.server.socket = tls.wrap_socket(self.server.socket, server_side=True)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        self.origin = f"https://127.0.0.1:{self.server.server_port}"
        self.api_patch = patch.object(vercel, "API_ORIGIN", self.origin); self.api_patch.start()
        tls_client = ssl.create_default_context(cafile=str(vercel_test.VercelControlTests.cert))
        with patch.object(vercel.ssl, "create_default_context", return_value=tls_client):
            self.client = vercel.Client("owned-token-marker"); self.probe_client = frontend_probe.ProbeClient()
        self.context = {"operation": "observe-vercel", "directory": str(self.parent), "privateConfigurationDirectory": str(self.private),
                        "gatewayHost": "gateway.example.invalid", "plan": {"environment": "staging", "actionId": "adapter-owned", "sourceCommit": "a" * 40, "targetSha256": "b" * 64},
                        "candidate": {"version": 2, "environment": "staging", "releaseId": "adapter-owned", "workload": {"projectId": vercel.PROJECTS["staging"], "environment": "production"},
                                      "sources": {"frontend": {"repository": "https://github.com/princessdardan/lash-her-frontend.git", "requiredChecks": "passed", "commit": "a" * 40}}},
                        "bindings": {"environment": "staging", "actionId": "adapter-owned", "sourceCommit": "a" * 40, "targetSha256": "b" * 64,
                                     "projectId": vercel.PROJECTS["staging"], "teamId": vercel.TEAM, "repositoryId": vercel.REPOSITORY_ID,
                                     "gatewayHost": "gateway.example.invalid",
                                     "projectState": {"productionDeploymentId": "dpl_previous", "nativeSchedulesEnabled": False},
                                     "deployments": sorted([adapter.deployment_metadata(row) for row in self.deployments], key=lambda row: row["deploymentId"])},
                        "admissionObservation": {"epoch": "1", "ledgerDrained": True, "newWork": False, "recovery": False, "active": 0, "uncertain": 0}}
        self.database = {"version": 1, "service": "frontend", "environment": "staging", "releaseId": "adapter-owned", "sourceCommit": "a" * 40,
                         "migrationImageDigest": "sha256:" + "b" * 64, "sqlArtifactSha256": "c" * 64, "schemaBaselineSha256": "d" * 64,
                         "contractManifestSha256": "sha256:" + "e" * 64, "target": {"host": "owned.invalid", "port": 5432, "database": "owned", "user": "operator", "serverMajor": 18}, "after": [], "applied": [],
                         "status": "DATABASE_VERIFIED", "migrationMode": "apply-forward", "schemaVerified": True, "runtimeRoleVerified": True}
        self.context["database"] = self.database
        target_hash = migrate.file_hash(json.dumps({"environment": "staging", **self.database["target"]}, separators=(",", ":")).encode())
        self.context["plan"]["targetSha256"] = target_hash; self.context["bindings"]["targetSha256"] = target_hash

    def tearDown(self):
        self.api_patch.stop(); self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=2); self.directory.cleanup()

    def verify(self):
        self.verify_calls += 1
        if self.lost_lock:
            raise ValueError("OWNED_PARENT_LOCK_LOST")

    def mapped_probe(self):
        owner = self
        class MappedProbe:
            def request(self, url, *args, **kwargs):
                owner.assertEqual(url, "https://owned.vercel.app")
                with patch.object(frontend_probe, "DEPLOYMENT_URL", re.compile(re.escape(owner.origin))):
                    return owner.probe_client.request(owner.origin, *args, **kwargs)
        return MappedProbe()

    def bootstrap_context(self):
        compatibility = {"version": 1, "schemaCatalogSha256": "6" * 64, "appliedLineageSha256": "7" * 64,
            "appliedCount": 80, "validationEvidenceSha256": "8" * 64, "runtimeProducerSha256": "5" * 64,
            "recoveryAfterCompatibleBuild": False}
        self.context["plan"]["bootstrapCompatibility"] = compatibility
        self.context["preapplicationSchema"] = {"version": 1, "service": "frontend", "environment": "staging", "actionId": "adapter-owned",
            "sourceCommit": "a" * 40, "targetSha256": self.context["plan"]["targetSha256"], "status": "FRONTEND_PREAPPLICATION_SCHEMA_VERIFIED",
            **{key: compatibility[key] for key in ("schemaCatalogSha256", "appliedLineageSha256", "appliedCount", "validationEvidenceSha256")},
            "applicationSqlApplied": False, "migrationAuthorized": False, "trafficAuthorized": False}
        self.context["writerTarget"] = {"environment": "staging", "targetSha256": self.context["plan"]["targetSha256"],
            "host": "owned.invalid", "port": 5432, "database": "owned", "user": "runtime", "serverMajor": 18}
        self.context["frontendRuntimeDatabaseUrl"] = "postgresql://runtime:owned-runtime-marker@owned.invalid/owned?sslmode=verify-full"
        migrate.write_json(self.parent, "frontend-preapplication-schema.json", self.context["preapplicationSchema"])

    def execute(self, operation):
        self.context["operation"] = operation
        return adapter.execute(self.context, self.client, self.verify, self.mapped_probe())

    def mutations(self):
        return [row for row in self.calls if row["method"] != "GET"]

    def test_metadata_paginates_twice_and_never_claims_callback_or_credentials_drain(self):
        result = self.execute("observe-vercel")
        self.assertEqual(result["status"], "VERCEL_STAGING_METADATA_OBSERVED")
        self.assertTrue(result["projectPaginationComplete"]); self.assertTrue(result["reviewedInventoryMatches"])
        self.assertIsNone(result["activeExecutions"]); self.assertIsNone(result["uncertainEffects"])
        self.assertFalse(result["historicalWritersFenced"]); self.assertFalse(result["providerBindingsVerified"])
        self.assertEqual(len([row for row in self.calls if row["path"].startswith("/v7/")]), 2)
        self.assertGreaterEqual(self.verify_calls, len(self.calls) * 2)
        self.assertFalse(self.mutations()); self.assertNotIn("provider-private-marker", json.dumps(result))

    def test_unreviewed_deployment_or_project_drift_is_observed_but_refuses_mutation(self):
        self.deployments.append({"uid": "dpl_unknown", "state": "READY", "target": None, "created": 1, "url": "unknown.vercel.app", "meta": {"githubCommitSha": "f" * 40}})
        self.assertFalse(self.execute("observe-vercel")["reviewedInventoryMatches"])
        with self.assertRaisesRegex(ValueError, "VERCEL_REVIEWED_INVENTORY_CHANGED"):
            self.execute("suspend-schedules")
        self.assertFalse(self.mutations())

    def test_actual_schedule_disable_has_readback_and_retains_unknown_running_effects(self):
        self.disabled = False; self.context["bindings"]["projectState"]["nativeSchedulesEnabled"] = True
        result = self.execute("suspend-schedules")
        self.assertEqual(result["status"], "NATIVE_SCHEDULES_DISABLED"); self.assertFalse(result["nativeSchedulesEnabled"])
        self.assertFalse(result["historicalWritersFenced"]); self.assertIsNone(result["activeExecutions"])
        self.assertEqual([row["method"] for row in self.mutations()], ["PATCH"])

    def test_real_existing_build_probe_and_promotion_compose_under_parent_checkpoints(self):
        migrate.write_json(self.parent, "database-receipt.json", self.database)
        result = self.execute("deploy-compatible")
        self.assertEqual(result["status"], "FRONTEND_DOMAINS_PROMOTED"); self.assertEqual(self.current, "dpl_candidate")
        observed = self.execute("observe-compatible")
        self.assertTrue(observed["workloadVerified"]); self.assertTrue(observed["aliasJobMatchesIntent"])
        self.assertEqual(observed["aliasJobDeploymentId"], "dpl_candidate"); self.assertFalse(observed["admissionNewWork"])
        self.assertTrue(any(row["path"] == "/api/internal/release-probe" for row in self.calls))
        self.assertGreaterEqual(self.verify_calls, len(self.calls) * 2)
        common = "".join(path.read_text() for path in self.parent.rglob("*.json"))
        for value in ["owned-token-marker", "owned-bypass-marker", "provider-private-marker", self.variables["LASH_RELEASE_PROBE_SECRET"]["value"]]:
            self.assertTrue(value not in common)
        self.assertTrue(self.disabled)

    def test_reviewed_p2_feature_profile_is_installed_before_build_and_actual_probe_matches(self):
        self.bootstrap_context()
        pair = {"contractPhase": "p2", "phase2ContractManifestSha256": "sha256:" + "9" * 64}
        self.context["candidate"].update(pair); self.database.update(pair)
        self.context["plan"]["certification"] = adapter.p2_certification_profile.PROFILE
        self.execute("deploy-admission")
        migrate.write_json(self.parent, "database-receipt.json", self.database)
        self.assertEqual(self.execute("deploy-compatible")["status"], "FRONTEND_DOMAINS_PROMOTED")
        observed = self.execute("observe-compatible")
        self.assertTrue(observed["workloadVerified"])
        self.assertEqual(observed["featureControls"], adapter.p2_certification_profile.FEATURE_CONTROLS)
        self.assertTrue(self.disabled)
        self.assertEqual(self.variables["LASH_P2_CERTIFICATION_SCHEDULES"]["value"], "account-lifecycle")
        receipt = migrate.read_json(self.parent / "vercel", "frontend-workload-outcome.json")
        self.assertEqual(receipt["featureControls"], observed["featureControls"])
        self.assertEqual(receipt["contractPhase"], "p2")
        self.assertFalse(any(row["method"] == "PATCH" for row in self.calls))
        self.assertEqual(observed["certificationSchedule"]["path"], "/api/cron/account-lifecycle")
        self.assertFalse(observed["certificationSchedule"]["nativeEnabled"])
        self.assertEqual(observed["writerAdmissionBinding"], adapter.compatible_writer_admission_binding(self.context))
        self.assertEqual(observed["configurationRecordSha256"], observed["workloadReceiptSha256"])
        actual_writer = dict(self.built_writer[observed["deploymentId"]])
        self.built_writer[observed["deploymentId"]]["roleName"] = "wrong_role"
        # A later project env edit is not the immutable built/probed binding.
        self.assertEqual(self.execute("observe-compatible")["writerAdmissionBinding"], actual_writer)
        self.built_writer[observed["deploymentId"]] = actual_writer
        self.variables["LASH_P2_CERTIFICATION_SCHEDULES"]["value"] = "off"
        self.assertEqual(self.execute("observe-compatible")["certificationSchedule"], observed["certificationSchedule"])
        self.built_crons[observed["deploymentId"]].append({"host": "owned.vercel.app", "path": "/api/cron/highlevel-sync", "schedule": "* * * * *"})
        with self.assertRaisesRegex(ValueError, "P2_EXACT_DEPLOYMENT_LIFECYCLE_SCHEDULE_REQUIRED"):
            self.execute("observe-compatible")

    def test_existing_admission_new_action_configures_explicit_reviewed_runtime_producer_before_final_build(self):
        self.bootstrap_context()
        del self.context["plan"]["bootstrapCompatibility"]
        self.context["plan"]["runtimeProducerSha256"] = "4" * 64
        self.context["plan"]["certification"] = adapter.p2_certification_profile.PROFILE
        pair = {"contractPhase": "p2", "phase2ContractManifestSha256": "sha256:" + "9" * 64}
        self.context["candidate"].update(pair); self.database.update(pair)
        self.variables["FRONTEND_WRITER_ADMISSION_MODE"] = {"key": "FRONTEND_WRITER_ADMISSION_MODE", "value": "off", "type": "plain", "target": ["production"]}
        migrate.write_json(self.parent, "database-receipt.json", self.database)
        self.assertEqual(self.execute("deploy-compatible")["status"], "FRONTEND_DOMAINS_PROMOTED")
        observed = self.execute("observe-compatible")
        self.assertEqual(observed["writerAdmissionBinding"]["producerSha256"], "4" * 64)
        self.assertEqual(observed["writerAdmissionBinding"]["roleName"], "runtime")
        self.assertEqual(self.variables["FRONTEND_WRITER_ADMISSION_MODE"]["value"], "enforce")
        self.assertEqual(self.variables["DATABASE_URL"]["value"], self.context["frontendRuntimeDatabaseUrl"])
        self.assertTrue(observed["workloadVerified"])

    def test_p2_bootstrap_keeps_all_features_false_before_post_sql_certification(self):
        self.bootstrap_context()
        pair = {"contractPhase": "p2", "phase2ContractManifestSha256": "sha256:" + "9" * 64}
        self.context["candidate"].update(pair); self.database.update(pair)
        self.context["plan"]["certification"] = adapter.p2_certification_profile.PROFILE
        self.assertEqual(self.execute("deploy-admission")["status"], "FRONTEND_DOMAINS_PROMOTED")
        observed = self.execute("observe-admission")
        self.assertTrue(observed["bootstrapAdmissionVerified"])
        self.assertTrue(observed["workloadVerified"])
        self.assertEqual(observed["featureControls"], {key: False for key in adapter.BOOTSTRAP_FLAGS})
        for key in adapter.BOOTSTRAP_FLAGS:
            self.assertEqual(self.variables[key]["value"], "false")

    def test_certification_cannot_enable_an_unreviewed_feature_profile_or_p1_release(self):
        self.context["plan"]["certification"] = adapter.p2_certification_profile.PROFILE
        with self.assertRaisesRegex(ValueError, "P2_CERTIFICATION_CONTRACT_REQUIRED"):
            adapter.compatible_feature_controls(self.context)
        self.context["candidate"].update(contractPhase="p2", phase2ContractManifestSha256="sha256:" + "9" * 64)
        self.context["plan"]["certification"] = {**adapter.p2_certification_profile.PROFILE,
            "featureControls": {**adapter.p2_certification_profile.FEATURE_CONTROLS, "INTEGRATION_CHECKOUT_ENABLED": True}}
        with self.assertRaisesRegex(ValueError, "P2_CERTIFICATION_PROFILE_REFUSED"):
            adapter.compatible_feature_controls(self.context)
        self.assertFalse(self.mutations())

    def test_preapplication_schema_build_configures_closed_admission_and_uses_actual_protected_probe(self):
        self.bootstrap_context(); result = self.execute("deploy-admission")
        self.assertEqual(result["status"], "FRONTEND_DOMAINS_PROMOTED")
        observed = self.execute("observe-admission")
        self.assertTrue(observed["bootstrapAdmissionVerified"]); self.assertTrue(observed["aliasJobMatchesIntent"])
        self.assertEqual(observed["schemaCatalogSha256"], "6" * 64)
        self.assertTrue(all(self.variables[key]["value"] == "false" for key in adapter.BOOTSTRAP_FLAGS))
        self.assertEqual(self.variables["FRONTEND_WRITER_ADMISSION_MODE"]["value"], "enforce")
        self.assertEqual(self.variables["LASH_P2_CERTIFICATION_SCHEDULES"]["value"], "off")
        pins = migrate.read_json(self.parent / "vercel-bootstrap", "source-pins-outcome.json")
        self.assertEqual(pins["receiptKind"], "verified-preapplication-schema-only")
        common = "".join(path.read_text() for path in self.parent.rglob("*.json"))
        self.assertNotIn("owned-runtime-marker", common); self.assertFalse((self.parent / "database-receipt.json").exists())
        self.assertTrue(self.execute("observe-vercel")["reviewedInventoryMatches"])
        # The later post-SQL build is independent and preserves both actions'
        # original staging/probe/promotion evidence.
        migrate.write_json(self.parent, "database-receipt.json", self.database)
        self.assertEqual(self.execute("deploy-compatible")["status"], "FRONTEND_DOMAINS_PROMOTED")
        self.assertEqual(self.current, "dpl_candidate2")
        self.assertTrue(self.execute("observe-vercel")["reviewedInventoryMatches"])

    def test_preapplication_receipt_or_runtime_schema_probe_mismatch_cannot_promote(self):
        self.bootstrap_context(); (self.parent / "frontend-preapplication-schema.json").unlink()
        with self.assertRaises(OSError):
            self.execute("deploy-admission")
        self.assertFalse(self.mutations())
        migrate.write_json(self.parent, "frontend-preapplication-schema.json", self.context["preapplicationSchema"])
        self.bootstrap_probe_wrong = True
        with self.assertRaises(ValueError):
            self.execute("deploy-admission")
        self.assertEqual(self.current, "dpl_previous")
        self.assertFalse(any("/promote/" in row["path"] for row in self.mutations()))
        self.assertFalse(migrate.read_json(self.parent / "vercel-bootstrap", "frontend-workload-outcome.json")["bootstrapAdmissionVerified"])

    def test_terminal_original_build_requires_ack_chain_and_current_provider_terminal_state(self):
        migrate.write_json(self.parent, "database-receipt.json", self.database); self.failed_build = True
        with self.assertRaisesRegex(ValueError, "VERCEL_BUILD_FAILED_REQUIRES_REVIEW"):
            self.execute("deploy-compatible")
        original = {path: path.read_bytes() for path in self.parent.rglob("*.json")}
        recovery = self.parent.parent / "recovery"; recovery.mkdir(mode=0o700)
        self.context.update(originalDirectory=str(self.parent), directory=str(recovery))
        writes = len(self.mutations())
        inventory = self.execute("observe-vercel")
        self.assertTrue(inventory["reviewedInventoryMatches"])
        self.assertEqual([row["deploymentId"] for row in inventory["knownTerminalActionBuilds"]], ["dpl_candidate"])
        self.assertFalse(self.execute("observe-compatible")["workloadVerified"])
        row = next(row for row in self.deployments if row["uid"] == "dpl_candidate")
        row["state"] = "CANCELED"
        self.assertTrue(self.execute("observe-vercel")["reviewedInventoryMatches"])
        row["state"] = "BUILDING"
        self.assertFalse(self.execute("observe-vercel")["reviewedInventoryMatches"])
        row["state"] = "ERROR"
        self.current = "dpl_candidate"
        inventory = self.execute("observe-vercel")
        self.assertFalse(inventory["reviewedInventoryMatches"])
        self.assertFalse(inventory["reviewedProjectMatches"])
        self.current = "dpl_previous"
        created_path = self.parent / "vercel" / "frontend-build-created.json"
        created = json.loads(created_path.read_bytes()); created["deploymentId"] = "dpl_unrelated"
        created_path.write_text(json.dumps(created))
        with self.assertRaisesRegex(ValueError, "VERCEL_TERMINAL_BUILD_RECEIPT_REFUSED"):
            self.execute("observe-vercel")
        created_path.write_bytes(original[created_path])
        self.assertTrue(self.execute("observe-vercel")["reviewedInventoryMatches"])
        self.assertEqual(len(self.mutations()), writes)
        for path, raw in original.items():
            self.assertEqual(path.read_bytes(), raw)

    def test_bootstrap_lost_promotion_is_observed_readonly_without_sql_or_reopening_controls(self):
        self.bootstrap_context(); self.lost_promotion = True
        with self.assertRaises(ValueError):
            self.execute("deploy-admission")
        original = {str(path): path.read_bytes() for path in self.parent.rglob("*.json")}
        recovery = self.parent.parent / "recovery"; recovery.mkdir(mode=0o700)
        self.context["originalDirectory"] = str(self.parent); self.context["directory"] = str(recovery)
        writes = len(self.mutations()); observed = self.execute("observe-compatible")
        self.assertIsNone(observed["deploymentId"])
        self.assertTrue(observed["bootstrapFrontend"]["aliasJobMatchesIntent"])
        self.assertTrue(observed["bootstrapFrontend"]["bootstrapAdmissionVerified"])
        self.assertEqual(len(self.mutations()), writes); self.assertFalse((self.parent / "database-receipt.json").exists())
        for path, raw in original.items():
            self.assertEqual(Path(path).read_bytes(), raw)

    def retirement_plan(self):
        self.context["bindings"]["deploymentRetirement"] = {"preserveBootstrapDeployment": True,
            "retireDeploymentIds": ["dpl_error", "dpl_previous"], "preserveDeploymentIds": []}

    def test_actual_c07_source_context_drives_all_fixed_scoped_helpers_without_unrelated_provider_credentials(self):
        import frontend_square_financial_scope as square
        import frontend_resend_marketing_scope as resend
        import frontend_highlevel_history as highlevel
        import frontend_chitchats_transient_effects as chitchats
        root = Path(__file__).resolve().parents[3]
        output = self.parent / "owned-source-context.json"
        subprocess.run([os.environ.get("NODE_BINARY", "node"),
            str(root / "docs/api-integration/baselines/2026-11-05-resend-closure-review/create-owned-source-context.mjs"),
            str(root / "ops/platform/frontend-historical-source.mjs"), str(root), str(output)],
            check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        source = json.loads(output.read_text())["requirements"]
        recovery = self.parent.parent / "scope-recovery"; recovery.mkdir(mode=0o700)
        original_source_bytes = output.read_bytes()
        groups = {"square": square.COLUMN_NAMES, "resend": resend.COLUMNS, "highlevel": highlevel.COLUMNS, "chitchats": chitchats.COLUMNS}
        for provider, columns in groups.items():
            with self.subTest(provider=provider):
                rows = {key: [] for key in columns}
                if provider == "highlevel":
                    rows["historyGlobalScope"] = [{"contacts": 0, "effects": 0, "connections": 0, "webhooks": 0}]
                scope = {"provider": provider, **{key: source[key] for key in ("surfaceSha256", "sourceCommit", "sourceInventorySha256", "requirementsSha256")}, "scope": {}}
                self.context["bindings"]["providerEffectScopes"] = [scope]
                self.context.update(providerEffectScope=scope, scopedSourceRequirements=source, scopedActual=rows, scopedBefore=rows)
                digest = square.sha256(rows)
                common = {"environment": "staging", "sourceBindingSha256": source["configurationRecordSha256"]}
                if provider == "square":
                    reviewed = {**common, "environment": "sandbox", "locationId": square.LOCATION, "apiVersion": square.API_VERSION,
                        "databaseSnapshot": rows, "databaseSnapshotSha256": digest, "operationBeginTime": "2026-11-04T00:00:00Z",
                        "observationEndTime": "2026-11-05T00:00:00Z", "operationLifetimeEvidenceIds": ["owned-source-lifetime"]}
                elif provider == "highlevel":
                    reviewed = {**common, "historicalSourceCommit": source["sourceCommit"], "historyDatabaseSnapshotSha256": digest}
                elif provider == "resend":
                    ids = {key: [] for key in ("booking", "course_signup", "contact_popup", "general_inquiry", "sanity_backfill", "training_contact")}
                    reviewed = {"resendMarketing": {"environment": "staging", "databaseSnapshotSha256": digest,
                        **{key: source[key] for key in ("sourceCommit", "surfaceSha256", "sourceInventorySha256", "requirementsSha256")},
                        "configurationSha256": source["configurationRecordSha256"], "segmentIdsBySource": ids, "topicIdsBySource": ids}}
                else:
                    reviewed = {**common, **{key: source[key] for key in ("sourceCommit", "sourceInventorySha256", "requirementsSha256")}}
                self.context["scopedReviewed"] = reviewed
                observed = self.execute("observe-provider-effects")
                self.assertEqual((observed["activeExecutions"], observed["uncertainEffects"]), (0, 0))
                self.assertFalse(observed["missingRequirementIds"])
                self.context.update(originalDirectory=str(self.parent), directory=str(recovery))
                self.assertEqual(self.execute("observe-provider-effects"), observed)
                self.context.pop("originalDirectory"); self.context["directory"] = str(self.parent)
        self.assertFalse(self.calls)
        self.assertEqual(output.read_bytes(), original_source_bytes)

    def related_preview_context(self):
        self.bootstrap_context()
        self.execute("deploy-admission")
        self.related_deployments = [{"uid": "dpl_ownedpreview", "state": "READY", "target": None, "created": 40,
            "url": "owned-preview.vercel.app", "meta": {"githubCommitSha": "c" * 40}},
            {"uid": "dpl_production", "state": "READY", "target": "production", "created": 30,
                "url": "owned-production.vercel.app", "meta": {"githubCommitSha": "b" * 40}}]
        self.context["bindings"]["relatedProjects"] = [{"projectId": vercel.PROJECTS["production"],
            "deployments": sorted([adapter.deployment_metadata(row) for row in self.related_deployments], key=lambda row: row["deploymentId"]),
            "retirePreviewDeploymentIds": ["dpl_ownedpreview"]}]
        self.context["relatedPreviewBindings"] = [{"projectId": vercel.PROJECTS["production"], "deploymentId": "dpl_ownedpreview", "sourceCommit": "c" * 40,
            "surfaceSha256": "1" * 64, "configurationRecordSha256": "2" * 64, "sourceInventorySha256": "3" * 64, "requirementsSha256": "4" * 64}]

    def test_related_project_null_target_preview_can_retire_without_production_target_or_cron_changes(self):
        self.related_preview_context()
        start = len(self.calls)
        result = self.execute("retire-related-previews")
        self.assertEqual(result["status"], "STAGING_RELATED_PREVIEW_INGRESS_RETIRED")
        self.assertEqual(result["deletedDeploymentIds"], ["dpl_ownedpreview"])
        self.assertEqual([row["uid"] for row in self.related_deployments], ["dpl_production"])
        self.assertFalse(self.related_disabled); self.assertEqual(self.related_current, "dpl_production")
        self.assertEqual([(row["method"], row["path"].split("?", 1)[0]) for row in self.calls[start:] if row["method"] != "GET"],
            [("DELETE", "/v13/deployments/dpl_ownedpreview")])
        observed = self.execute("observe-vercel")
        self.assertTrue(observed["reviewedInventoryMatches"])
        self.assertIn("dpl_ownedpreview", observed["historicalIngressRetiredDeploymentIds"])
        writes = len(self.mutations()); self.execute("observe-vercel"); self.assertEqual(len(self.mutations()), writes)

    def test_related_production_target_or_missing_capability_binding_refuses_before_delete(self):
        self.related_preview_context()
        writes = len(self.mutations())
        self.context["relatedPreviewBindings"] = []
        with self.assertRaisesRegex(ValueError, "RELATED_PREVIEW_BINDINGS_REQUIRED"):
            self.execute("retire-related-previews")
        self.assertEqual(len(self.mutations()), writes)
        self.context["relatedPreviewBindings"] = [{"projectId": vercel.PROJECTS["production"], "deploymentId": "dpl_production", "sourceCommit": "b" * 40}]
        self.context["bindings"]["relatedProjects"][0]["retirePreviewDeploymentIds"] = ["dpl_production"]
        with self.assertRaisesRegex(ValueError, "RELATED_PRODUCTION_TARGET_RETIREMENT_REFUSED"):
            self.execute("retire-related-previews")
        self.assertEqual(len(self.mutations()), writes)

    def test_historical_deletes_use_exact_reviewed_staging_ids_and_preserve_actual_bootstrap_recovery(self):
        self.bootstrap_context(); self.execute("deploy-admission"); self.retirement_plan()
        result = self.execute("retire-deployments")
        self.assertEqual(result["status"], "STAGING_HISTORICAL_INGRESS_RETIRED")
        self.assertEqual(result["deletedDeploymentIds"], ["dpl_error", "dpl_previous"])
        self.assertEqual(result["preservedDeploymentIds"], ["dpl_candidate"])
        self.assertFalse(result["historicalWritersFenced"]); self.assertIsNone(result["activeExecutions"])
        self.assertEqual(self.current, "dpl_candidate")
        self.assertEqual([row["path"].split("?")[0] for row in self.calls if row["method"] == "DELETE"],
            ["/v13/deployments/dpl_error", "/v13/deployments/dpl_previous"])
        observed = self.execute("observe-vercel")
        self.assertTrue(observed["reviewedInventoryMatches"]); self.assertEqual(observed["historicalIngressRetiredDeploymentIds"], result["deletedDeploymentIds"])

    def test_retirement_refuses_absent_bootstrap_unreviewed_inventory_and_wrong_historical_source(self):
        self.retirement_plan()
        with self.assertRaisesRegex(ValueError, "ADMISSION_COMPATIBLE_BOOTSTRAP_REQUIRED"):
            self.execute("retire-deployments")
        self.bootstrap_context(); self.execute("deploy-admission")
        extra = {"uid": "dpl_unreviewed", "state": "READY", "target": None, "created": 1, "url": None, "meta": {"githubCommitSha": "f" * 40}}
        self.deployments.append(extra)
        with self.assertRaisesRegex(ValueError, "VERCEL_REVIEWED_INVENTORY_CHANGED"):
            self.execute("retire-deployments")
        self.deployments.remove(extra); self.historical_source_wrong = True
        with self.assertRaisesRegex(ValueError, "VERCEL_HISTORICAL_SOURCE_BINDING_REFUSED"):
            self.execute("retire-deployments")
        self.assertFalse(any(row["method"] == "DELETE" for row in self.calls))

    def test_lost_delete_ack_is_unknown_and_never_replayed_or_converted_to_drain_by_inventory_absence(self):
        self.bootstrap_context(); self.execute("deploy-admission"); self.retirement_plan(); self.lost_delete = True
        with self.assertRaises(ValueError):
            self.execute("retire-deployments")
        failed = migrate.read_json(self.parent / "vercel", "historical-deployments-outcome.json")
        self.assertEqual(failed["deletedDeploymentIds"], []); self.assertEqual(failed["uncertainDeploymentId"], "dpl_error")
        self.assertFalse(any(row["uid"] == "dpl_error" for row in self.deployments))
        self.assertFalse(self.execute("observe-vercel")["reviewedInventoryMatches"])
        deletes = len([row for row in self.calls if row["method"] == "DELETE"])
        with self.assertRaises(ValueError):
            self.execute("retire-deployments")
        self.assertEqual(len([row for row in self.calls if row["method"] == "DELETE"]), deletes)
        self.assertEqual(migrate.read_json(self.parent / "vercel", "historical-deployments-outcome.json"), failed)

    def test_project_change_after_one_delete_stops_the_next_and_keeps_original_partial_success(self):
        self.bootstrap_context(); self.execute("deploy-admission"); self.retirement_plan(); self.switch_current_after_delete = True
        with self.assertRaisesRegex(ValueError, "VERCEL_RETIREMENT_PROVIDER_DRIFT"):
            self.execute("retire-deployments")
        outcome = migrate.read_json(self.parent / "vercel", "historical-deployments-outcome.json")
        self.assertEqual(outcome["deletedDeploymentIds"], ["dpl_error"])
        self.assertTrue(any(row["uid"] == "dpl_previous" for row in self.deployments))
        self.assertEqual(len([row for row in self.calls if row["method"] == "DELETE"]), 1)

    def test_delete_transport_refuses_non_deployment_scope_and_payload_before_network(self):
        for path, body in [("/v9/projects/" + vercel.PROJECTS["staging"], None), ("/v13/deployments/dpl_error?url=alias", None),
                           ("/v13/deployments/dpl_error", {})]:
            with self.assertRaisesRegex(ValueError, "VERCEL_REQUEST_REFUSED"):
                self.client.request("DELETE", path, body)
        self.assertFalse(self.calls)

    def test_missing_or_mismatched_durable_database_receipt_refuses_before_writes(self):
        for mode in ("missing", "mismatched"):
            if mode == "mismatched":
                migrate.write_json(self.parent, "database-receipt.json", {**self.database, "sourceCommit": "f" * 40})
            with self.assertRaises((OSError, ValueError)):
                self.execute("deploy-compatible")
            self.assertFalse(self.mutations())

    def test_failed_pin_readback_preserves_partial_mutations_and_stops_before_build(self):
        migrate.write_json(self.parent, "database-receipt.json", self.database); self.ignore_pin = True
        with self.assertRaisesRegex(ValueError, "SOURCE_PIN_READBACK_UNVERIFIED"):
            self.execute("deploy-compatible")
        self.assertFalse(any(row["path"].startswith("/v13/deployments") and row["method"] == "POST" for row in self.calls))
        self.assertEqual(migrate.read_json(self.parent / "vercel", "source-pins-outcome.json")["status"], "SOURCE_PINS_FAILED_REQUIRES_REVIEW")

    def test_gateway_or_physical_database_target_mismatch_refuses_before_provider_writes(self):
        self.context["gatewayHost"] = "unreviewed.example.invalid"
        migrate.write_json(self.parent, "database-receipt.json", self.database)
        with self.assertRaisesRegex(ValueError, "REVIEWED_FRONTEND_GATEWAY_BINDING_REQUIRED"):
            self.execute("deploy-compatible")
        self.assertFalse(self.mutations())
        self.context["gatewayHost"] = "gateway.example.invalid"
        (self.parent / "database-receipt.json").unlink()
        self.database["target"]["database"] = "another_database"
        migrate.write_json(self.parent, "database-receipt.json", self.database)
        with self.assertRaisesRegex(ValueError, "LOCKED_FRONTEND_DATABASE_TARGET_BINDING_REFUSED"):
            self.execute("deploy-compatible")
        self.assertFalse(self.mutations())

    def test_actual_parent_lock_failure_after_created_build_stops_promotion(self):
        migrate.write_json(self.parent, "database-receipt.json", self.database); self.fail_lock_after_build = True
        with self.assertRaises(ValueError):
            self.execute("deploy-compatible")
        self.assertEqual(len([row for row in self.mutations() if row["path"].startswith("/v13/deployments")]), 1)
        self.assertFalse(any("/promote/" in row["path"] for row in self.mutations()))
        self.assertEqual(self.current, "dpl_previous")

    def test_lost_promotion_response_is_not_repeated_and_readonly_observation_preserves_receipts(self):
        migrate.write_json(self.parent, "database-receipt.json", self.database); self.lost_promotion = True
        with self.assertRaises(ValueError):
            self.execute("deploy-compatible")
        self.assertEqual(self.current, "dpl_candidate")
        original = {str(path): path.read_bytes() for path in self.parent.rglob("*.json")}
        recovery = self.parent.parent / "recovery"; recovery.mkdir(mode=0o700)
        self.context["originalDirectory"] = str(self.parent); self.context["directory"] = str(recovery)
        writes = len(self.mutations()); observed = self.execute("observe-compatible")
        self.assertEqual(observed["aliasJobState"], "succeeded"); self.assertTrue(observed["aliasJobMatchesIntent"])
        self.assertEqual(len(self.mutations()), writes)
        for path, raw in original.items():
            self.assertEqual(Path(path).read_bytes(), raw)

    def test_lost_build_response_is_observed_without_guessing_deployment_identity_or_replay(self):
        migrate.write_json(self.parent, "database-receipt.json", self.database); self.lost_build = True
        with self.assertRaises(ValueError):
            self.execute("deploy-compatible")
        original = {str(path): path.read_bytes() for path in self.parent.rglob("*.json")}
        recovery = self.parent.parent / "recovery"; recovery.mkdir(mode=0o700)
        self.context["originalDirectory"] = str(self.parent); self.context["directory"] = str(recovery)
        writes = len(self.mutations())
        observed = self.execute("observe-compatible"); inventory = self.execute("observe-vercel")
        self.assertEqual(observed["actionBuild"]["status"], "FRONTEND_BUILD_FAILED_REQUIRES_REVIEW")
        self.assertIsNone(observed["actionBuild"]["deploymentId"]); self.assertIsNone(observed["deploymentId"])
        self.assertFalse(observed["workloadVerified"]); self.assertFalse(inventory["reviewedInventoryMatches"])
        self.assertEqual(inventory["actionBuild"], observed["actionBuild"])
        self.assertEqual(len(self.mutations()), writes)
        self.assertEqual(len([row for row in self.mutations() if row["path"].startswith("/v13/deployments")]), 1)
        for path, raw in original.items():
            self.assertEqual(Path(path).read_bytes(), raw)

    def test_failed_known_build_records_actual_state_without_staging_or_promoting_it(self):
        migrate.write_json(self.parent, "database-receipt.json", self.database); self.failed_build = True
        with self.assertRaisesRegex(ValueError, "VERCEL_BUILD_FAILED_REQUIRES_REVIEW"):
            self.execute("deploy-compatible")
        writes = len(self.mutations()); observed = self.execute("observe-compatible")
        self.assertEqual(observed["actionBuild"]["deploymentId"], "dpl_candidate")
        self.assertEqual(observed["unstagedActionDeployment"]["readyState"], "ERROR")
        self.assertIsNone(observed["deploymentId"]); self.assertFalse(observed["workloadVerified"])
        inventory = self.execute("observe-vercel")
        self.assertTrue(inventory["reviewedInventoryMatches"])
        self.assertEqual(inventory["knownTerminalActionBuilds"][0]["readyState"], "ERROR")
        self.assertEqual(len(self.mutations()), writes)
        self.assertFalse(any("/promote/" in row["path"] for row in self.mutations()))

    def test_recovery_context_never_permits_a_mutating_provider_operation(self):
        self.context["originalDirectory"] = str(self.parent)
        with self.assertRaisesRegex(ValueError, "RECOVERY_PROVIDER_MUTATION_REFUSED"):
            self.execute("suspend-schedules")
        self.assertFalse(self.calls)


class DeploymentPaginationTests(unittest.TestCase):
    def test_pagination_advances_once_and_refuses_duplicate_or_stalled_pages(self):
        first = {"uid": "dpl_first", "state": "ERROR", "target": None, "created": 20, "url": None}
        second = {"uid": "dpl_second", "state": "ERROR", "target": None, "created": 10, "url": None}
        class Client:
            def __init__(self, pages): self.pages, self.calls = list(pages), []
            def request(self, method, path): self.calls.append(path); return self.pages.pop(0)
        client = Client([{"deployments": [first], "pagination": {"count": 1, "next": 15}}, {"deployments": [second], "pagination": {"count": 1, "next": None}}])
        self.assertEqual(len(adapter.deployment_inventory(client, vercel.PROJECTS["staging"])), 2)
        self.assertTrue(client.calls[1].endswith("&until=15"))
        for second_page in [{"deployments": [first], "pagination": {"count": 1, "next": None}},
                            {"deployments": [second], "pagination": {"count": 1, "next": 15}}]:
            client = Client([{"deployments": [first], "pagination": {"count": 1, "next": 15}}, second_page])
            with self.assertRaises(ValueError):
                adapter.deployment_inventory(client, vercel.PROJECTS["staging"])


if __name__ == "__main__":
    unittest.main()
