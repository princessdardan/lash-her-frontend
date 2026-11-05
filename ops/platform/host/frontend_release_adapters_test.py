from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
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
        self.previous = {"uid": "dpl_previous", "state": "READY", "target": "production", "created": 20,
                         "url": "previous.vercel.app", "meta": {"githubCommitSha": "b" * 40}}
        self.failed = {"uid": "dpl_error", "state": "ERROR", "target": None, "created": 10,
                       "url": "failed.vercel.app", "meta": {"githubCommitSha": "c" * 40}}
        self.deployments = [self.previous, self.failed]
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
                        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Cache-Control", "no-store")
                        self.end_headers(); self.wfile.write(json.dumps(result).encode()); return
                    owner.assertEqual(self.headers.get("Authorization"), "Bearer owned-token-marker")
                    if path.startswith("/v9/projects/"):
                        result = {"id": vercel.PROJECTS["staging"], "accountId": vercel.TEAM,
                                  "link": {"type": "github", "repoId": vercel.REPOSITORY_ID},
                                  "targets": {"production": {"id": owner.current}},
                                  "crons": {"disabledAt": 10 if owner.disabled else None},
                                  "protectionBypass": {"owned-bypass-marker": {"scope": "automation-bypass"}},
                                  "env": [{"value": "provider-private-marker"}]}
                        if owner.alias is not None and "rollbackInfo=true" in self.path:
                            result["lastAliasRequest"] = owner.alias
                    elif path == "/v7/deployments":
                        result = {"deployments": owner.deployments, "pagination": {"count": len(owner.deployments), "next": None}}
                    elif path == "/v13/deployments" and self.command == "POST":
                        owner.assertEqual(body["gitSource"]["sha"], "a" * 40); owner.assertEqual(body["gitSource"]["ref"], "staging")
                        owner.assertFalse(body["autoAssignCustomDomains"])
                        owner.deployments.append({"uid": "dpl_candidate", "state": "READY", "target": "production", "created": 30,
                                                  "url": "owned.vercel.app", "meta": {"githubCommitSha": "a" * 40}})
                        if owner.lost_build:
                            self.connection.shutdown(socket.SHUT_RDWR); self.connection.close(); return
                        result = {"id": "dpl_candidate"}
                    elif path.startswith("/v13/deployments/"):
                        deployment_id = path.rsplit("/", 1)[-1]
                        source = "a" * 40 if deployment_id == "dpl_candidate" else "b" * 40
                        result = {"id": deployment_id, "projectId": vercel.PROJECTS["staging"], "target": "production",
                                  "readyState": "ERROR" if deployment_id == "dpl_candidate" and owner.failed_build else "READY",
                                  "url": "owned.vercel.app", "gitSource": {"type": "github", "repoId": vercel.REPOSITORY_ID, "sha": source},
                                  "meta": {"lashReleaseId": "adapter-owned"}}
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
                        owner.current = "dpl_candidate"
                        owner.alias = {"jobStatus": "succeeded", "requestedAt": 200, "toDeploymentId": "dpl_candidate", "type": "promote"}
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
                        "admissionObservation": {"ledgerDrained": True, "newWork": False, "recovery": False, "active": 0, "uncertain": 0}}
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
            def request(self, url, *args):
                owner.assertEqual(url, "https://owned.vercel.app")
                with patch.object(frontend_probe, "DEPLOYMENT_URL", re.compile(re.escape(owner.origin))):
                    return owner.probe_client.request(owner.origin, *args)
        return MappedProbe()

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
        self.assertFalse(self.execute("observe-vercel")["reviewedInventoryMatches"])
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
