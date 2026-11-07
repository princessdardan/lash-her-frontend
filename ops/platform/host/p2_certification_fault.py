"""In-process one-record fault stage. No standalone activation or container stop."""
import copy
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
import migrate
import release as runtime
import p2_identity_negative_probe as identity
from p2_release_scope import P2ReleaseScope
from p2_source_closure import PROFILED_CERTIFICATION_MODE, verify_profiled_current_source_closure, verify_source_closure

LEASE = "p2-certification-fault.json"
LOCK = Path("/run/lock/lash-her-release.lock")
ROOT = Path("/var/lib/lash-her/releases/staging")
OPERATOR_ROOT = Path("/opt/lash-her/operators")
MODULE = "ops/gateway/p2-certification-fault.mjs"
SHA = re.compile(r"^[a-f0-9]{64}$")
UUID = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$")
PROFILED_PLAN_FIELDS = frozenset((
    "version", "qualificationTargetProfile", "environment", "profile", "actionId", "stageId", "sourceCommit",
    "candidateSha256", "candidateObjectSha256", "nativePlanSha256", "targetSha256", "mode", "receiver", "commandSha256",
    "configurationSha256", "gatewayConfigurationSha256", "gatewayImageSha256", "gatewayProcessSha256", "commandSelectionSha256",
    "operatorSourceCommit", "operatorSourceClosureSha256", "leaseMilliseconds", "maxMatches", "finalDisposition",
    "standaloneActivationEligible", "automaticReplayAllowed", "automaticReconciliationAllowed", "releaseAccepted",
))
demand = migrate.demand

GATEWAY_OBSERVER = r'''
import {readFileSync,existsSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {get} from 'node:http';
import {p2GatewayProcessBinding} from './p2-certification-fault.mjs';
const sha=v=>createHash('sha256').update(v).digest('hex');
try{
 const stat=readFileSync('/proc/1/stat','utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/u);
 const processSha256=p2GatewayProcessBinding({bootId:readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),pid:1,startTicks:fields[19]});
 const admission=await new Promise((resolve,reject)=>{const req=get({hostname:'127.0.0.1',port:9100,path:'/admission',timeout:2000},res=>{
  let raw='';res.on('data',chunk=>{raw+=chunk;if(Buffer.byteLength(raw)>8192)res.destroy()});res.once('error',reject);res.once('end',()=>{
   try{if(res.statusCode!==200)throw Error();resolve(JSON.parse(raw))}catch{reject(Error())}})});req.once('timeout',()=>req.destroy());req.once('error',reject)});
 const directory=statSync('/admission',{bigint:true});
 console.log(JSON.stringify({version:1,status:'P2_FAULT_GATEWAY_CURRENT',processSha256,gatewayConfigurationSha256:sha(readFileSync('/config/gateway.json')),
  admissionDirectory:{device:directory.dev.toString(),inode:directory.ino.toString()},
  faultModuleSha256:sha(readFileSync('/app/p2-certification-fault.mjs')),admission,faultLeasePresent:existsSync('/admission/p2-certification-fault.json')}));
}catch{console.log(JSON.stringify({version:1,status:'P2_FAULT_GATEWAY_CURRENT_REFUSED'}));process.exitCode=1}
'''


def _hash(value):
    return hashlib.sha256(value).hexdigest()


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


def _closed(value, names):
    return isinstance(value, dict) and set(value) == set(names)


def frontend_target_sha256(target):
    """Match frontendAdmissionTargetSha256's fixed insertion order exactly."""
    names = ("host", "port", "database", "user", "serverMajor")
    demand(isinstance(target, dict) and all(name in target for name in names), "P2_FAULT_FE_JOB_TARGET_REQUIRED")
    value = {"environment": "staging", **{name: target[name] for name in names}}
    return _hash(json.dumps(value, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode())


def bind_frontend_scope(scope, selected, jobs, plan):
    scope.require_release(selected, jobs)
    demand(isinstance(jobs.get("frontend"), dict), "P2_FAULT_FE_JOB_REQUIRED")
    proof = scope.require_frontend(selected, jobs["frontend"])
    job = jobs["frontend"]["job"]
    demand(plan.get("targetSha256") == frontend_target_sha256(job["target"])
        and plan.get("sourceCommit") == job.get("sourceCommit") == selected["sources"]["frontend"]["commit"],
        "P2_FAULT_FE_PHYSICAL_SCOPE_PLAN_MISMATCH")
    return proof


def _write_all(descriptor, raw):
    remaining = raw
    while remaining:
        written = os.write(descriptor, remaining)
        demand(written > 0, "P2_FAULT_DURABLE_WRITE_REQUIRED")
        remaining = remaining[written:]
    os.fsync(descriptor)


class P2CertificationFaultStage:
    """Requires the real parent scope and its independent FE physical observer.

    The source parent owns the FE client/owner/locks and mandatory containment.
    This object never releases those locks, restarts a container, reopens a gate
    or reconciles an uncertain operation. JSON cannot construct its P2 scope.
    """
    def __init__(self, scope, selected, jobs, configuration, operator_source, plan, directory, *, source_files, expected_profile=None):
        demand(isinstance(scope, P2ReleaseScope) and scope.path == LOCK and scope.release is not None and scope.jobs is not None,
            "P2_FAULT_ACTUAL_FE_BOUND_PARENT_SCOPE_REQUIRED")
        expected = migrate.profile_context(expected_profile)
        migrate.require_profile(expected, selected, plan)
        if expected is not None:
            from p2_certification_parent import P2CertificationScope
            demand(type(scope) is P2CertificationScope and scope._expected_profile == expected,
                "P2_FAULT_ACTUAL_FE_BOUND_PARENT_SCOPE_REQUIRED")
            migrate.candidate_profile(selected, expected)
            demand(_closed(plan, PROFILED_PLAN_FIELDS) and plan["automaticReplayAllowed"] is False and plan["releaseAccepted"] is False,
                "P2_FAULT_FIXED_STAGE_PLAN_REQUIRED")
        demand(os.geteuid() == 0 and type(plan.get("version")) is int and plan["version"] == (2 if expected else 1) and plan.get("environment") == "staging"
            and plan.get("profile") == "lifecycle-known-command-v1" and plan.get("leaseMilliseconds") == 120000
            and plan.get("maxMatches") == 1 and plan.get("mode") in ("503-before-upstream", "drop-after-ack")
            and plan.get("receiver") in ("course", "community") and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", plan.get("stageId", ""))
            and plan.get("finalDisposition") == "fault-disabled-native-off-and-admission-closed"
            and plan.get("standaloneActivationEligible") is False and plan.get("automaticReconciliationAllowed") is False,
            "P2_FAULT_FIXED_STAGE_PLAN_REQUIRED")
        self.scope, self.selected, self.jobs = scope, copy.deepcopy(selected), copy.deepcopy(jobs)
        self.configuration, self.source, self.plan = Path(configuration), Path(operator_source), copy.deepcopy(plan)
        self.expected_profile = expected
        if expected is not None:
            self._profiled_command()
        demand(isinstance(source_files, dict) and source_files, "P2_FAULT_CLOSED_SOURCE_REQUIRED")
        self.source_initial = {"sourceSha256": copy.deepcopy(source_files), "sourceClosureSha256": _hash(_canonical(sorted(source_files.items())))}
        if expected is not None:
            self.source_initial.update(version=2, qualificationTargetProfile=expected, mode=PROFILED_CERTIFICATION_MODE)
        demand(self.source_initial["sourceClosureSha256"] == plan.get("operatorSourceClosureSha256"), "P2_FAULT_SOURCE_PLAN_BINDING_REQUIRED")
        self.directory = Path(directory)
        demand(self.configuration.is_absolute() and self.configuration.is_relative_to(ROOT)
            and re.fullmatch(r"[a-f0-9]{40}", plan.get("operatorSourceCommit", ""))
            and self.source == OPERATOR_ROOT / plan["operatorSourceCommit"]
            and ".." not in self.configuration.parts and self.configuration.resolve() == self.configuration
            and not any(path.is_symlink() for path in (self.configuration, *self.configuration.parents, self.source, *self.source.parents)),
            "P2_FAULT_REVIEWED_PATH_REQUIRED")
        bind_frontend_scope(scope, selected, jobs, plan); scope.require_configuration(configuration)
        self._verify_source()
        demand(selected.get("environment") == "staging" and selected.get("contractPhase") == "p2"
            and selected["releaseId"] == plan["actionId"] and scope.candidate_sha256 == plan["candidateSha256"]
            and _hash(_canonical(selected)) == plan["candidateObjectSha256"]
            and selected["sources"]["frontend"]["commit"] == plan["sourceCommit"]
            and selected["artifacts"]["gateway"]["image"].endswith("@sha256:" + plan["gatewayImageSha256"])
            and identity._configuration_hash(self.configuration) == plan["configurationSha256"], "P2_FAULT_SOURCE_CANDIDATE_CONFIGURATION_REQUIRED")
        demand(self.directory.is_absolute() and self.directory.is_relative_to(ROOT) and ".." not in self.directory.parts
            and self.directory.resolve() == self.directory and self.directory.parent.is_dir()
            and not any(path.is_symlink() for path in (self.directory, *self.directory.parents))
            and self.directory.parent.stat().st_uid == 0 and self.directory.parent.stat().st_mode & 0o077 == 0,
            "P2_FAULT_PRIVATE_STAGE_DIRECTORY_REQUIRED")
        self.directory.mkdir(mode=0o700, exist_ok=False)
        self.arm_called, self.lease_sha256, self.issued_at, self.closed = False, None, None, False
        self.admission_fd = os.open(self.configuration / "admission", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            info = os.fstat(self.admission_fd)
            demand(info.st_uid == 0 and not info.st_mode & 0o022, "P2_FAULT_ADMISSION_DIRECTORY_REQUIRED")
            self.admission_identity = info
            self.initial_inventory = self._inventory()
            if expected is not None:
                demand(_hash(_canonical(self.initial_inventory)) == scope.certification_plan.get("runtimeInventorySha256"),
                    "P2_FAULT_PROFILED_RUNTIME_INVENTORY_REQUIRED")
            self.gateway = next(row for row in self.initial_inventory if row["service"] == "gateway")
            identity._one_container(self.gateway, self.configuration, scope)
            self.module_sha256 = _hash(migrate.read_input(self.source, MODULE, 524288))
            self._gateway_current()
        except BaseException:
            os.close(self.admission_fd); self.closed = True
            raise

    def _receipt_fields(self):
        expected = self.expected_profile
        return {"version": 1} if expected is None else {"version": 2, "qualificationTargetProfile": expected}

    def _verify_source(self):
        verify = verify_source_closure if self.expected_profile is None else verify_profiled_current_source_closure
        return verify(self.source_initial, self.source)

    def _profiled_command(self):
        plan, cert, expected = self.plan, self.scope.certification_plan, self.expected_profile
        native, selection = cert.get("nativePlan"), cert.get("faultSelection")
        demand(type(native) is dict and type(selection) is dict and type(native.get("commandWitnesses")) is list,
            "P2_FAULT_PROFILED_SOURCE_SELECTION_REQUIRED")
        migrate.require_profile(expected, cert, native, native.get("target"))
        mode = {"fault-before-upstream": "503-before-upstream", "fault-drop-after-ack": "drop-after-ack",
                "known-ack-recovery": "drop-after-ack"}.get(cert.get("mode"))
        demand(cert.get("version") == native.get("version") == 2 and cert.get("startState") == "already-closed" and
            mode is not None and plan["mode"] == mode and type(selection.get("commandIndex")) is int and
            0 <= selection["commandIndex"] < len(native["commandWitnesses"]) and
            all(plan.get(key) == selection.get(key) for key in ("stageId", "receiver", "commandSha256")) and
            all(plan.get(key) == cert.get(key) for key in ("candidateSha256", "candidateObjectSha256", "targetSha256", "sourceCommit",
                "gatewayConfigurationSha256", "gatewayProcessSha256", "operatorSourceCommit", "operatorSourceClosureSha256")) and
            plan.get("operatorSourceCommit") == plan.get("sourceCommit") and plan.get("nativePlanSha256") == native.get("planSha256") and
            plan.get("configurationSha256") == cert.get("configurationCanonicalSha256") and
            plan.get("commandSelectionSha256") == _hash(_canonical({"nativePlanSha256": native["planSha256"], "commandIndex": selection["commandIndex"]})),
            "P2_FAULT_PROFILED_SOURCE_SELECTION_REQUIRED")
        return native["commandWitnesses"][selection["commandIndex"]]

    def _require_cleanup_lock(self):
        if self.expected_profile is not None:
            opened, current = os.fstat(self.scope.descriptor), self.scope.path.lstat()
            original = self.scope.identity
            demand(self.scope.path == LOCK and stat.S_ISREG(current.st_mode) and current.st_uid == os.getuid() and
                not current.st_mode & 0o077 and (current.st_dev, current.st_ino) == (opened.st_dev, opened.st_ino) ==
                (original.st_dev, original.st_ino), "P2_FAULT_PROFILED_CLEANUP_LOCK_CHANGED")
            fcntl.flock(self.scope.descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def _inventory(self):
        self.scope.verify()
        token = runtime._command_scope.set(self.scope)
        try:
            profile = {} if self.expected_profile is None else {"expected_profile": self.expected_profile}
            return runtime.check_containers(self.selected, self.configuration, **profile)
        finally:
            runtime._command_scope.reset(token)

    def verify(self):
        demand(not self.closed, "P2_FAULT_STAGE_CLOSED")
        bind_frontend_scope(self.scope, self.selected, self.jobs, self.plan); self.scope.require_configuration(self.configuration)
        self._verify_source()
        opened = os.fstat(self.admission_fd)
        demand(opened.st_dev == self.admission_identity.st_dev and opened.st_ino == self.admission_identity.st_ino,
            "P2_FAULT_CACHED_ADMISSION_DIRECTORY_CHANGED")
        if self.expected_profile is not None:
            self._profiled_command()
            current = (self.configuration / "admission").lstat()
            demand(stat.S_ISDIR(current.st_mode) and (opened.st_dev, opened.st_ino) == (current.st_dev, current.st_ino),
                "P2_FAULT_CURRENT_ADMISSION_DIRECTORY_CHANGED")
        demand(self._inventory() == self.initial_inventory and identity._configuration_hash(self.configuration) == self.plan["configurationSha256"]
            and _hash(migrate.read_input(self.source, MODULE, 524288)) == self.module_sha256, "P2_FAULT_RUNTIME_OR_SOURCE_CHANGED")
        identity._one_container(self.gateway, self.configuration, self.scope)

    def _gateway_current(self):
        self.scope.verify()
        result = self.scope.run(["docker", "exec", "--workdir", "/app", self.gateway["containerId"], "node", "--input-type=module", "--eval", GATEWAY_OBSERVER],
            env=runtime.SAFE_ENV, timeout=10, capture_output=True)
        demand(result.returncode == 0 and not result.stderr and 0 < len(result.stdout) <= 16384, "P2_FAULT_GATEWAY_READBACK_REQUIRED")
        value = json.loads(result.stdout)
        demand(_closed(value, ("version", "status", "processSha256", "gatewayConfigurationSha256", "faultModuleSha256", "admissionDirectory", "admission", "faultLeasePresent"))
            and value["version"] == 1 and value["status"] == "P2_FAULT_GATEWAY_CURRENT"
            and value["processSha256"] == self.plan["gatewayProcessSha256"] and value["gatewayConfigurationSha256"] == self.plan["gatewayConfigurationSha256"]
            and value["faultModuleSha256"] == self.module_sha256 and type(value["faultLeasePresent"]) is bool
            and value["admissionDirectory"] == {"device": str(self.admission_identity.st_dev), "inode": str(self.admission_identity.st_ino)},
            "P2_FAULT_EXACT_GATEWAY_PROCESS_REQUIRED")
        return value

    def observe(self):
        self.verify()
        value = self._gateway_current()
        return {**self._receipt_fields(), "status": "P2_FAULT_HOST_CURRENT", "candidateSha256": self.plan["candidateSha256"],
            "targetSha256": self.plan["targetSha256"], "operatorSourceCommit": self.plan["operatorSourceCommit"],
            "candidateObjectSha256": self.plan["candidateObjectSha256"], "configurationSha256": self.plan["configurationSha256"],
            "gatewayConfigurationSha256": value["gatewayConfigurationSha256"], "gatewayImageSha256": self.plan["gatewayImageSha256"],
            "gatewayProcessSha256": value["processSha256"], "runtimeInventorySha256": _hash(_canonical(self.initial_inventory)),
            "operatorSourceClosureSha256": self.source_initial["sourceClosureSha256"],
            "gatewayAdmission": value["admission"], "faultLeasePresent": value["faultLeasePresent"]}

    def _record(self, name, value):
        demand(re.fullmatch(r"[a-z0-9.-]+\.json", name), "P2_FAULT_RECORD_NAME_REQUIRED")
        descriptor = os.open(self.directory / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            _write_all(descriptor, _canonical(value) + b"\n")
        finally:
            os.close(descriptor)
        if self.expected_profile is not None:
            directory = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)

    def arm(self, record):
        self.verify()
        demand(not self.arm_called and _closed(record, ("commandId", "accountVersion", "canonicalSha256")) and UUID.fullmatch(record["commandId"])
            and type(record["accountVersion"]) is int and 1 <= record["accountVersion"] <= 9007199254740991
            and record["canonicalSha256"] == self.plan["commandSha256"], "P2_FAULT_EXACT_SOURCE_COMMAND_REQUIRED")
        if self.expected_profile is not None:
            selected = self._profiled_command()
            commands = self.scope._physical_observer.probe('witness')['witness']['commands']
            demand(record["commandId"] == selected["commandId"] and str(record["accountVersion"]) == selected["accountVersion"] and
                len([row for row in commands if row.get("commandId") == selected["commandId"] and row.get("accountVersion") == selected["accountVersion"]
                    and row.get("action") == selected["action"] and row.get("canonicalSha256") == record["canonicalSha256"]]) == 1,
                "P2_FAULT_PROFILED_ACTUAL_COMMAND_REQUIRED")
            current = self._gateway_current()
            admission = current["admission"]
            demand(current["faultLeasePresent"] is False and admission.get("valid") is True and admission.get("newWork") is False and
                admission.get("recovery") is True and admission.get("releaseId") == self.selected["releaseId"] and
                admission.get("candidateSha256") == self.plan["candidateSha256"] and
                all(_canonical(admission.get(key)) == _canonical({"newWork": 0, "recovery": 0}) for key in ("active", "uncertain")),
                "P2_FAULT_PROFILED_GATEWAY_RECOVERY_ONLY_REQUIRED")
        self.arm_called = True  # Sticky even when a subsequent write is uncertain.
        self.issued_at = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        expires = (datetime.datetime.fromisoformat(self.issued_at.replace("Z", "+00:00")) + datetime.timedelta(seconds=120)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        # This is the installed gateway's original exact version-one protocol.
        lease = {"version": 1, **{key: self.plan[key] for key in ("environment", "profile", "stageId", "candidateSha256", "configurationSha256",
            "gatewayConfigurationSha256", "gatewayProcessSha256", "gatewayImageSha256", "mode", "receiver")}}
        lease.update(releaseId=self.selected["releaseId"], sourceWitnessSha256=self.plan["commandSha256"], issuedAt=self.issued_at, expiresAt=expires,
            maxMatches=1, record=copy.deepcopy(record))
        raw = _canonical(lease) + b"\n"; self.lease_sha256 = _hash(raw)
        self._record("fault-arm-intent.json", {**self._receipt_fields(), "stageId": self.plan["stageId"], "leaseSha256": self.lease_sha256, "lease": lease})
        temporary = ".p2-fault-" + uuid.uuid4().hex
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o640, dir_fd=self.admission_fd)
        try:
            os.fchown(descriptor, 0, 65532); os.fchmod(descriptor, 0o640); _write_all(descriptor, raw)
            os.link(temporary, LEASE, src_dir_fd=self.admission_fd, dst_dir_fd=self.admission_fd, follow_symlinks=False)
            os.fsync(self.admission_fd)
        finally:
            os.close(descriptor); os.unlink(temporary, dir_fd=self.admission_fd)
        self.verify()
        demand(self._gateway_current()["faultLeasePresent"] is True, "P2_FAULT_ARM_READBACK_REQUIRED")
        receipt = {**self._receipt_fields(), "status": "P2_FAULT_LEASE_ARMED", "stageId": self.plan["stageId"], "leaseSha256": self.lease_sha256,
            "expiresAt": expires, "maxMatches": 1, "gatewayProcessSha256": self.plan["gatewayProcessSha256"]}
        self._record("fault-arm-observed.json", receipt)
        return receipt

    def effects(self):
        self.verify(); demand(self.issued_at is not None, "P2_FAULT_ARM_INTENT_REQUIRED")
        result = self.scope.run(["docker", "logs", "--since", self.issued_at, "--tail", "128", "--timestamps", self.gateway["containerId"]],
            env=runtime.SAFE_ENV, capture_output=True, timeout=10)
        demand(result.returncode == 0 and not result.stderr and len(result.stdout) <= 262144, "P2_FAULT_FINITE_LOG_OBSERVATION_REQUIRED")
        rows = []
        for raw in result.stdout.splitlines():
            _, separator, line = raw.partition(b" ")
            if not separator or len(line) > 8192:
                continue
            try:
                value = json.loads(line)
            except (ValueError, UnicodeError):
                continue
            if not isinstance(value, dict) or value.get("component") != "p2-certification-fault" or value.get("stageId") != self.plan["stageId"]:
                continue
            demand(value.get("profile") == self.plan["profile"] and value.get("status") == "P2_TRANSPORT_FAULT_INJECTED"
                and value.get("leaseSha256") == self.lease_sha256 and all(value.get(key) == self.plan[key] for key in
                    ("candidateSha256", "configurationSha256", "gatewayProcessSha256", "gatewayImageSha256", "mode", "receiver"))
                and value.get("sourceWitnessSha256") == self.plan["commandSha256"], "P2_FAULT_SOURCE_EFFECT_BINDING_REQUIRED")
            allowed = {"component", "version", "status", "environment", "profile", "stageId", "candidateSha256", "configurationSha256", "gatewayProcessSha256",
                "gatewayImageSha256", "sourceWitnessSha256", "leaseSha256", "mode", "receiver", "upstreamStarted", "downstreamDisposition", "upstreamReceiptVerified"}
            if self.plan["mode"] == "drop-after-ack":
                allowed |= {"upstreamStatus", "downstreamBytesStarted"}
            demand(set(value) == allowed and type(value["version"]) is int and value["version"] == 1 and value["environment"] == "staging",
                "P2_FAULT_CLOSED_EFFECT_RECEIPT_REQUIRED")
            rows.append({key: item for key, item in value.items() if key != "component"})
        demand(len(rows) <= 1, "P2_FAULT_ONE_MATCH_REQUIRED")
        return rows

    def disarm(self):
        # Cached directory/binding cleanup must run even if the original source,
        # input path or FE backend is now unavailable. Never delete another lease.
        self._require_cleanup_lock()
        try:
            descriptor = os.open(LEASE, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=self.admission_fd)
        except FileNotFoundError:
            return {**self._receipt_fields(), "faultDisabled": True, "leaseAbsent": True}
        try:
            info = os.fstat(descriptor); demand(stat.S_ISREG(info.st_mode) and info.st_size <= 8192, "P2_FAULT_LEASE_READBACK_REQUIRED")
            raw = os.read(descriptor, 8193)
        finally:
            os.close(descriptor)
        demand(self.lease_sha256 is not None and _hash(raw) == self.lease_sha256, "P2_FAULT_UNRELATED_LEASE_PRESERVED")
        os.unlink(LEASE, dir_fd=self.admission_fd); os.fsync(self.admission_fd)
        return {**self._receipt_fields(), "faultDisabled": True, "leaseAbsent": True}

    def close_gateway(self):
        # Deliberate source fence only; do not reset active/uncertain counters.
        self._require_cleanup_lock()
        state = {"version": 1, "environment": "staging", "releaseId": self.selected["releaseId"], "candidateSha256": self.plan["candidateSha256"],
            "actionId": "p2-fault-close-" + self.plan["stageId"], "newWork": False, "recovery": False}
        name = ".p2-fault-close-" + uuid.uuid4().hex
        descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=self.admission_fd)
        try:
            os.fchmod(descriptor, 0o644); _write_all(descriptor, _canonical(state) + b"\n")
            os.replace(name, "state.json", src_dir_fd=self.admission_fd, dst_dir_fd=self.admission_fd); os.fsync(self.admission_fd)
        finally:
            os.close(descriptor)
            try:
                os.unlink(name, dir_fd=self.admission_fd)
            except FileNotFoundError:
                pass
        try:
            value = self._gateway_current()["admission"]
            demand(value.get("valid") is True and value.get("releaseId") == state["releaseId"] and value.get("candidateSha256") == state["candidateSha256"]
                and value.get("newWork") is False and value.get("recovery") is False, "P2_FAULT_GATEWAY_CLOSED_READBACK_REQUIRED")
            return {**self._receipt_fields(), "gatewayAdmissionClosed": True, "fileFencePersisted": True, "active": value["active"], "uncertain": value["uncertain"]}
        except BaseException:
            return {**self._receipt_fields(), "gatewayAdmissionClosed": None, "fileFencePersisted": True, "active": None, "uncertain": None}

    def close(self):
        if not self.closed:
            failed = False
            try:
                self.disarm()
            except BaseException:
                failed = True
            try:
                self.close_gateway()
            except BaseException:
                failed = True
            os.close(self.admission_fd); self.closed = True
            demand(not failed, "P2_FAULT_HOST_CLEANUP_REQUIRES_REVIEW")


if __name__ == "__main__":
    print(json.dumps({"version": 1, "status": "P2_CERTIFICATION_FAULT_SOURCE_PARENT_REQUIRED", "standaloneActivationEligible": False,
        "networkCalled": False, "mutationsPerformed": False, "releaseAccepted": False}))
