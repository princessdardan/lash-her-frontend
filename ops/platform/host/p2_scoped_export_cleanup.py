"""One source-selected frontend export scrub under the held certification lease.

The controller owns frontend admission transitions. This leaf keeps the gateway
closed and native scheduling disabled, authenticates the fixed direct deployment,
issues one cleanup GET, and joins that response to the physical admission ledger.
"""
import copy
import datetime
import hashlib
import json
import re
import ssl
import urllib.error
import urllib.request

import frontend_probe
import migrate
import p2_lifecycle_native as native
import p2_lifecycle_persistence_probe as persistence
import vercel
from frontend_release_adapters import LockedClient
from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE


demand = migrate.demand
UUID = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$")
SHA = re.compile(r"^[a-f0-9]{64}$")
DIRECT = re.compile(r"^https://[a-z0-9][a-z0-9-]*\.vercel\.app$")
PATH = "/api/cron/account-lifecycle"


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


def _digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else _canonical(value)).hexdigest()


def _strict_json(raw):
    def pairs(rows):
        result = {}
        for key, value in rows:
            demand(isinstance(key, str) and key not in result, "P2_SCOPED_EXPORT_CLEANUP_RESPONSE_REQUIRED")
            result[key] = value
        return result

    def reject(_value):
        raise ValueError("P2_SCOPED_EXPORT_CLEANUP_RESPONSE_REQUIRED")

    return json.loads(raw.decode("utf8"), object_pairs_hook=pairs, parse_constant=reject)


def _instant(value):
    demand(isinstance(value, str) and value.endswith("Z"), "P2_SCOPED_EXPORT_CLEANUP_EXPIRY_REQUIRED")
    try:
        parsed = datetime.datetime.fromisoformat(value.removesuffix("Z") + "+00:00")
    except ValueError:
        raise ValueError("P2_SCOPED_EXPORT_CLEANUP_EXPIRY_REQUIRED") from None
    demand(parsed.tzinfo is not None, "P2_SCOPED_EXPORT_CLEANUP_EXPIRY_REQUIRED")
    return parsed.timestamp()


def _profile_fields(expected):
    return {"version": 2, "qualificationTargetProfile": expected}


class ScopedCleanupUncertain(Exception):
    pass


class DirectCleanupClient:
    """Fixed TLS client. URL and query are selected from source-owned records."""
    def __init__(self):
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), vercel.NoRedirect(),
            urllib.request.HTTPSHandler(context=ssl.create_default_context()))

    def request(self, deployment_url, command_id, secret, bypass):
        demand(DIRECT.fullmatch(deployment_url or "") and UUID.fullmatch(command_id or "") and
            isinstance(secret, str) and 0 < len(secret) <= 8192 and secret.strip() == secret and
            re.fullmatch(r"[!-~]+", secret) and isinstance(bypass, str) and bypass,
            "P2_SCOPED_EXPORT_CLEANUP_FIXED_REQUEST_REQUIRED")
        url = deployment_url + PATH + "?operation=expire-export&commandId=" + command_id
        request = urllib.request.Request(url, method="GET", headers={"authorization": "Bearer " + secret,
            "accept": "application/json", "cache-control": "no-cache", "x-vercel-protection-bypass": bypass})
        started = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        try:
            response = self._opener.open(request, timeout=90)
        except urllib.error.HTTPError as error:
            response = error
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            raise ValueError("P2_SCOPED_EXPORT_CLEANUP_REQUEST_FAILED") from None
        with response:
            raw = response.read(8193)
            demand(0 < len(raw) <= 8192 and response.headers.get("content-type", "").split(";", 1)[0] == "application/json" and
                all(part in response.headers.get("cache-control", "").lower() for part in ("private", "no-store")),
                "P2_SCOPED_EXPORT_CLEANUP_RESPONSE_REQUIRED")
            try:
                body = _strict_json(raw)
            except (TypeError, UnicodeError, ValueError):
                raise ValueError("P2_SCOPED_EXPORT_CLEANUP_RESPONSE_REQUIRED") from None
            demand(isinstance(body, dict), "P2_SCOPED_EXPORT_CLEANUP_RESPONSE_REQUIRED")
            return {"status": response.status, "requestId": response.headers.get("x-request-id"), "body": body,
                "startedAt": started,
                "completedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")}


class P2ScopedExportCleanupStage:
    def __init__(self, broker):
        from p2_certification_parent import P2CertificationPhysicalObserver, P2CertificationScope, P2ProfiledCertificationBroker
        expected = migrate.profile_context(getattr(getattr(broker, "scope", None), "_expected_profile", None))
        demand(type(broker) is P2ProfiledCertificationBroker and type(broker.scope) is P2CertificationScope and
            type(broker.observer) is P2CertificationPhysicalObserver and expected == dict(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE),
            "P2_SCOPED_EXPORT_CLEANUP_PARENT_REQUIRED")
        plan = broker.initial.get("certificationPlan")
        scoped = plan.get("scopedAction") if isinstance(plan, dict) else None
        demand(isinstance(plan, dict) and plan.get("version") == 2 and plan.get("mode") == "export-cleanup" and
            isinstance(scoped, dict) and set(scoped) == {"commandId", "readyRecordSha256"} and
            UUID.fullmatch(scoped.get("commandId", "")) and SHA.fullmatch(scoped.get("readyRecordSha256", "")) and
            SHA.fullmatch(plan.get("persistenceReviewedSha256", "")) and
            _digest(broker.initial.get("persistenceReviewed")) == plan["persistenceReviewedSha256"],
            "P2_SCOPED_EXPORT_CLEANUP_PLAN_REQUIRED")
        migrate.require_profile(expected, plan, plan.get("nativePlan"), broker.initial.get("persistenceReviewed"))
        self.broker, self.scope, self.observer = broker, broker.scope, broker.observer
        self.plan, self.scoped, self.expected = copy.deepcopy(plan), copy.deepcopy(scoped), expected
        self.reviewed = copy.deepcopy(persistence._reviewed(broker.initial["persistenceReviewed"], expected))
        self.client = DirectCleanupClient()
        self.preflight_done = False
        self.invocation_attempted = False
        self.verify()

    def _common(self):
        return {**_profile_fields(self.expected), "environment": "staging", "releaseId": self.broker.selected["releaseId"],
            "certificationActionId": self.plan["certificationActionId"], "candidateSha256": self.plan["candidateSha256"],
            "planSha256": self.plan["planSha256"], "commandId": self.scoped["commandId"],
            "readyRecordSha256": self.scoped["readyRecordSha256"],
            "persistenceReviewedSha256": self.plan["persistenceReviewedSha256"]}

    def _retained_ready(self):
        retained = persistence.load_retained_capture(self.reviewed["plan"], self.reviewed["privateDirectory"],
            "capture-export-ready", expected_profile=self.expected)
        record = retained["record"]
        witness, evidence, receipt = (record.get(key) for key in ("witness", "privateEvidence", "receipt"))
        command = witness.get("command") if isinstance(witness, dict) else None
        demand(retained["recordSha256"] == self.scoped["readyRecordSha256"] and
            isinstance(command, dict) and command.get("commandId") == self.scoped["commandId"] and command.get("action") == "export" and
            witness.get("profile") == "export-ready-v1" and witness.get("readOnly") is True and
            isinstance(receipt, dict) and receipt.get("status") == "P2_LIFECYCLE_EXPORT_READY_CAPTURED" and
            receipt.get("readOnly") is True and receipt.get("providerTouched") is False and receipt.get("releaseAccepted") is False and
            isinstance(evidence, dict) and set(evidence) == {"version", "stage", "export"} and
            evidence.get("version") == 1 and evidence.get("stage") == "capture-export-ready" and
            isinstance(evidence.get("export"), dict) and set(evidence["export"]) == {"frontend", "course", "community"},
            "P2_SCOPED_EXPORT_CLEANUP_READY_RECORD_REQUIRED")
        times = {}
        for service in ("frontend", "course", "community"):
            value = evidence["export"][service]
            demand(isinstance(value, dict) and set(value) == {"readyAt", "expiresAt"},
                "P2_SCOPED_EXPORT_CLEANUP_EXPIRY_REQUIRED")
            ready, expires = _instant(value["readyAt"]), _instant(value["expiresAt"])
            demand(ready < expires, "P2_SCOPED_EXPORT_CLEANUP_EXPIRY_REQUIRED")
            times[service] = (ready, expires)
        demand(times["course"][1] - times["course"][0] == 86400 and
            times["community"][1] - times["community"][0] == 86400 and
            times["frontend"][1] == min(times["frontend"][0] + 86400, times["course"][1], times["community"][1]) and
            datetime.datetime.now(datetime.timezone.utc).timestamp() >= max(expires for _, expires in times.values()),
            "P2_SCOPED_EXPORT_CLEANUP_NOT_EXPIRED")
        return retained

    def verify(self):
        from p2_certification_parent import P2ProfiledCertificationBroker
        demand(type(self.broker) is P2ProfiledCertificationBroker and self.broker.initial["certificationPlan"] == self.plan and
            self.broker.initial["persistenceReviewed"] == self.reviewed and self.broker.scope is self.scope and
            self.broker.observer is self.observer and _digest(self.broker.initial["persistenceReviewed"]) ==
            self.plan["persistenceReviewedSha256"], "P2_SCOPED_EXPORT_CLEANUP_PARENT_CHANGED")
        P2ProfiledCertificationBroker.check(self.broker)
        self._retained_ready()

    def _provider(self):
        from p2_certification_parent import P2ProfiledCertificationBroker
        context = P2ProfiledCertificationBroker._native_context(self.broker)
        client = LockedClient(self.broker.vercel, self.broker.check)
        current = P2ProfiledCertificationBroker._native_observe(self.broker)
        metadata = native.observe_metadata(context, client, expected_profile=self.expected)
        plan = context["plan"]
        demand(context["candidate"] == self.broker.selected and plan == self.plan["nativePlan"] and
            current.get("nativeEnabled") is False and metadata.get("nativeEnabled") is False and
            all(current.get(key) == metadata.get(key) == plan.get(key) for key in
                ("projectId", "deploymentId", "sourceCommit", "deploymentUrl", "schedule")),
            "P2_SCOPED_EXPORT_CLEANUP_NATIVE_OFF_REQUIRED")
        project = vercel._project(client, plan["projectId"])
        return plan, frontend_probe._automation_bypass(project)

    def _boundary(self, epoch, recovery, *, witness=False):
        from p2_certification_parent import P2CertificationPhysicalObserver, P2ProfiledCertificationBroker
        self.verify()
        physical = P2CertificationPhysicalObserver.probe(self.observer, "witness" if witness else "observe")
        admission = physical.get("admission", {})
        demand(physical.get("status") == "P2_FRONTEND_PHYSICAL_LOCK_VERIFIED" and admission == {
            "epoch": epoch, "newWork": False, "recovery": recovery, "active": 0, "uncertain": 0},
            "P2_SCOPED_EXPORT_CLEANUP_FRONTEND_BOUNDARY_REQUIRED")
        gateway = P2ProfiledCertificationBroker._gateway_current(self.broker).get("admission", {})
        demand(gateway.get("valid") is True and gateway.get("newWork") is False and gateway.get("recovery") is False and
            all(gateway.get(field) == {"newWork": 0, "recovery": 0} for field in ("active", "uncertain")),
            "P2_SCOPED_EXPORT_CLEANUP_GATEWAY_CLOSED_REQUIRED")
        plan, bypass = self._provider()
        return physical, plan, bypass

    def _request(self, secret, epoch, recovery):
        _physical, plan, bypass = self._boundary(epoch, recovery)
        return self.client.request(plan["deploymentUrl"], self.scoped["commandId"], secret, bypass)

    def preflight(self, secret):
        demand(not self.preflight_done and not self.invocation_attempted,
            "P2_SCOPED_EXPORT_CLEANUP_ONE_PREFLIGHT_REQUIRED")
        initial = self.plan["initialEpoch"]
        invalid = self._request(__import__("secrets").token_hex(48), initial, False)
        demand(invalid["status"] == 401 and invalid["requestId"] is None and invalid["body"] == {"error": "unauthorized"},
            "P2_SCOPED_EXPORT_CLEANUP_INVALID_CONTROL_REQUIRED")
        valid = self._request(secret, initial, False)
        demand(valid["status"] == 503 and valid["requestId"] is None and valid["body"] == {"error": "temporarily_unavailable"},
            "P2_SCOPED_EXPORT_CLEANUP_CLOSED_CONTROL_REQUIRED")
        self._boundary(initial, False)
        self.preflight_done = True
        receipt = {**self._common(), "status": "P2_SCOPED_EXPORT_CLEANUP_PREFLIGHT_VERIFIED", "invalidStatus": 401,
            "validClosedStatus": 503, "operationIdIssued": False, "gatewayClosed": True, "nativeEnabled": False,
            "credentialBytesOutput": False, "credentialHashOutput": False, "providerMutation": False}
        migrate.write_json(self.broker.directory, "p2-scoped-export-cleanup-preflight.json", receipt)
        return receipt

    def invoke(self, secret):
        demand(self.preflight_done and not self.invocation_attempted,
            "P2_SCOPED_EXPORT_CLEANUP_ONE_INVOCATION_REQUIRED")
        self.invocation_attempted = True
        epoch = str(int(self.plan["initialEpoch"]) + 1)
        intent = {**self._common(), "status": "P2_SCOPED_EXPORT_CLEANUP_INTENT_RETAINED", "epoch": epoch,
            "method": "GET", "operation": "expire-export", "automaticRetryAllowed": False,
            "gatewayClosed": True, "nativeEnabled": False, "providerMutation": False}
        migrate.write_json(self.broker.directory, "p2-scoped-export-cleanup-intent.json", intent)
        outcome = {**self._common(), "status": "P2_SCOPED_EXPORT_CLEANUP_REQUIRES_REVIEW", "epoch": epoch,
            "httpStatus": None, "operationId": None, "cleanupOutcome": None, "cleanupReceipt": None, "cleanupReceiptSha256": None,
            "automaticRetryAttempted": False, "credentialBytesOutput": False, "credentialHashOutput": False,
            "providerMutation": False, "releaseAccepted": False}
        try:
            result = self._request(secret, epoch, True)
            outcome.update(httpStatus=result["status"], operationId=result["requestId"])
            body = result["body"]
            demand(result["status"] == 200 and UUID.fullmatch(result["requestId"] or "") and
                isinstance(body, dict) and set(body) == {"operation", "commandId", "outcome", "status", "dataCleared", "frontendCleared", "requestId"} and
                body == {"operation": "expire-export", "commandId": self.scoped["commandId"], "outcome": "scrubbed",
                    "status": "expired", "dataCleared": True, "frontendCleared": True, "requestId": result["requestId"]},
                "P2_SCOPED_EXPORT_CLEANUP_RESPONSE_BINDING_REQUIRED")
            outcome.update(cleanupOutcome="scrubbed", cleanupReceipt=copy.deepcopy(body), cleanupReceiptSha256=_digest(body))
            self._boundary(epoch, True)
            outcome["status"] = "P2_SCOPED_EXPORT_CLEANUP_INVOKED"
            self.invocation = copy.deepcopy(outcome)
            migrate.write_json(self.broker.directory, "p2-scoped-export-cleanup-invocation.json", outcome)
            return outcome
        except BaseException:
            try:
                migrate.write_json(self.broker.directory, "p2-scoped-export-cleanup-invocation.json", outcome)
            except BaseException:
                pass
            raise ScopedCleanupUncertain("P2_SCOPED_EXPORT_CLEANUP_UNCERTAIN") from None

    def join(self):
        demand(hasattr(self, "invocation") and self.invocation.get("status") == "P2_SCOPED_EXPORT_CLEANUP_INVOKED",
            "P2_SCOPED_EXPORT_CLEANUP_INVOCATION_REQUIRED")
        epoch = str(int(self.plan["initialEpoch"]) + 2)
        physical, _plan, _bypass = self._boundary(epoch, False, witness=True)
        witness = physical.get("witness", {})
        operations = witness.get("operations") if isinstance(witness, dict) else None
        demand(isinstance(operations, list) and len(operations) == 1,
            "P2_SCOPED_EXPORT_CLEANUP_EXACT_OPERATION_REQUIRED")
        operation = operations[0]
        native_plan = self.plan["nativePlan"]
        demand(isinstance(operation, dict) and operation.get("id") == self.invocation["operationId"] and
            operation.get("epoch") == str(int(self.plan["initialEpoch"]) + 1) and operation.get("kind") == "recovery" and
            operation.get("state") == "completed" and isinstance(operation.get("completed_at"), str) and
            operation.get("reconciliation_sha256") is None and
            operation.get("producer_sha256") == native_plan["producer"]["producerSha256"] and
            operation.get("source_sha") == native_plan["sourceCommit"] and
            operation.get("role_oid") == native_plan["producer"]["role"]["oid"],
            "P2_SCOPED_EXPORT_CLEANUP_EXACT_OPERATION_REQUIRED")
        receipt = {**self._common(), "status": "P2_SCOPED_EXPORT_CLEANUP_JOINED", "operationId": operation["id"],
            "operationEpoch": operation["epoch"], "cleanupOutcome": self.invocation["cleanupOutcome"],
            "cleanupReceiptSha256": self.invocation["cleanupReceiptSha256"],
            "preflightReceiptSha256": _digest(migrate.read_input(self.broker.directory, "p2-scoped-export-cleanup-preflight.json")),
            "invocationReceiptSha256": _digest(migrate.read_input(self.broker.directory, "p2-scoped-export-cleanup-invocation.json")),
            "completedRecoveryOperations": 1, "frontendAdmissionClosed": True, "gatewayClosed": True,
            "nativeEnabled": False, "automaticRetryAttempted": False, "providerMutation": False,
            "credentialBytesOutput": False, "credentialHashOutput": False, "releaseAccepted": False}
        migrate.write_json(self.broker.directory, "p2-scoped-export-cleanup-joined.json", receipt)
        return receipt
