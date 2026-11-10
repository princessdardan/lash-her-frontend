"""Staging-current receiver evidence under the held lifecycle worker action."""
import copy
import json
import os
import re
import stat
import threading

import migrate
import p2_lifecycle_persistence_probe as persistence
import release as runtime
from p2_lifecycle_receiver_negative import (
    CASES, PROGRAM, SCOPED_REFUSAL, SHA, TARGET_PROFILE_PROGRAM, WITNESS_PROGRAM,
    _baseline, _canonical, _closed, _fresh_id, _hash, private_program,
)

demand = migrate.demand
SCOPED_PROFILE = "suspended-head-negatives-v2"
HOST_PROGRAM = "ops/platform/host/p2_scoped_lifecycle_receiver_negatives.py"
LAUNCHER_PROGRAM = "ops/platform/host/p2_lifecycle_receiver_negative.py"
CASE_ORDER = tuple((service, case) for service in ("course", "community") for case in (*CASES, "future-gap"))
SCOPED_CASE_STATUS = "P2_DIRECT_WORKER_RECEIVER_NEGATIVE_CASE_OBSERVED"
SCOPED_JOINED_STATUS = "P2_DIRECT_WORKER_RECEIVER_NEGATIVES_JOINED"


class P2ScopedLifecycleReceiverNegatives:
    """Fixed receiver cases under the same profiled worker and physical lease."""

    def __init__(self, worker):
        from p2_certification_parent import P2CertificationScope
        from p2_lifecycle_worker_evidence import P2LifecycleWorkerEvidenceStage, canonical
        from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE

        profile = migrate.profile_context(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)
        demand(type(worker) is P2LifecycleWorkerEvidenceStage and type(worker.scope) is P2CertificationScope
            and worker.expected_profile == worker.scope._expected_profile == profile
            and worker.scope.certification_plan.get("workerPlan") == worker.plan
            and _closed(worker.plan.get("receiverNegatives"), ("profile", "sourceSha256", "hostSourceSha256"))
            and worker.plan["receiverNegatives"]["profile"] == SCOPED_PROFILE
            and isinstance(getattr(worker, "witness_record_sha256", None), str)
            and SHA.fullmatch(worker.witness_record_sha256), SCOPED_REFUSAL)
        self.worker, self.scope, self.profile = worker, worker.scope, profile
        self.binding = _hash(canonical(worker.plan))
        self.positive_sha = worker.witness_record_sha256
        self.directory = worker.directory / "receiver-negatives"
        self._lock = threading.Lock()
        self._blocked = False
        self._pending_post = None
        self._rows = []
        self._summary = None
        self._baseline_sha = None
        self._verify_inputs()
        manifest = worker.reviewed["operatorSourceFiles"]
        reviewed = worker.plan["receiverNegatives"]
        demand(manifest.get(PROGRAM) == reviewed["sourceSha256"]
            and manifest.get(HOST_PROGRAM) == reviewed["hostSourceSha256"], SCOPED_REFUSAL)
        for path in (PROGRAM, HOST_PROGRAM, LAUNCHER_PROGRAM, WITNESS_PROGRAM, TARGET_PROFILE_PROGRAM):
            digest = _hash(migrate.read_input(worker.source, path))
            demand(digest == manifest.get(path), SCOPED_REFUSAL)
        self.program = private_program(worker.source, self.profile, guarded_future_gap=True).decode()
        migrate.private_directory(worker.directory)
        self.directory.mkdir(mode=0o700)

    def _fields(self):
        return {"version": 2, "qualificationTargetProfile": self.profile, "bindingSha256": self.binding}

    def _verify_inputs(self):
        from p2_lifecycle_worker_evidence import canonical

        self.scope.verify()
        worker = self.worker
        certification = self.scope.certification_plan
        demand(worker.scope is self.scope and worker.expected_profile == self.profile
            and certification.get("mode") == "direct-worker"
            and certification.get("certificationActionId") == worker.plan.get("actionId")
            and certification.get("workerPlan") == worker.plan
            and certification.get("workerPlanSha256") == self.binding == _hash(canonical(worker.plan))
            and worker.witness_record_sha256 == self.positive_sha
            and worker.invocation_attempted is True and worker.invocation.get("status") == "P2_DIRECT_WORKER_HTTP_OBSERVED"
            and worker.invocation.get("httpStatus") == 200, SCOPED_REFUSAL)

    def _boundary(self):
        self._verify_inputs()
        admission = self.worker._boundary(False)
        initial_epoch = self.scope.certification_plan.get("initialEpoch")
        demand(isinstance(initial_epoch, str) and re.fullmatch(r"[1-9][0-9]{0,17}", initial_epoch)
            and _canonical(admission) == _canonical({"epoch": str(int(initial_epoch) + 2), "newWork": False,
                "recovery": False, "active": 0, "uncertain": 0}), SCOPED_REFUSAL)
        self._verify_inputs()

    def _positive(self):
        worker = self.worker
        command = worker.prior["pendingRecord"]["pending"]["command"]
        private = {"version": 1, "environment": "staging", "stage": "lifecycle-account", "userId": command["userId"],
            "selectedCommand": {"commandId": command["commandId"], "accountVersion": command["accountVersion"]}}
        retained = persistence.load_retained_capture(worker.reviewed["plan"], worker.directory, "lifecycle-account",
            persistence._subject_binding(private), expected_profile=self.profile)
        record = retained["record"]
        witness = record["witness"]
        demand(retained["recordSha256"] == self.positive_sha and record["priorRecordSha256"] is None
            and witness["userId"] == private["userId"] and witness["command"]["commandId"] == command["commandId"]
            and witness["command"]["accountVersion"] == command["accountVersion"]
            and witness["command"]["canonicalSha256"] == worker.plan["canonicalCommandSha256"]
            and record["receipt"]["witnessSha256"] == _hash(_canonical(witness)), SCOPED_REFUSAL)
        return private, witness

    def _observe(self, private, runtime_url, positive):
        worker = self.worker
        reader = persistence.HeldCertificationPersistenceScope(self.scope, worker.selected, worker.jobs,
            worker.reviewed, worker.configuration, worker.source, worker.database_proof, self.profile, self._verify_inputs)
        observed = persistence.observe_with_scope(worker.reviewed["plan"], private, reader, runtime_url, expected_profile=self.profile)
        witness, receipt, observations = (observed[key] for key in ("witness", "receipt", "observations"))
        _baseline(witness, observations)
        demand(_canonical(witness) == _canonical(positive)
            and receipt["witnessSha256"] == _hash(_canonical(witness)), SCOPED_REFUSAL)
        stable = {name: persistence._stable_observation(value) for name, value in observations.items()}
        return witness, receipt["witnessSha256"], _hash(_canonical(stable)), observations

    def _child(self, service, payload, status):
        from qualification_target_profile import decode_qualification_target_json

        mode = payload["mode"]
        demand(service in ("course", "community") and mode in ("runtime-binding", "post"), SCOPED_REFUSAL)
        if mode == "post":
            selection = (service, payload.get("case"))
            demand(selection in CASE_ORDER and self._pending_post == selection, SCOPED_REFUSAL)
            self._pending_post = None
        worker = self.worker
        container = "gateway" if mode == "post" else service + "-api"
        identifier = next(row["containerId"] for row in worker.inventory if row["service"] == container)
        demand(re.fullmatch(r"[a-f0-9]{64}", identifier) is not None, SCOPED_REFUSAL)
        args = ["docker", "exec", "-i", "--workdir", "/app", "--env", "NODE_OPTIONS=--max-old-space-size=96",
            "--env", "DOTENV_CONFIG_QUIET=true", identifier, "node", "--input-type=module", "--eval", self.program]
        packet = _canonical({**self._fields(), "environment": "staging", "service": service, **payload})
        demand(0 < len(packet) <= 262_144, SCOPED_REFUSAL)
        self._verify_inputs()
        result = self.scope.run(args, input=packet, env=runtime.SAFE_ENV, timeout=20, capture_output=True)
        demand(result.returncode == 0 and not result.stderr and 0 < len(result.stdout) <= 65536, SCOPED_REFUSAL)
        response = decode_qualification_target_json(result.stdout, "carrier")
        migrate.require_profile(self.profile, response)
        demand(response.get("status") == status, SCOPED_REFUSAL)
        self._verify_inputs()
        return response

    def _environment(self, service):
        worker = self.worker
        configuration = self.scope.runtime_mount_configuration(service + "-api", worker.configuration)
        path = configuration / (service + "-api.env")
        info = path.lstat()
        demand(not path.is_symlink() and stat.S_ISREG(info.st_mode) and info.st_uid == 0
            and stat.S_IMODE(info.st_mode) == 0o600, SCOPED_REFUSAL)
        values = runtime.environment_values(migrate.read_input(configuration, path.name, 65_536), "staging",
            service + "-api", worker.jobs, expected_profile=self.profile)
        status = "P2_LIFECYCLE_RECEIVER_RUNTIME_BOUND"
        result = self._child(service, {"mode": "runtime-binding", "runtimeEnvironment": values}, status)
        demand(_canonical(result) == _canonical({**self._fields(), "status": status, "service": service,
            "runtimeConfigurationVerified": True, "globallyReadOnly": True, "releaseAccepted": False}), SCOPED_REFUSAL)
        return values

    def _retain(self, name, value):
        from p2_frontend_replacement_parent import private_record

        raw = _canonical(value) + b"\n"
        demand(len(raw) <= 65_536, SCOPED_REFUSAL)
        migrate.write_exact_bytes(self.directory, name, raw)
        demand(private_record(self.directory, name) == raw, SCOPED_REFUSAL)
        return _hash(raw)

    def observe_next(self, runtime_url):
        demand(self._lock.acquire(blocking=False), SCOPED_REFUSAL)
        try:
            demand(not self._blocked and len(self._rows) < len(CASE_ORDER)
                and isinstance(runtime_url, str) and 0 < len(runtime_url) <= 8192, SCOPED_REFUSAL)
            self._blocked = True
            service, case = CASE_ORDER[len(self._rows)]
            self._boundary()
            private, positive = self._positive()
            environment = self._environment(service)
            witness, before_sha, stable_sha, observations = self._observe(private, runtime_url, positive)
            demand(self._baseline_sha in (None, stable_sha), SCOPED_REFUSAL)
            fresh = _fresh_id(observations) if case in ("stale-restore", "future-gap") else None
            common = {**self._fields(), "service": service, "case": case, "positiveWitnessSha256": self.positive_sha}
            name = service + "-" + case
            intent_sha = self._retain(name + "-intent.json", {**common, "status": "P2_RECEIVER_CASE_INTENT_RETAINED",
                "freshCommandId": fresh, "beforeWitnessSha256": before_sha, "beforeStateSha256": stable_sha,
                "automaticReplayAllowed": False})
            self._boundary()
            expected_status, code = {
                "exact-replay": (200, "duplicate"), "changed-replay": (409, "idempotency_conflict"),
                "stale-restore": (409, "account_version_conflict"),
                "future-gap": (409, "account_version_conflict"),
            }[case]
            configuration = self.worker.configuration
            gateway_sha = _hash(migrate.read_input(configuration, "gateway.json", 65_536))
            demand(gateway_sha == self.worker.plan["gatewayConfigurationSha256"], SCOPED_REFUSAL)
            status = "P2_LIFECYCLE_RECEIVER_CASE_PASS"
            payload = {"mode": "post", "case": case, "witness": witness, "freshCommandId": fresh,
                "secret": environment.get(service.upper() + "_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET"),
                "gatewayConfigurationSha256": gateway_sha,
                "gatewayCaSha256": _hash(migrate.read_input(configuration, "tls/gateway/ca.pem", 65_536))}
            self._pending_post = (service, case)
            try:
                receipt = self._child(service, payload, status)
            finally:
                self._pending_post = None
                payload["secret"] = None
            demand(_canonical(receipt) == _canonical({**self._fields(), "status": status, "service": service, "case": case,
                "witnessSha256": before_sha, "httpStatus": expected_status, "result": code,
                "domainStatePreservationRequiresReadback": True, "globallyReadOnly": False, "oidcVerified": False,
                "releaseAccepted": False}), SCOPED_REFUSAL)
            http_sha = self._retain(name + "-http.json", receipt)
            _after, after_sha, after_stable_sha, after = self._observe(private, runtime_url, positive)
            demand(after_stable_sha == stable_sha and after_sha == before_sha
                and (fresh is None or all(not any(row["command_id"] == fresh for row in value["commands"])
                    for value in after.values())), SCOPED_REFUSAL)
            demand(self._environment(service) == environment, SCOPED_REFUSAL)
            self._boundary()
            row = {**self._fields(), "status": SCOPED_CASE_STATUS, "service": service, "case": case,
                "httpStatus": expected_status, "result": code, "beforeWitnessSha256": before_sha,
                "afterWitnessSha256": after_sha, "accountAndDomainStateUnchanged": True,
                "quotaWritesExcluded": True, "globallyReadOnly": False, "releaseAccepted": False}
            retained = self._retain(name + "-readback.json", {**row, "positiveWitnessSha256": self.positive_sha,
                "intentSha256": intent_sha, "httpReceiptSha256": http_sha, "stateSha256": stable_sha})
            row["privateRecordSha256"] = retained
            self._rows.append(row)
            self._baseline_sha = stable_sha
            self._blocked = False
            return copy.deepcopy(row)
        finally:
            self._lock.release()

    def require_joined(self):
        from p2_frontend_replacement_parent import private_record

        demand(self._lock.acquire(blocking=False), SCOPED_REFUSAL)
        try:
            demand(not self._blocked and [(row["service"], row["case"]) for row in self._rows] == list(CASE_ORDER),
                SCOPED_REFUSAL)
            self._boundary()
            self._positive()
            for row in self._rows:
                name = row["service"] + "-" + row["case"]
                raw = private_record(self.directory, name + "-readback.json")
                case = json.loads(raw)
                demand(_hash(raw) == row["privateRecordSha256"]
                    and _hash(private_record(self.directory, name + "-intent.json")) == case["intentSha256"]
                    and _hash(private_record(self.directory, name + "-http.json")) == case["httpReceiptSha256"],
                    SCOPED_REFUSAL)
            summary = {**self._fields(), "status": SCOPED_JOINED_STATUS, "positiveWitnessSha256": self.positive_sha,
                "cases": copy.deepcopy(self._rows), "openCases": [], "domainStatePreserving": True,
                "quotaWritesExcluded": True, "globallyReadOnly": False, "oidcVerified": False, "releaseAccepted": False}
            filename = "receiver-negatives-joined.json"
            if self._summary is None:
                self._summary = self._retain(filename, summary)
            raw = private_record(self.directory, filename)
            demand(_hash(raw) == self._summary and raw == _canonical(summary) + b"\n", SCOPED_REFUSAL)
            return {**summary, "privateRecordSha256": self._summary}
        finally:
            self._lock.release()
