"""Fixed direct-worker and receiver evidence under the existing P2 parent lease.

No standalone apply, selective worker, SQL replay, generic HTTP request, or native
classification. Credentials are source-private RPC input and never recorded.
"""
import base64
import copy
import datetime
import json
import os
from pathlib import Path
import re
import secrets
import stat
import urllib.error
import urllib.request

import migrate
import release as runtime
import current_databases
import vercel
import p2_lifecycle_native as native
import p2_lifecycle_persistence_probe as persistence
from p2_lifecycle_persistence_scope import CurrentLifecyclePersistenceScope
from p2_release_scope import P2ReleaseScope
from p2_certification_fault import GATEWAY_OBSERVER
from p2_lifecycle_suspension_evidence import ROOT, LOCK, canonical, digest, load_retained_suspension, P2LifecycleSuspensionEvidenceStage

demand = migrate.demand
UUID = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$")
DENIAL = "ops/platform/p2-lifecycle-receiver-denial.mjs"
IDENTITY = "ops/platform/p2-identity-negative-probe.mjs"
PATH = "/api/cron/account-lifecycle"


def worker_profile(scope, plan, suspension_plan, persistence_reviewed, expected_profile):
    """Bind a profiled worker to the exact plan held by its source parent."""
    expected = migrate.require_profile(expected_profile, plan, suspension_plan, persistence_reviewed)
    if expected is not None:
        from p2_certification_parent import P2CertificationScope

        demand(type(scope) is P2CertificationScope and scope._expected_profile == expected
            and scope.path == LOCK and os.geteuid() == 0,
            "P2_WORKER_PROFILED_CERTIFICATION_SCOPE_REQUIRED")
        parent_plan = scope.certification_plan
        migrate.require_profile(expected, parent_plan, scope.receipt)
        demand(all(type(value.get("version")) is int and value["version"] == 2
                for value in (plan, suspension_plan, persistence_reviewed, parent_plan, scope.receipt))
            and parent_plan.get("mode") == "direct-worker"
            and parent_plan.get("workerPlan") == plan
            and parent_plan.get("workerPlanSha256") == digest(canonical(plan))
            and parent_plan.get("certificationActionId") == plan.get("actionId"),
            "P2_WORKER_PROFILED_DIRECT_PLAN_REQUIRED")
    return expected


def _profile_fields(expected):
    return {"version": 1} if expected is None else {"version": 2, "qualificationTargetProfile": expected}


def denial_program(source):
    helper = base64.b64encode(migrate.read_input(source, IDENTITY, 131072)).decode()
    code = migrate.read_input(source, DENIAL, 131072).decode().replace("./p2-identity-negative-probe.mjs", "data:text/javascript;base64,"+helper)
    encoded = base64.b64encode(code.encode()).decode()
    return ("import('data:text/javascript;base64,"+encoded+"').then(m=>m.runPrivateReceiverDenialFromStdin())").encode()


def write_record(directory, name, value):
    demand(name in ("credential-preflight.json", "worker-invocation-intent.json", "worker-invocation.json", "receiver-denials.json", "lifecycle-account.json", "joined-worker.json"),
        "P2_WORKER_FIXED_RECORD_REQUIRED")
    info = directory.lstat()
    demand(not directory.is_symlink() and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700, "P2_WORKER_PRIVATE_DIRECTORY_REQUIRED")
    raw = canonical(value)+b"\n"
    demand(0 < len(raw) <= 262144, "P2_WORKER_RECORD_BOUND")
    descriptor = os.open(directory/name, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
    try:
        remaining = raw
        while remaining:
            amount = os.write(descriptor, remaining); demand(amount > 0, "P2_WORKER_RECORD_WRITE_FAILED"); remaining = remaining[amount:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    descriptor = os.open(directory, os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return digest(raw)


class HeldWorkerPersistenceScope(CurrentLifecyclePersistenceScope):
    """Reuses the fixed reader/classifier and actual parent's held FD.

    The owning constructor is deliberately not called: it would acquire a second
    flock. Every child is registered with the actual parent. This adapter cannot
    close/revoke its parent's scope or run an arbitrary child.
    """
    def __init__(self, stage):
        demand(isinstance(stage.scope, P2ReleaseScope), "P2_WORKER_ACTUAL_PARENT_REQUIRED")
        self.stage, self.parent = stage, stage.scope
        self.selected, self.reviewed, self.configuration = stage.selected, stage.reviewed, stage.configuration
        self.program = self.persistence_program = persistence.private_program(stage.source)
        self.runtime_bound = False
        self.ids = {row["containerId"] for row in self.reviewed["containers"]}

    def verify(self):
        self.stage.verify()

    def run(self, args, *, timeout, input=None, env=None, capture_output=True, check=False, text=False):
        demand(capture_output is True and check is False and text is False and 0 < timeout <= 30, "P2_WORKER_FIXED_READER_CHILD_REQUIRED")
        self.verify(); self._allowed(args, input, env)
        result = self.parent.run(args, timeout=timeout, input=input, env=env, capture_output=True)
        demand(len(result.stdout or b"") <= 65536 and len(result.stderr or b"") <= 8192, "P2_WORKER_READER_OUTPUT_BOUND")
        self.verify(); return result

    def close(self):
        raise ValueError("P2_WORKER_PARENT_LOCK_NOT_OWNED_BY_READER")

    def revoke(self):
        raise ValueError("P2_WORKER_PARENT_LOCK_NOT_OWNED_BY_READER")


class P2LifecycleWorkerEvidenceStage:
    def __init__(self, scope, selected, jobs, configuration, source, plan, suspension_plan, persistence_reviewed, *,
                 native_context, provider_client, observe_frontend, expected_profile=None, bundle=None,
                 database_proof=None, release_evidence=None, observe_native=None):
        expected = worker_profile(scope, plan, suspension_plan, persistence_reviewed, expected_profile)
        demand(isinstance(scope, P2ReleaseScope) and scope.path == LOCK and os.geteuid() == 0 and callable(observe_frontend)
            and plan.get("version") == (2 if expected is not None else 1) and plan.get("environment") == "staging" and plan.get("profile") == "direct-known-suspension-v1"
            and plan.get("workerInvocations") == 1 and plan.get("nativeInvocationQualified") is False
            and plan.get("automaticRetryAllowed") is False and plan.get("finalDisposition") == "native-off-and-admission-closed",
            "P2_WORKER_ACTUAL_FIXED_PARENT_REQUIRED")
        self.scope, self.selected, self.jobs = scope, copy.deepcopy(selected), copy.deepcopy(jobs)
        self.configuration, self.source, self.plan = Path(configuration), Path(source), copy.deepcopy(plan)
        self.expected_profile = expected
        self.suspension_plan, self.reviewed = copy.deepcopy(suspension_plan), copy.deepcopy(persistence._reviewed(persistence_reviewed, expected))
        self.native_context, self.provider, self.observe_frontend = native_context, provider_client, observe_frontend
        self.observe_native = observe_native
        migrate.require_profile(expected, native_context["plan"])
        demand(plan["suspensionPlanSha256"] == digest(canonical(suspension_plan)) and native_context["candidate"] == selected
            and native_context["plan"]["planSha256"] == plan["nativePlanSha256"]
            and all(plan.get(name) == suspension_plan.get(name) for name in ("candidateSha256", "candidateObjectSha256", "sourceCommit", "configurationSha256", "targetSha256"))
            and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", plan.get("actionId", "")), "P2_WORKER_PLAN_CONTEXT_REQUIRED")
        self.directory = ROOT/("p2-worker-"+plan["actionId"])
        if expected is not None:
            migrate.candidate_profile(selected, expected)
            demand(bundle is not None and database_proof is not None and type(release_evidence) is dict
                and callable(observe_native) and Path(self.reviewed["privateDirectory"]) == self.directory,
                "P2_WORKER_PROFILED_INPUTS_REQUIRED")
            self.bundle, self.database_proof, self.release_evidence = Path(bundle), database_proof, copy.deepcopy(release_evidence)
            demand(self.bundle.is_absolute() and self.bundle.is_relative_to(ROOT) and self.bundle.resolve() == self.bundle,
                "P2_WORKER_PROFILED_BUNDLE_REQUIRED")
        else:
            demand(bundle is None and database_proof is None and release_evidence is None and observe_native is None,
                "P2_WORKER_LEGACY_INPUTS_REQUIRED")
        self.preflight_done = self.invocation_attempted = False
        self.verify()
        info = self.directory.parent.lstat()
        demand(not self.directory.parent.is_symlink() and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700, "P2_WORKER_PRIVATE_PARENT_REQUIRED")
        self.directory.mkdir(mode=0o700, exist_ok=False)

    def verify(self):
        expected = self.expected_profile
        if expected is not None:
            worker_profile(self.scope, self.plan, self.suspension_plan, self.reviewed, expected)
            current_databases.read_certification_api_proof(self.database_proof, self.scope, self.selected, self.jobs,
                expected_profile=expected)
            demand(digest(migrate.read_input(self.bundle, "release.candidate.json")) == self.plan["candidateSha256"],
                "P2_WORKER_PROFILED_CANDIDATE_BYTES_CHANGED")
        self.prior = load_retained_suspension(self.scope, self.selected, self.jobs, self.configuration, self.source,
            self.suspension_plan, self.reviewed, self.plan["pendingRecordSha256"],
            expected_profile=expected, release_evidence=getattr(self, "release_evidence", None))
        command = self.prior["pendingRecord"]["pending"]["command"]
        witness = self.native_context["plan"]["commandWitnesses"][self.plan["commandIndex"]]
        demand(command["commandId"] == witness["commandId"] and str(command["accountVersion"]) == witness["accountVersion"]
            and command["action"] == witness["action"] == "suspend" and digest(canonical(command)) == self.plan["canonicalCommandSha256"]
            and digest(denial_program(self.source)) == self.plan["denialProgramSha256"]
            and digest(migrate.read_input(self.source, "ops/platform/p2-lifecycle-worker-evidence.mjs")) == self.plan["sourceProgramSha256"]
            and digest(migrate.read_input(self.source, "ops/platform/host/p2_lifecycle_worker_evidence.py")) == self.plan["hostProgramSha256"]
            and digest(migrate.read_input(self.source, DENIAL)) == self.plan["denialSourceSha256"],
            "P2_WORKER_CANONICAL_SOURCE_REQUIRED")
        if expected is not None:
            actual = self.scope.read_runtime_inventory(self.configuration)
        else:
            token = runtime._command_scope.set(self.scope)
            try:
                actual = runtime.check_containers(self.selected, self.configuration, expected_profile=expected)
            finally:
                runtime._command_scope.reset(token)
        demand(actual == self.reviewed["containers"], "P2_WORKER_RUNTIME_CHANGED")
        if expected is None:
            import p2_identity_negative_probe as identity
            for service in ("gateway", "course-api", "community-api"):
                identity._one_container(next(row for row in actual if row["service"] == service), self.configuration, self.scope)
        self.inventory = actual

    def _gateway(self, recovery):
        gateway = next(row["containerId"] for row in self.inventory if row["service"] == "gateway")
        result = self.scope.run(["docker", "exec", "--workdir", "/app", gateway, "node", "--input-type=module", "--eval", GATEWAY_OBSERVER],
            env=runtime.SAFE_ENV, timeout=10, capture_output=True)
        demand(result.returncode == 0 and not result.stderr and 0 < len(result.stdout) <= 16384, "P2_WORKER_GATEWAY_READBACK_REQUIRED")
        value = json.loads(result.stdout)
        admission = value.get("admission", {})
        demand(value.get("status") == "P2_FAULT_GATEWAY_CURRENT" and value.get("processSha256") == self.plan["gatewayProcessSha256"]
            and value.get("gatewayConfigurationSha256") == self.plan["gatewayConfigurationSha256"] and value.get("faultLeasePresent") is False
            and admission.get("valid") is True and admission.get("newWork") is False and admission.get("recovery") is recovery
            and all(admission.get(field) == {"newWork": 0, "recovery": 0} for field in ("active", "uncertain")), "P2_WORKER_GATEWAY_MUST_BE_CERTAIN")
        return admission

    def _boundary(self, recovery):
        self.verify()
        current = self.observe_frontend()
        expected = self.expected_profile
        if expected is not None:
            migrate.require_profile(expected, current)
            demand(current.get("version") == 2, "P2_WORKER_CURRENT_FRONTEND_PROFILE_REQUIRED")
        admission = current.get("admission", {})
        demand(current.get("status") == "P2_FRONTEND_PHYSICAL_LOCK_VERIFIED" and admission.get("newWork") is False
            and admission.get("recovery") is recovery and admission.get("active") == 0 and admission.get("uncertain") == 0,
            "P2_WORKER_CURRENT_FRONTEND_ADMISSION_REQUIRED")
        self._gateway(recovery)
        if expected is None:
            value = native.observe(self.native_context, self.provider)
        else:
            value = self.observe_native()
            demand(value.get("status") == "P2_DAY_TWO_WORKLOAD_OBSERVED" and value.get("readOnly") is True and
                value.get("workloadChallengeVerified") is True and value.get("aliasReadbacks") == 2,
                "P2_WORKER_DAY_TWO_WORKLOAD_REQUIRED")
        metadata = native.observe_metadata(self.native_context, self.provider, expected_profile=expected)
        if expected is not None:
            migrate.require_profile(expected, value, metadata)
            demand(all(item.get("version") == 2 and item.get("candidateSha256") == self.plan["candidateObjectSha256"]
                for item in (value, metadata)), "P2_WORKER_CURRENT_NATIVE_PROFILE_REQUIRED")
        demand(value.get("nativeEnabled") is False and metadata.get("nativeEnabled") is False
            and all(value.get(name) == metadata.get(name) for name in ("projectId", "deploymentId", "sourceCommit", "deploymentUrl", "schedule", "releaseId")),
            "P2_WORKER_NATIVE_MUST_BE_DISABLED")
        return admission

    def _request(self, secret):
        demand(isinstance(secret, str) and 0 < len(secret) <= 8192 and secret.strip() == secret and re.fullmatch(r"[!-~]+", secret), "P2_WORKER_SOURCE_PRIVATE_CREDENTIAL_REQUIRED")
        plan = self.native_context["plan"]
        demand(re.fullmatch(r"https://[a-z0-9][a-z0-9-]*\.vercel\.app", plan["deploymentUrl"]), "P2_WORKER_FIXED_DEPLOYMENT_REQUIRED")
        project = vercel._project(self.provider, plan["projectId"])
        bypass = __import__("frontend_probe")._automation_bypass(project)
        headers = {"authorization": "Bearer "+secret, "accept": "application/json", "x-vercel-protection-bypass": bypass}
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *_args, **_kwargs):
                return None
        opener = urllib.request.build_opener(NoRedirect())
        started = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        pending = urllib.request.Request(plan["deploymentUrl"]+PATH, headers=headers, method="GET")
        try:
            response = opener.open(pending, timeout=90)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read(8193)
            demand(0 < len(raw) <= 8192 and response.headers.get("content-type", "").split(";", 1)[0] == "application/json"
                and all(part in response.headers.get("cache-control", "") for part in ("private", "no-store")), "P2_WORKER_EXACT_CRON_RESPONSE_REQUIRED")
            return {"status": response.status, "requestId": response.headers.get("x-request-id"), "body": json.loads(raw), "startedAt": started}

    def preflight_credential(self, secret):
        demand(not self.preflight_done and not self.invocation_attempted, "P2_WORKER_ONE_CREDENTIAL_PREFLIGHT_REQUIRED")
        self._boundary(False)
        invalid = self._request(secrets.token_hex(48))
        demand(invalid["status"] == 401 and invalid["requestId"] is None and invalid["body"] == {"error": "unauthorized"}, "P2_WORKER_INVALID_CREDENTIAL_CONTROL_REQUIRED")
        valid = self._request(secret)
        demand(valid["status"] == 503 and valid["requestId"] is None and valid["body"] == {"error": "temporarily_unavailable"}, "P2_WORKER_VALID_CREDENTIAL_CLOSED_GATE_REQUIRED")
        self._boundary(False)
        self.preflight_done = True
        value = {**_profile_fields(getattr(self, "expected_profile", None)), "status": "P2_DIRECT_WORKER_CREDENTIAL_VERIFIED_CLOSED", "bindingSha256": digest(canonical(self.plan)),
            "invalidStatus": 401, "validClosedStatus": 503, "operationIdIssued": False, "credentialBytesRetained": False, "credentialHashesOutput": False}
        write_record(self.directory, "credential-preflight.json", value)
        return value

    def invoke_direct(self, secret):
        demand(self.preflight_done and not self.invocation_attempted, "P2_WORKER_ONE_SOURCE_INVOCATION_REQUIRED")
        self._boundary(True)
        self.invocation_attempted = True
        profile_fields = _profile_fields(getattr(self, "expected_profile", None))
        write_record(self.directory, "worker-invocation-intent.json", {**profile_fields, "bindingSha256": digest(canonical(self.plan)),
            "canonicalCommandSha256": self.plan["canonicalCommandSha256"], "invocationClass": "direct-source-authenticated-cron", "nativeInvocationQualified": False})
        value = {**profile_fields, "status": "P2_DIRECT_WORKER_INVOCATION_REQUIRES_REVIEW", "bindingSha256": digest(canonical(self.plan)),
            "invocationClass": "direct-source-authenticated-cron", "httpStatus": None, "operationId": None, "workerInvokedAt": None,
            "nativeInvocationQualified": False, "credentialBytesRetained": False, "credentialHashesOutput": False, "releaseAccepted": False}
        try:
            result = self._request(secret)
            value.update(httpStatus=result["status"], operationId=result["requestId"], workerInvokedAt=result["startedAt"])
            body = result["body"]
            demand(result["status"] == 200 and UUID.fullmatch(result["requestId"] or "") and isinstance(body, dict)
                and set(body) == {"acknowledged", "retrying", "blocked", "exportsReady", "expired"}
                and all(type(value) is int for value in body.values())
                and body == {"acknowledged": 2, "retrying": 0, "blocked": 0, "exportsReady": 0, "expired": 0}
                and result["startedAt"] > self.prior["user"]["firstDenied"]["responseEndedAt"], "P2_WORKER_WHOLE_OPERATION_NOT_COMPLETED")
            value["status"] = "P2_DIRECT_WORKER_HTTP_OBSERVED"
            self.invocation = value
            return value
        finally:
            write_record(self.directory, "worker-invocation.json", value)

    def observe_lifecycle_witness(self, frontend_runtime_database_url):
        demand(hasattr(self, "invocation") and isinstance(frontend_runtime_database_url, str), "P2_WORKER_ACTUAL_INVOCATION_AND_RUNTIME_URL_REQUIRED")
        self._boundary(False)
        command = self.prior["pendingRecord"]["pending"]["command"]
        private = {"version": 1, "environment": "staging", "stage": "lifecycle-account", "userId": command["userId"],
            "selectedCommand": {"commandId": command["commandId"], "accountVersion": command["accountVersion"]}}
        expected = self.expected_profile
        subject_binding = persistence._subject_binding(private)
        if expected is None:
            observed = persistence.observe_with_scope(self.reviewed["plan"], private, HeldWorkerPersistenceScope(self), frontend_runtime_database_url)
            witness = observed["witness"]
        else:
            release_evidence = {"originalReleaseReceipt": self.release_evidence["originalReleaseReceipt"],
                "frontendDeploymentRecord": self.release_evidence["readyReceipts"]["frontend-promotion-outcome.json"]}
            replacement = "replacementRelease" in getattr(self.scope, "certification_plan", {})
            receipt = persistence.execute_profiled(self.bundle, self.configuration, self.reviewed, self.source,
                {"frontendRuntimeDatabaseUrl": frontend_runtime_database_url, "witness": private}, release_evidence,
                self.scope, self.database_proof, expected_profile=expected, **({"_worker_stage": self} if replacement else {}))
            migrate.require_profile(expected, receipt)
            retained = persistence.load_retained_capture(self.reviewed["plan"], self.directory, "lifecycle-account", subject_binding,
                expected_profile=expected)
            record_sha = retained["recordSha256"]
            witness = retained["record"]["witness"]
            demand(receipt.get("version") == 2 and receipt.get("status") == "P2_LIFECYCLE_ACCOUNT_STATE_WITNESSED"
                and receipt.get("privateRecordSha256") == record_sha and receipt.get("operatorProgramSha256") == self.reviewed["programSha256"]
                and retained["record"]["priorRecordSha256"] is None, "P2_WORKER_PROFILED_WITNESS_RETAINED_REQUIRED")
        demand(witness["command"]["commandId"] == command["commandId"] and witness["command"]["canonicalSha256"] == self.plan["canonicalCommandSha256"]
            and all(value["status"] == "suspended" for value in witness["receivers"].values())
            and all(row["status"] == "acknowledged" and row["attempts"] >= 1 and row["leaseId"] is None and row["leaseUntil"] is None and row["acknowledgedAt"] for row in witness["frontend"]["deliveries"])
            and witness["frontend"]["laterCommandCount"] == 0 and witness["frontend"]["pendingOrDeliveringCount"] == 0, "P2_WORKER_BOTH_ACK_SOURCE_WITNESS_REQUIRED")
        if expected is None:
            record = {"version": 1, "stage": "lifecycle-account", "subjectBindingSha256": subject_binding,
                "contextSha256": persistence._context_binding(self.reviewed["plan"]), "witness": witness, "privateEvidence": observed.get("privateEvidence"),
                "receipt": observed["receipt"], "priorRecordSha256": None}
            record_sha = write_record(self.directory, "lifecycle-account.json", record)
            retained = persistence.load_retained_capture(self.reviewed["plan"], self.directory, "lifecycle-account")
            demand(retained["recordSha256"] == record_sha, "P2_WORKER_DURABLE_WITNESS_REQUIRED")
        self.witness_record_sha256 = record_sha
        self._boundary(False)
        return {**_profile_fields(expected), "status": "P2_DIRECT_WORKER_BOTH_ACK_WITNESSED", "bindingSha256": digest(canonical(self.plan)),
            "privateRecordSha256": record_sha, "receiverAcknowledgedCount": 2, "pendingOrDeliveringCount": 0, "readOnly": True, "releaseAccepted": False}

    def observe_receiver_denials(self):
        demand(hasattr(self, "witness_record_sha256"), "P2_WORKER_ORDERED_WITNESS_REQUIRED")
        self._boundary(False)
        command = self.prior["pendingRecord"]["pending"]["command"]
        browser = self.prior["browserRecord"]
        course = P2LifecycleSuspensionEvidenceStage._course_runtime(self)
        expected = self.expected_profile
        configuration = self.scope.runtime_mount_configuration("community-api", self.configuration) if expected is not None else self.configuration
        community_file = configuration/"community-api.env"
        info = community_file.lstat()
        demand(not community_file.is_symlink() and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600, "P2_WORKER_PRIVATE_COMMUNITY_RUNTIME_REQUIRED")
        community = runtime.environment_values(migrate.read_input(configuration, community_file.name, 65536), "staging", "community-api", self.jobs,
            expected_profile=expected)
        program = denial_program(self.source)
        values = {}
        for service, environment, mode in (("course", course, "course-http"), ("community", community, "community-private-guard")):
            self.verify()
            target = self.reviewed["plan"]["targets"]["community"]
            payload = {"version": 1, "mode": mode, "environment": "staging", "bindingSha256": digest(canonical(self.plan)), "subject": command["userId"],
                "courseId": browser["courseId"], "currentKey": environment["COURSE_LEARNER_JWT_CURRENT_SECRET" if service == "course" else "COMMUNITY_MEMBER_JWT_CURRENT_SECRET"],
                "gatewayCaSha256": digest(migrate.read_input(self.configuration, "tls/gateway/ca.pem", 65536)) if service == "course" else None,
                "runtimeEnvironment": None if service == "course" else environment,
                "target": None if service == "course" else {key: target[key] for key in ("host", "port", "database", "runtimeRole", "runtimeRoleOid", "serverMajor")}}
            container = next(row["containerId"] for row in self.inventory if row["service"] == ("gateway" if service == "course" else "community-api"))
            result = self.scope.run(["docker", "exec", "-i", "--workdir", "/app", "--env", "NODE_OPTIONS=--max-old-space-size=96", "--env", "DOTENV_CONFIG_QUIET=true",
                container, "node", "--input-type=module", "--eval", program.decode()], input=canonical(payload), env=runtime.SAFE_ENV, timeout=30, capture_output=True)
            demand(result.returncode == 0 and not result.stderr and 0 < len(result.stdout) <= 8192, "P2_WORKER_ACTUAL_RECEIVER_DENIAL_REQUIRED")
            value = json.loads(result.stdout)
            demand(value.get("status") == "P2_LIFECYCLE_RECEIVER_DENIAL_OBSERVED" and value.get("bindingSha256") == digest(canonical(self.plan))
                and value.get("service") == service and value.get("denialStatusCode") == 403 and value.get("accountRestrictionVerified") is True
                and value.get("freshCurrentToken") is True and value.get("tokenBytesOutput") is False, "P2_WORKER_RECEIVER_DENIAL_SOURCE_REQUIRED")
            demand((service == "course" and value.get("evidenceClass") == "actual-protected-course-http" and value.get("httpStatus") == 403)
                or (service == "community" and value.get("evidenceClass") == "deployed-private-community-account-access-guard" and value.get("httpStatus") is None
                    and value.get("actualRepositoryRead") is True and value.get("actualGuardInvoked") is True and value.get("readOnlyDatabase") is True),
                "P2_WORKER_RECEIVER_EVIDENCE_CLASS_REQUIRED")
            values[service] = value
            self.verify()
        self._boundary(False)
        value = {**_profile_fields(expected), "status": "P2_DIRECT_WORKER_RECEIVERS_DENIED", "bindingSha256": digest(canonical(self.plan)), **values,
            "receiverDeniedCount": 2, "receiverDeniedHttpCount": 1, "nativeInvocationQualified": False}
        write_record(self.directory, "receiver-denials.json", value)
        self.denials = value
        return value

    def final_closed_readback(self):
        current = self._boundary(False)
        return {**_profile_fields(self.expected_profile), "status": "P2_DIRECT_WORKER_FINAL_CLOSED", "bindingSha256": digest(canonical(self.plan)),
            "frontendAdmissionClosed": True, "gatewayAdmissionClosed": True, "nativeEnabled": False,
            "active": current["active"], "uncertain": current["uncertain"]}

    def retain_joined_from_source_parent(self, record):
        demand(hasattr(self, "denials") and hasattr(self, "witness_record_sha256") and hasattr(self, "invocation"), "P2_WORKER_JOINED_SOURCE_STAGES_REQUIRED")
        self._boundary(False)
        expected = self.expected_profile
        migrate.require_profile(expected, record)
        if expected is not None:
            demand(type(record.get("version")) is int and record["version"] == 2
                and record.get("sourceProgramSha256") == self.plan["sourceProgramSha256"],
                "P2_WORKER_PROFILED_JOINED_SOURCE_REQUIRED")
        command = self.prior["pendingRecord"]["pending"]["command"]
        demand(record.get("status") == "P2_DIRECT_LIFECYCLE_WORKER_JOINED" and record.get("bindingSha256") == digest(canonical(self.plan))
            and all(record.get(name) == self.plan[name] for name in ("candidateSha256", "configurationSha256", "sourceCommit", "targetSha256", "pendingRecordSha256"))
            and record.get("commandId") == command["commandId"] and record.get("accountVersion") == command["accountVersion"] and record.get("action") == "suspend"
            and record.get("workerInvokedAt") == self.invocation["workerInvokedAt"] and record.get("invocation") == self.invocation
            and record.get("nativeScheduleEnabled") is False and record.get("nativeInvocationQualified") is False
            and record.get("lifecyclePrivateRecordSha256") == self.witness_record_sha256
            and record.get("receiverDenials") == {service: self.denials[service] for service in ("course", "community")}
            and record.get("receiverDeniedCount") == 2 and record.get("receiverDeniedHttpCount") == 1
            and record.get("frontendActive") == 0 and record.get("frontendUncertain") == 0 and record.get("releaseAccepted") is False,
            "P2_WORKER_JOINED_SOURCE_READBACK_REQUIRED")
        value = {**_profile_fields(expected), "status": "P2_DIRECT_WORKER_MACHINE_ARTIFACT", "planSha256": digest(canonical(self.plan)),
            "record": record, "sourceProgramSha256": digest(migrate.read_input(self.source, "ops/platform/p2-lifecycle-worker-evidence.mjs")),
            "hostProgramSha256": digest(migrate.read_input(self.source, "ops/platform/host/p2_lifecycle_worker_evidence.py")),
            **({"releaseEvidence": self.prior["releaseEvidence"]} if expected is not None else {})}
        record_sha = write_record(self.directory, "joined-worker.json", value)
        self._boundary(False)
        return {**_profile_fields(expected), "status": "P2_DIRECT_WORKER_JOINED_RETAINED", "privateRecordSha256": record_sha,
            "receiverDeniedCount": 2, "receiverDeniedHttpCount": 1, "nativeInvocationQualified": False, "releaseAccepted": False}


def load_retained_worker(scope, selected, jobs, configuration, source, plan, suspension_plan, persistence_reviewed, expected_record_sha256,
                         *, expected_profile=None, release_evidence=None, database_proof=None):
    """Source-only S13 adapter: fixed root-private bytes, no caller record JSON."""
    expected = worker_profile(scope, plan, suspension_plan, persistence_reviewed, expected_profile)
    if expected is not None:
        current_databases.read_certification_api_proof(database_proof, scope, selected, jobs, expected_profile=expected)
    else:
        demand(release_evidence is None and database_proof is None, "P2_WORKER_LEGACY_INPUTS_REQUIRED")
    prior = load_retained_suspension(scope, selected, jobs, configuration, source, suspension_plan, persistence_reviewed, plan["pendingRecordSha256"],
        expected_profile=expected, release_evidence=release_evidence)
    source = Path(source)
    demand(re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", plan.get("actionId", "")) and re.fullmatch(r"[a-f0-9]{64}", expected_record_sha256 or "")
        and plan.get("profile") == "direct-known-suspension-v1" and plan.get("suspensionPlanSha256") == digest(canonical(suspension_plan))
        and all(plan.get(name) == suspension_plan.get(name) for name in ("candidateSha256", "candidateObjectSha256", "sourceCommit", "configurationSha256", "targetSha256"))
        and digest(migrate.read_input(source, "ops/platform/p2-lifecycle-worker-evidence.mjs")) == plan["sourceProgramSha256"]
        and digest(migrate.read_input(source, "ops/platform/host/p2_lifecycle_worker_evidence.py")) == plan["hostProgramSha256"]
        and digest(denial_program(source)) == plan["denialProgramSha256"], "P2_WORKER_RETAINED_SOURCE_CONTEXT_REQUIRED")
    directory = ROOT/("p2-worker-"+plan["actionId"])
    demand(not any(path.is_symlink() for path in (directory, *directory.parents)), "P2_WORKER_RETAINED_PATH_REQUIRED")
    info = directory.lstat()
    demand(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700, "P2_WORKER_RETAINED_DIRECTORY_REQUIRED")
    descriptor = os.open(directory/"joined-worker.json", os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        info = os.fstat(descriptor)
        demand(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600 and 0 < info.st_size <= 262144, "P2_WORKER_RETAINED_RECORD_REQUIRED")
        raw = os.read(descriptor, 262145)
        demand(len(raw) == info.st_size and digest(raw) == expected_record_sha256, "P2_WORKER_RETAINED_BYTES_CHANGED")
    finally:
        os.close(descriptor)
    if expected is None:
        envelope = json.loads(raw)
    else:
        from qualification_target_profile import decode_qualification_target_json
        envelope = decode_qualification_target_json(raw, "carrier")
    record = envelope.get("record", {})
    migrate.require_profile(expected, envelope, record)
    if expected is not None:
        migrate.require_profile(expected, record.get("invocation"))
        demand(all(type(value.get("version")) is int and value["version"] == 2
                for value in (envelope, record, record["invocation"]))
            and record.get("sourceProgramSha256") == plan["sourceProgramSha256"]
            and envelope.get("releaseEvidence") == prior["releaseEvidence"]
            and Path(persistence_reviewed["privateDirectory"]) == directory, "P2_WORKER_PROFILED_RETAINED_IDENTITY_REQUIRED")
    command = prior["pendingRecord"]["pending"]["command"]
    demand(envelope.get("status") == "P2_DIRECT_WORKER_MACHINE_ARTIFACT" and envelope.get("planSha256") == digest(canonical(plan))
        and envelope.get("sourceProgramSha256") == plan["sourceProgramSha256"] and envelope.get("hostProgramSha256") == plan["hostProgramSha256"]
        and record.get("status") == "P2_DIRECT_LIFECYCLE_WORKER_JOINED" and record.get("bindingSha256") == digest(canonical(plan))
        and all(record.get(name) == plan[name] for name in ("candidateSha256", "configurationSha256", "sourceCommit", "targetSha256", "pendingRecordSha256"))
        and record.get("commandId") == command["commandId"] and record.get("accountVersion") == command["accountVersion"] and record.get("action") == "suspend"
        and record.get("nativeScheduleEnabled") is False and record.get("nativeInvocationQualified") is False
        and record.get("receiverDeniedCount") == 2 and record.get("receiverDeniedHttpCount") == 1
        and record.get("workerInvokedAt", "") > prior["user"]["firstDenied"]["responseEndedAt"], "P2_WORKER_RETAINED_CANONICAL_AUTHORITY_REQUIRED")
    subject_binding = None if expected is None else persistence._subject_binding({"stage": "lifecycle-account", "userId": command["userId"],
        "selectedCommand": {name: command[name] for name in ("commandId", "accountVersion")}})
    witness = persistence.load_retained_capture(persistence_reviewed["plan"], directory, "lifecycle-account", subject_binding,
        expected_profile=expected)
    demand(witness["recordSha256"] == record["lifecyclePrivateRecordSha256"] and witness["record"]["witness"]["command"]["commandId"] == command["commandId"]
        and witness["record"]["witness"]["command"]["canonicalSha256"] == plan["canonicalCommandSha256"], "P2_WORKER_RETAINED_BOTH_ACK_WITNESS_REQUIRED")
    scope.require_frontend(selected, jobs["frontend"]); scope.require_configuration(configuration)
    return {"record": record, "recordSha256": expected_record_sha256, "lifecycleCapture": witness, "suspension": prior}
