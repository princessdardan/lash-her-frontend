"""Fixed in-process host adapter for the P2 application-user key rotation.

There is deliberately no CLI. A source-owned parent must supply an inherited
P2IdentityRotationScope, the reviewed release inputs, and the fixed three
private configuration directories.
"""
import copy
from datetime import datetime
import json
import os
from pathlib import Path
import re
import stat
import time
from uuid import uuid4

import frontend_probe
from frontend_release_adapters import LockedClient, LockedProbe
import migrate
import p2_identity_key_rotation as rotation_source
from p2_release_scope import P2ReleaseScope
import release as runtime
import staging_state
import vercel

demand = migrate.demand
PHASES = ("baseline", "overlap", "current-only")
SIGNER_PHASES = ("overlap", "current-only", "post-removal")


def signer_configuration_phase(phase):
    demand(phase in SIGNER_PHASES, "ROTATION_FRONTEND_PHASE_REQUIRED")
    return "current-only" if phase == "post-removal" else phase
PROFILE_PREFIXES = ("COURSE_LEARNER", "COURSE_ADMIN", "COMMUNITY_MEMBER", "COMMUNITY_ADMIN")
PROFILE_KEYS = frozenset(f"{prefix}_JWT_{slot}_SECRET" for prefix in PROFILE_PREFIXES for slot in ("CURRENT", "PREVIOUS"))
PROBE_OVERLAY_KEYS = frozenset(("LASH_RELEASE_PROBE_SECRET", "LASH_RELEASE_PROBE_EXPIRES_AT",
                                "LASH_RELEASE_SCHEDULER_QUALIFICATION", "API_GATEWAY_STAGING_ORIGIN"))
API_SERVICES = ("course-api", "community-api")
CAPTURE_PROFILES = ("community-admin", "community-member", "course-admin", "course-learner")
CAPTURE_RECORD = "rotation-token-captures.json"
CAPTURE_STATUS = "P2_IDENTITY_ROTATION_PRIVATE_TOKENS_CAPTURED"
CAPTURE_METADATA_FIELDS = ("status", "profile", "tokenIssuedAt", "tokenExpiresAt")
PRIVATE_CAPTURE_FIELDS = frozenset((*CAPTURE_METADATA_FIELDS, "version", "environment", "bindingSha256",
    "configurationSha256", "oldToken", "newToken", "privateCredentialBytes", "commonTokenBytesOutput", "releaseAccepted"))
CAPTURE_TIME = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z", re.ASCII)
CAPTURE_JWT = re.compile(r"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+")


def _env(raw):
    value = {}
    text = raw.decode("utf8")
    demand("\x00" not in text and "\r" not in text, "ROTATION_RAW_ENV_REQUIRED")
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        key, separator, item = line.partition("=")
        demand(separator and re.fullmatch(r"[A-Z][A-Z0-9_]*", key) and key not in value
               and not any(ord(character) < 32 or ord(character) == 127 for character in item), "ROTATION_RAW_ENV_REQUIRED")
        value[key] = item
    return value


def _configuration_hash(directory, files):
    payload = bytearray()
    for relative in sorted(files):
        raw = migrate.read_input(directory, relative, 65_536)
        payload.extend(relative.encode() + b"\0" + raw + b"\0")
    return migrate.file_hash(bytes(payload))


def _runtime_phase_hash(directory):
    return _configuration_hash(directory, (*runtime.CONFIG_FILES, *runtime.TLS_FILES,
                                            *(f"{service}.env" for service in runtime.ENV_FILES), "runtime.json"))


def _phase_hash(directory):
    return _configuration_hash(directory, (*runtime.CONFIG_FILES, *runtime.TLS_FILES,
                                            *(f"{service}.env" for service in runtime.ENV_FILES),
                                            "runtime.json", "frontend.env"))


class P2IdentityRotationScope(P2ReleaseScope):
    def __init__(self, descriptor, path, verify_frontend, receipt, candidate_sha256, *, action_id, binding_sha256,
                 source_commit, browser_program_sha256, release, jobs, configuration_sha256, private_configuration_sha256,
                 replacement_custody=None, profiled_scope=None):
        demand((replacement_custody is None) == (profiled_scope is None), "P2_ROTATION_REPLACEMENT_SCOPE_REQUIRED")
        self._expected_profile = None
        self._profiled_scope, self._replacement_custody = profiled_scope, replacement_custody
        if replacement_custody is not None:
            from p2_certification_parent import P2CertificationScope
            from p2_identity_rotation_replacement import ReplacementRotationCustody
            demand(type(replacement_custody) is ReplacementRotationCustody and type(profiled_scope) is P2CertificationScope
                   and replacement_custody._scope is profiled_scope and profiled_scope.descriptor == descriptor
                   and profiled_scope.path == path and profiled_scope.receipt == receipt
                   and profiled_scope.release == release and profiled_scope.jobs == jobs
                   and profiled_scope.candidate_sha256 == candidate_sha256
                   and profiled_scope.certification_plan.get("certificationActionId") == action_id
                   and profiled_scope._expected_profile == replacement_custody.expected,
                   "P2_ROTATION_REPLACEMENT_SCOPE_REQUIRED")
            self._expected_profile = replacement_custody.expected
        demand(isinstance(action_id, str) and re.fullmatch(r"p2-key-rotation-[a-z0-9-]{1,40}", action_id)
               and isinstance(binding_sha256, str) and re.fullmatch(r"[a-f0-9]{64}", binding_sha256)
               and isinstance(source_commit, str) and re.fullmatch(r"[a-f0-9]{40}", source_commit)
               and isinstance(browser_program_sha256, str) and re.fullmatch(r"[a-f0-9]{64}", browser_program_sha256)
               and release.get("environment") == "staging" and vercel.release_identity(release, expected_profile=self._expected_profile)[2] == source_commit
               and set(configuration_sha256) == set(private_configuration_sha256) == set(PHASES)
               and all(re.fullmatch(r"[a-f0-9]{64}", value or "") for value in configuration_sha256.values()),
               "P2_ROTATION_SCOPE_BINDING_REQUIRED")
        demand(all(re.fullmatch(r"[a-f0-9]{64}", value or "") for value in private_configuration_sha256.values())
               and all(configuration_sha256[phase] != private_configuration_sha256[phase] for phase in PHASES),
               "P2_ROTATION_PRIVATE_CONFIGURATION_BINDING_REQUIRED")
        self.action_id, self.binding_sha256, self.source_commit = action_id, binding_sha256, source_commit
        self.browser_program_sha256 = browser_program_sha256
        self.rotation_configuration_sha256 = copy.deepcopy(configuration_sha256)
        self.private_rotation_configuration_sha256 = copy.deepcopy(private_configuration_sha256)
        super().__init__(descriptor, path, verify_frontend, receipt, candidate_sha256, release=release, jobs=jobs)
        if profiled_scope is not None:
            self.require_frontend(release, jobs["frontend"])
            return
        frontend = jobs.get("frontend", {}).get("job", {})
        target = frontend.get("target", {})
        expected_target = {key: target.get(key) for key in ("host", "port", "database", "user", "serverMajor")}
        keys = ("environment", "releaseId", "sourceCommit", "migrationImageDigest", "sqlArtifactSha256",
                "schemaBaselineSha256", "contractManifestSha256", "contractPhase", "phase2ContractManifestSha256")
        demand(receipt.get("status") == "P2_RECOVERY_DATABASE_CURRENT"
               and receipt.get("migrationMode") == "recovery-current-only" and receipt.get("candidateSha256") == candidate_sha256
               and receipt.get("service") == "frontend" and receipt.get("target") == expected_target
               and all(receipt.get(key) == frontend.get(key) and receipt.get(key) is not None for key in keys)
               and receipt.get("schemaVerified") is True and receipt.get("runtimeRoleVerified") is True
               and receipt.get("oldLoginsDenied") is True and receipt.get("oldRoleSessions") == 0
               and receipt.get("sqlReplayed") is False and receipt.get("originalFrontendTerminalRecreated") is False
               and receipt.get("trafficAuthorized") is False and isinstance(receipt.get("after"), list) and receipt["after"],
               "P2_ROTATION_CURRENT_FRONTEND_RECEIPT_REQUIRED")

    def verify(self):
        super().verify()
        if self._profiled_scope is not None:
            self._profiled_scope.verify()

    def require_frontend(self, release, info):
        if self._profiled_scope is None:
            return super().require_frontend(release, info)
        self.verify()
        return self._profiled_scope.require_frontend(release, info)

    def revoke(self):
        try:
            super().revoke()
        finally:
            if self._profiled_scope is not None:
                self._profiled_scope.revoke()


class RotationConfigurationSet:
    def __init__(self, root, public_expected, private_expected, *, fixture=False):
        self.root = Path(root)
        demand(self.root.is_absolute() and (fixture or self.root.resolve() == self.root
               and self.root.is_relative_to(Path("/var/lib/lash-her/releases/staging"))
               and not any(parent.is_symlink() for parent in (self.root, *self.root.parents) if parent.exists())),
               "ROTATION_PRIVATE_CONFIGURATION_ROOT_REQUIRED")
        migrate.private_directory(self.root)
        demand(set(public_expected) == set(private_expected) == set(PHASES)
               and all(public_expected[phase] != private_expected[phase] for phase in PHASES),
               "ROTATION_CONFIGURATION_INVENTORY_REQUIRED")
        self.directories = {phase: self.root / phase for phase in PHASES}
        self.hashes, self.private_hashes, self.runtime_private_hashes = copy.deepcopy(public_expected), {}, {}
        self.frontend, self.api = {}, {}
        for phase, directory in self.directories.items():
            migrate.private_directory(directory)
            self.private_hashes[phase] = _phase_hash(directory)
            self.runtime_private_hashes[phase] = _runtime_phase_hash(directory)
            demand(self.private_hashes[phase] == private_expected[phase], "ROTATION_CONFIGURATION_HASH_CHANGED")
            self.frontend[phase] = _env(migrate.read_input(directory, "frontend.env", 65_536))
            self.api[phase] = {service: _env(migrate.read_input(directory, f"{service}.env", 65_536)) for service in API_SERVICES}
        self._validate()

    def _validate(self):
        for relative in (*runtime.CONFIG_FILES, *runtime.TLS_FILES, "runtime.json",
                         *(f"{service}.env" for service in runtime.ENV_FILES if service not in API_SERVICES)):
            values = [migrate.read_input(self.directories[phase], relative, 65_536) for phase in PHASES]
            demand(values[0] == values[1] == values[2], "ROTATION_NONPROFILE_CONFIGURATION_CHANGED")
        for source in (self.frontend, {phase: self.api[phase]["course-api"] for phase in PHASES},
                       {phase: self.api[phase]["community-api"] for phase in PHASES}):
            keysets = [set(source[phase]) for phase in PHASES]
            nonprofile = [keys - PROFILE_KEYS for keys in keysets]
            demand(nonprofile[0] == nonprofile[1] == nonprofile[2]
                   and all(source["baseline"][key] == source["overlap"][key] == source["current-only"][key]
                           for key in nonprofile[0]), "ROTATION_NONPROFILE_ENV_CHANGED")
        expected_by_file = {
            "frontend": set(PROFILE_PREFIXES), "course-api": {"COURSE_LEARNER", "COURSE_ADMIN"},
            "community-api": {"COMMUNITY_MEMBER", "COMMUNITY_ADMIN"},
        }
        collections = {"frontend": self.frontend,
                       "course-api": {phase: self.api[phase]["course-api"] for phase in PHASES},
                       "community-api": {phase: self.api[phase]["community-api"] for phase in PHASES}}
        secret_values = set()
        for name, source in collections.items():
            for phase in PHASES:
                expected_profile_keys = {f"{prefix}_JWT_CURRENT_SECRET" for prefix in expected_by_file[name]}
                if phase == "overlap":
                    expected_profile_keys |= {f"{prefix}_JWT_PREVIOUS_SECRET" for prefix in expected_by_file[name]}
                demand(set(source[phase]).intersection(PROFILE_KEYS) == expected_profile_keys,
                       "ROTATION_PROFILE_KEY_INVENTORY_REFUSED")
            for prefix in expected_by_file[name]:
                current, previous = f"{prefix}_JWT_CURRENT_SECRET", f"{prefix}_JWT_PREVIOUS_SECRET"
                old, new = source["baseline"].get(current), source["overlap"].get(current)
                demand(isinstance(old, str) and isinstance(new, str) and 32 <= len(old) <= 8192 and 32 <= len(new) <= 8192
                       and old != new and previous not in source["baseline"]
                       and source["overlap"].get(previous) == old and source["current-only"].get(current) == new
                       and previous not in source["current-only"], "ROTATION_PROFILE_TRANSITION_REFUSED")
                secret_values.update((old, new))
        demand(len(secret_values) == 8, "ROTATION_PROFILE_KEYS_NOT_DISTINCT")
        for phase in PHASES:
            for source in (self.frontend[phase], *self.api[phase].values()):
                demand(not PROBE_OVERLAY_KEYS.intersection(source), "CALLER_PROBE_OVERLAY_REFUSED")
                demand(not any(value in secret_values for key, value in source.items() if key not in PROFILE_KEYS),
                       "ROTATION_SERVICE_CREDENTIAL_COLLISION")

    def directory(self, phase):
        demand(phase in PHASES, "ROTATION_PHASE_REQUIRED")
        demand(_phase_hash(self.directories[phase]) == self.private_hashes[phase],
               "ROTATION_CONFIGURATION_HASH_CHANGED")
        return self.directories[phase]


class P2IdentityRotationHostAdapter:
    def __init__(self, scope, selected, jobs, configuration_root, current_runtime_configuration, output, compose_file, client, gateway_host,
                 operator_source, operator_program_sha256):
        demand(type(scope) is P2IdentityRotationScope, "P2_ROTATION_TYPED_SCOPE_REQUIRED")
        self.scope, self.selected, self.jobs, self.output = scope, copy.deepcopy(selected), copy.deepcopy(jobs), Path(output)
        self.compose_file, self.client, self.gateway_host = Path(compose_file), LockedClient(client, scope.verify), gateway_host
        operator_source = Path(operator_source)
        demand(operator_source.is_absolute() and operator_source.resolve() == operator_source
               and operator_source == Path("/opt/lash-her/operators") / scope.source_commit
               and not any(parent.is_symlink() for parent in (operator_source, *operator_source.parents) if parent.exists()),
               "P2_ROTATION_OPERATOR_SOURCE_CHANGED")
        self.operator_source = operator_source
        self.operator_program = rotation_source.private_program(operator_source)
        demand(migrate.file_hash(self.operator_program) == operator_program_sha256,
               "P2_ROTATION_OPERATOR_PROGRAM_CHANGED")
        self.configurations = RotationConfigurationSet(configuration_root, scope.rotation_configuration_sha256,
                                                       scope.private_rotation_configuration_sha256)
        current_runtime_configuration = Path(current_runtime_configuration)
        migrate.private_directory(current_runtime_configuration)
        demand(_runtime_phase_hash(current_runtime_configuration) == self.configurations.runtime_private_hashes["baseline"],
               "ROTATION_CURRENT_RUNTIME_CONFIGURATION_CHANGED")
        self.unchanged_runtime_configuration = current_runtime_configuration
        self.api_mount_configuration = current_runtime_configuration
        demand(selected == scope.release and jobs == scope.jobs and vercel.release_identity(selected, **self.profile_arguments())[2] == scope.source_commit,
               "P2_ROTATION_REVIEWED_RELEASE_CHANGED")
        migrate.private_directory(self.output)

    def profile_arguments(self):
        expected = getattr(self.scope, "_expected_profile", None)
        return {} if expected is None else {"expected_profile": expected}

    def _command(self, arguments, environment, timeout=120, input=None):
        return self.scope.run(arguments, env=environment, timeout=timeout, check=True, capture_output=True, text=True,
                              input=input).stdout.strip()

    def _intent(self, intent):
        fields = {"version", "status", "environment", "actionId", "bindingSha256", "candidateSha256", "sourceCommit",
                  "phase", "kind", "fromConfigurationSha256", "toConfigurationSha256", "privateConfigurationRef",
                  "sqlAuthorized", "rolePreparationAuthorized", "loginChangeAuthorized", "admissionAuthorized"}
        demand(isinstance(intent, dict) and set(intent) == fields and intent.get("version") == 1
               and intent.get("status") == "P2_IDENTITY_ROTATION_MUTATION_INTENT" and intent.get("environment") == "staging"
               and intent.get("actionId") == self.scope.action_id and intent.get("bindingSha256") == self.scope.binding_sha256
               and intent.get("candidateSha256") == self.scope.candidate_sha256 and intent.get("sourceCommit") == self.scope.source_commit
               and intent.get("phase") in ("overlap", "current-only") and intent.get("kind") in ("api", "frontend")
               and intent.get("fromConfigurationSha256") == self.configurations.hashes["baseline" if intent["phase"] == "overlap" else "overlap"]
               and intent.get("toConfigurationSha256") == self.configurations.hashes[intent["phase"]]
               and Path(intent.get("privateConfigurationRef", "")) == self.configurations.directory(intent["phase"])
               and all(intent.get(key) is False for key in ("sqlAuthorized", "rolePreparationAuthorized",
                                                             "loginChangeAuthorized", "admissionAuthorized")),
               "ROTATION_MUTATION_INTENT_CHANGED")
        return intent

    @staticmethod
    def _result(intent, reconciled):
        return {"version": 1, "status": "P2_IDENTITY_ROTATION_MUTATION_QUALIFIED", "actionId": intent["actionId"],
                "phase": intent["phase"], "kind": intent["kind"],
                "fromConfigurationSha256": intent["fromConfigurationSha256"],
                "toConfigurationSha256": intent["toConfigurationSha256"], "mutationCount": 1,
                "getFirstReconciled": reconciled, "runtimeVerified": True,
                "sqlExecuted": False, "rolesPrepared": False, "loginChanged": False}

    def _snapshot(self, phase, *, restoration=False):
        source = self.configurations.directory(phase)
        destination = self.output / (f"runtime-restoration-{phase}" if restoration else f"runtime-{phase}")
        if not destination.exists():
            compose = migrate.read_input(self.compose_file.parent, self.compose_file.name)
            runtime.snapshot_configuration(source, destination, self.selected, self.jobs, compose, **self.profile_arguments())
        else:
            expected = staging_state.configuration_hashes(source)
            demand(staging_state.configuration_hashes(destination) == expected
                   and migrate.file_hash(migrate.read_input(destination, "compose.yaml"))
                       == migrate.file_hash(migrate.read_input(self.compose_file.parent, self.compose_file.name)),
                   "ROTATION_RETAINED_SNAPSHOT_CHANGED")
        self.configurations.directory(phase)
        demand(_runtime_phase_hash(destination) == self.configurations.runtime_private_hashes[phase],
               "ROTATION_SNAPSHOT_CONFIGURATION_CHANGED")
        return destination

    def _private_child(self, phase, service, payload):
        demand(phase in ("overlap", "current-only") and service in ("gateway", "community-api"),
               "ROTATION_PRIVATE_CHILD_TARGET_REFUSED")
        snapshot = self._snapshot(phase)
        prefix, environment = runtime.compose_command(snapshot, "staging"), runtime.runtime_environment(self.selected, snapshot, **self.profile_arguments())
        try:
            raw = self._command([*prefix, "exec", "-T", service, "node", "--input-type=module", "--eval",
                                 self.operator_program.decode("utf8")], environment, 30, json.dumps(payload))
        except BaseException:
            raise ValueError("ROTATION_PRIVATE_CHILD_REFUSED") from None
        demand(len(raw.encode()) <= 131_072, "ROTATION_PRIVATE_CHILD_OUTPUT_BOUND")
        try:
            value = json.loads(raw)
        except (TypeError, ValueError):
            raise ValueError("ROTATION_PRIVATE_CHILD_REFUSED") from None
        demand(isinstance(value, dict), "ROTATION_PRIVATE_CHILD_REFUSED")
        return value

    def _require_private_capture(self, value, profile):
        demand(type(value) is dict and set(value) == PRIVATE_CAPTURE_FIELDS
               and type(value["version"]) is int and value["version"] == 1 and value["environment"] == "staging"
               and value["status"] == CAPTURE_STATUS and value["profile"] == profile
               and value["bindingSha256"] == self.scope.binding_sha256
               and value["configurationSha256"] == self.configurations.hashes["overlap"]
               and value["privateCredentialBytes"] is True and value["commonTokenBytesOutput"] is False
               and value["releaseAccepted"] is False
               and all(type(value[key]) is str and len(value[key]) <= 4096 and CAPTURE_JWT.fullmatch(value[key])
                       for key in ("oldToken", "newToken"))
               and value["oldToken"] != value["newToken"]
               and all(type(value[key]) is str and CAPTURE_TIME.fullmatch(value[key])
                       for key in ("tokenIssuedAt", "tokenExpiresAt")), "ROTATION_PRIVATE_CAPTURE_REFUSED")
        try:
            issued, expires = (datetime.fromisoformat(value[key].replace("Z", "+00:00"))
                               for key in ("tokenIssuedAt", "tokenExpiresAt"))
        except ValueError:
            raise ValueError("ROTATION_PRIVATE_CAPTURE_REFUSED") from None
        demand((expires - issued).total_seconds() == 300, "ROTATION_PRIVATE_CAPTURE_REFUSED")

    def capture_tokens(self, subjects, course_id, binding_sha256):
        demand(isinstance(subjects, dict) and set(subjects) == set(CAPTURE_PROFILES)
               and all(isinstance(value, str) and re.fullmatch(r"[a-f0-9-]{36}", value) for value in subjects.values())
               and isinstance(course_id, str) and re.fullmatch(r"[a-f0-9-]{36}", course_id)
               and binding_sha256 == self.scope.binding_sha256, "ROTATION_CAPTURE_SUBJECT_BINDING_REQUIRED")
        migrate.private_directory(self.output)
        try:
            (self.output / CAPTURE_RECORD).lstat()
        except FileNotFoundError:
            phase, configuration = "overlap", self.configurations.hashes["overlap"]
            gateway_ca = migrate.read_input(self._snapshot(phase), "tls/ca.pem", 65_536)
            captures = []
            for profile in CAPTURE_PROFILES:
                prefix = profile.replace("-", "_").upper()
                keys = self.configurations.frontend[phase]
                payload = {"version": 1, "mode": "rotation-capture", "environment": "staging",
                           "bindingSha256": binding_sha256, "phase": "pre-removal-overlap", "profile": profile,
                           "subject": subjects[profile], "courseId": course_id,
                           "oldKey": keys[f"{prefix}_JWT_PREVIOUS_SECRET"], "newKey": keys[f"{prefix}_JWT_CURRENT_SECRET"],
                           "oldToken": None, "newToken": None, "tokenIssuedAt": None, "tokenExpiresAt": None,
                           "gatewayCaSha256": migrate.file_hash(gateway_ca), "configurationSha256": configuration,
                           "runtimeEnvironment": None}
                value = self._private_child(phase, "gateway", payload)
                self._require_private_capture(value, profile)
                captures.append(value)
            migrate.write_json(self.output, CAPTURE_RECORD, {"version": 1,
                "status": "P2_IDENTITY_ROTATION_PRIVATE_CAPTURE_RETAINED", "actionId": self.scope.action_id,
                "bindingSha256": binding_sha256, "configurationSha256": configuration, "captures": captures})
        return [{key: row[key] for key in CAPTURE_METADATA_FIELDS} for row in self._retained_captures()]

    def _retained_captures(self):
        self.configurations.directory("overlap")
        migrate.private_directory(self.output)
        info = (self.output / CAPTURE_RECORD).lstat()
        demand(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o600,
               "ROTATION_PRIVATE_CAPTURE_RECORD_REQUIRED")
        record = migrate.read_json(self.output, CAPTURE_RECORD)
        demand(type(record) is dict and set(record) == {"version", "status", "actionId", "bindingSha256",
               "configurationSha256", "captures"} and type(record["version"]) is int and record["version"] == 1
               and record["status"] == "P2_IDENTITY_ROTATION_PRIVATE_CAPTURE_RETAINED"
               and record["actionId"] == self.scope.action_id and record["bindingSha256"] == self.scope.binding_sha256
               and record["configurationSha256"] == self.configurations.hashes["overlap"]
               and type(record["captures"]) is list and len(record["captures"]) == len(CAPTURE_PROFILES),
               "ROTATION_RETAINED_CAPTURE_CHANGED")
        for profile, capture in zip(CAPTURE_PROFILES, record["captures"]):
            self._require_private_capture(capture, profile)
        return record["captures"]

    def observe_profiles(self, phase, subjects, course_id):
        demand(phase in ("overlap", "current-only"), "ROTATION_OBSERVATION_PHASE_REQUIRED")
        captures = self._retained_captures()
        gateway_ca = migrate.read_input(self._snapshot(phase), "tls/ca.pem", 65_536)
        receipts = []
        for capture in captures:
            profile = capture.get("profile")
            demand(profile in subjects and capture.get("bindingSha256") == self.scope.binding_sha256,
                   "ROTATION_RETAINED_CAPTURE_CHANGED")
            prefix = profile.replace("-", "_").upper()
            api_service = "course-api" if profile.startswith("course-") else "community-api"
            keys = self.configurations.api[phase][api_service]
            payload = {"version": 1, "mode": "rotation-course-http" if profile.startswith("course-") else "rotation-community-verifier",
                       "environment": "staging", "bindingSha256": self.scope.binding_sha256, "phase": phase,
                       "profile": profile, "subject": subjects[profile], "courseId": course_id,
                       "oldKey": self.configurations.frontend["overlap"][f"{prefix}_JWT_PREVIOUS_SECRET"],
                       "newKey": keys[f"{prefix}_JWT_CURRENT_SECRET"], "oldToken": capture["oldToken"],
                       "newToken": capture["newToken"], "tokenIssuedAt": capture["tokenIssuedAt"],
                       "tokenExpiresAt": capture["tokenExpiresAt"], "gatewayCaSha256": migrate.file_hash(gateway_ca),
                       "configurationSha256": self.configurations.hashes[phase],
                       "runtimeEnvironment": None if profile.startswith("course-") else {
                           "DATABASE_TARGET": keys["DATABASE_TARGET"]}}
            service = "gateway" if profile.startswith("course-") else "community-api"
            value = self._private_child(phase, service, payload)
            demand(value.get("status") == "P2_IDENTITY_ROTATION_PRIVATE_OBSERVED" and value.get("profile") == profile
                   and value.get("phase") == phase and value.get("bindingSha256") == self.scope.binding_sha256
                   and value.get("configurationSha256") == self.configurations.hashes[phase]
                   and value.get("retainedTokenContinuityVerified") is True and value.get("tokenBytesOutput") is False,
                   "ROTATION_PRIVATE_OBSERVATION_REFUSED")
            receipts.append(value)
        migrate.write_json(self.output, f"rotation-{phase}-profile-observations.json", {
            "version": 1, "status": "P2_IDENTITY_ROTATION_PROFILE_OBSERVATIONS_RETAINED", "actionId": self.scope.action_id,
            "bindingSha256": self.scope.binding_sha256, "configurationSha256": self.configurations.hashes[phase],
            "receipts": receipts})
        return receipts

    def _retained_profile_rows(self, phase):
        demand(phase in ("overlap", "current-only"), "ROTATION_RETAINED_PROFILE_PHASE_REQUIRED")
        expected_profiles = {"course-learner", "course-admin", "community-member", "community-admin"}
        value = migrate.read_json(self.output, f"rotation-{phase}-profile-observations.json")
        demand(isinstance(value, dict) and set(value) == {"version", "status", "actionId", "bindingSha256",
            "configurationSha256", "receipts"} and value.get("version") == 1
            and value.get("status") == "P2_IDENTITY_ROTATION_PROFILE_OBSERVATIONS_RETAINED"
            and value.get("actionId") == self.scope.action_id
            and value.get("bindingSha256") == self.scope.binding_sha256
            and value.get("configurationSha256") == self.configurations.hashes[phase]
            and isinstance(value.get("receipts"), list) and len(value["receipts"]) == 4
            and {row.get("profile") for row in value["receipts"]} == expected_profiles,
            "ROTATION_RETAINED_PROFILE_EVIDENCE_CHANGED")
        for row in value["receipts"]:
            profile = row["profile"]
            expected_class = "actual-protected-course-http" if profile.startswith("course-") else "deployed-private-community-verifier"
            demand(row.get("status") == "P2_IDENTITY_ROTATION_PRIVATE_OBSERVED"
                   and row.get("phase") == phase and row.get("bindingSha256") == self.scope.binding_sha256
                   and row.get("configurationSha256") == self.configurations.hashes[phase]
                   and row.get("evidenceClass") == expected_class
                   and row.get("oldResult") == ("accepted" if phase == "overlap" else "rejected")
                   and row.get("newResult") == "accepted" and row.get("retainedTokenContinuityVerified") is True
                   and row.get("capabilityEnforced") is True and row.get("tokenBytesOutput") is False
                   and row.get("credentialHashesOutput") is False and row.get("releaseAccepted") is False,
                   "ROTATION_RETAINED_PROFILE_EVIDENCE_CHANGED")
            try:
                issued = datetime.fromisoformat(row["oldTokenIssuedAt"].replace("Z", "+00:00"))
                expires = datetime.fromisoformat(row["oldTokenExpiresAt"].replace("Z", "+00:00"))
                observed = datetime.fromisoformat(row["observedAt"].replace("Z", "+00:00"))
            except (KeyError, TypeError, ValueError):
                raise ValueError("ROTATION_RETAINED_PROFILE_EVIDENCE_CHANGED") from None
            demand((expires - issued).total_seconds() == 300 and issued <= observed < expires,
                   "ROTATION_RETAINED_PROFILE_EVIDENCE_CHANGED")
        return value["receipts"]

    def retained_profile_evidence(self, phase):
        return {row["profile"]: migrate.file_hash(json.dumps(row, sort_keys=True, separators=(",", ":")).encode())
                for row in self._retained_profile_rows(phase)}

    def qualified_profile_evidence(self):
        evidence, timing = {}, {}
        for phase in ("overlap", "current-only"):
            for row in self._retained_profile_rows(phase):
                profile = row["profile"]
                previous = timing.setdefault(profile, (row["oldTokenIssuedAt"], row["oldTokenExpiresAt"]))
                demand(previous == (row["oldTokenIssuedAt"], row["oldTokenExpiresAt"]),
                       "ROTATION_RETAINED_PROFILE_EVIDENCE_CHANGED")
                evidence.setdefault(profile, {})[phase] = migrate.file_hash(
                    json.dumps(row, sort_keys=True, separators=(",", ":")).encode())
        expected_profiles = {"course-learner", "course-admin", "community-member", "community-admin"}
        demand(set(evidence) == expected_profiles and all(set(value) == {"overlap", "current-only"}
               for value in evidence.values()), "ROTATION_RETAINED_PROFILE_EVIDENCE_CHANGED")
        return evidence

    def observe_api_configuration(self, phase):
        self.scope.verify()
        self._verify_original_runtime_configuration()
        snapshot = self._snapshot(phase)
        prefix, environment = runtime.compose_command(snapshot, "staging"), runtime.runtime_environment(self.selected, snapshot, **self.profile_arguments())
        for service in API_SERVICES:
            expected = self.configurations.api[phase][service]
            relevant_prefixes = PROFILE_PREFIXES[:2] if service == "course-api" else PROFILE_PREFIXES[2:]
            inventory = sorted(f"{prefix}_JWT_{slot}_SECRET" for prefix in relevant_prefixes for slot in ("CURRENT", "PREVIOUS"))
            program = ("import{readFileSync}from'node:fs';import{timingSafeEqual}from'node:crypto';"
                       "const x=JSON.parse(readFileSync(0,'utf8')),a=x.inventory.filter(k=>process.env[k]!==undefined).sort(),"
                       "p=Object.keys(x.desired).filter(k=>k.endsWith('_JWT_CURRENT_SECRET')||k.endsWith('_JWT_PREVIOUS_SECRET')).sort(),"
                       "b=Object.keys(x.desired).sort(),eq=(l,r)=>Buffer.byteLength(l)===Buffer.byteLength(r)&&timingSafeEqual(Buffer.from(l),Buffer.from(r));"
                       "if(JSON.stringify(a)!==JSON.stringify(p)||b.some(k=>!eq(process.env[k]??'',x.desired[k])))process.exit(9)")
            self._command([*prefix, "exec", "-T", service, "node", "--input-type=module", "--eval", program],
                          environment, 30, json.dumps({"desired": expected, "inventory": inventory}))
        token = runtime._command_scope.set(self.scope)
        try:
            containers = runtime.check_containers(self.selected, snapshot, **self.profile_arguments())
        finally:
            runtime._command_scope.reset(token)
        self._validate_runtime_mounts(snapshot, containers)
        self._verify_original_runtime_configuration()
        self.scope.verify()
        return {"configurationSha256": self.configurations.hashes[phase], "containers": containers, "runtimeVerified": True}

    def _verify_original_runtime_configuration(self):
        demand(_runtime_phase_hash(self.unchanged_runtime_configuration)
               == self.configurations.runtime_private_hashes["baseline"],
               "ROTATION_CURRENT_RUNTIME_CONFIGURATION_CHANGED")

    def _validate_runtime_mounts(self, snapshot, containers):
        self._verify_original_runtime_configuration()
        unchanged, api = self.unchanged_runtime_configuration, self.api_mount_configuration
        expected = {
            "gateway": {"/config/gateway.json": unchanged / "gateway.json", "/admission": unchanged / "admission",
                        "/tls": unchanged / "tls/gateway"},
            "course-api": {}, "course-tls": {"/config/course-tls.json": unchanged / "course-tls.json",
                                               "/tls": unchanged / "tls/course"},
            "course-publisher": {"/tls/ca.pem": unchanged / "tls/ca.pem"}, "course-snapshot": {},
            "course-media": {}, "course-export-cleanup": {},
            "community-api": {"/tls/ca.pem": api / "tls/ca.pem"},
            "community-tls": {"/config/community-tls.json": unchanged / "community-tls.json",
                                "/tls": unchanged / "tls/community"},
            "community-worker": {"/tls/ca.pem": unchanged / "tls/ca.pem"},
        }
        demand({item.get("service") for item in containers} == set(expected), "ROTATION_RUNTIME_MOUNT_INVENTORY_REFUSED")
        for container in containers:
            raw = self._command(["docker", "inspect", "--format", "{{.HostConfig.ReadonlyRootfs}}|{{json .Mounts}}",
                                 container["containerId"]], runtime.SAFE_ENV, 15)
            demand(raw.startswith("true|") and len(raw.encode()) <= 16_384, "ROTATION_RUNTIME_IMMUTABILITY_REFUSED")
            try:
                mounts = json.loads(raw.split("|", 1)[1])
            except (TypeError, ValueError):
                raise ValueError("ROTATION_RUNTIME_MOUNTS_REFUSED") from None
            demand(isinstance(mounts, list), "ROTATION_RUNTIME_MOUNTS_REFUSED")
            required, seen = expected[container["service"]], set()
            for row in mounts:
                destination = row.get("Destination") if isinstance(row, dict) else None
                demand(isinstance(destination, str) and destination not in seen, "ROTATION_RUNTIME_MOUNTS_REFUSED")
                seen.add(destination)
                if row.get("Type") == "tmpfs" and destination == "/tmp":
                    continue
                demand(destination in required and row.get("Type") == "bind" and row.get("RW") is False
                       and row.get("Source") == str(required[destination]), "ROTATION_RUNTIME_MOUNTS_REFUSED")
            demand(set(required) == seen - ({"/tmp"} if "/tmp" in seen else set()), "ROTATION_RUNTIME_MOUNTS_REFUSED")
        self._verify_original_runtime_configuration()

    def observe_continuous_runtime(self, phase, expected_containers):
        demand(phase in PHASES and isinstance(expected_containers, list) and len(expected_containers) == len(runtime.SERVICES),
               "ROTATION_CONTINUOUS_RUNTIME_EXPECTATION_REQUIRED")
        observed = self.observe_api_configuration(phase)
        demand(observed.get("containers") == expected_containers and observed.get("runtimeVerified") is True,
               "ROTATION_RUNTIME_IDENTITIES_CHANGED")
        return observed

    def runtime_guard_containers(self, public_containers):
        retained = getattr(self, "_runtime_guard_containers", None)
        demand(isinstance(retained, list) and [
            {key: row[key] for key in ("service", "containerId", "image")} for row in retained
        ] == public_containers, "ROTATION_RUNTIME_GUARD_BINDING_REFUSED")
        return copy.deepcopy(retained)

    def _observe_api_database_current(self, name):
        demand(name in ("course", "community"), "ROTATION_API_CURRENT_SCOPE_REQUIRED")
        info = self.jobs[name]
        external, internal = migrate.credential_names(name, "staging")
        credential = os.environ.get(external)
        demand(isinstance(credential, str) and credential, "ROTATION_API_CURRENT_CREDENTIAL_REQUIRED")
        program = self.operator_source / "ops/platform/p2-recovery-api-current-probe.mjs"
        payload = {"version": 1, "service": info["service"], "job": info["job"],
                   "schemaBytes": info["schema"].decode(), "candidateSha256": self.scope.candidate_sha256,
                   "recoveryActionId": self.scope.action_id}
        container = "lash-p2-rotation-current-" + name + "-" + uuid4().hex
        args = ["docker", "run", "--rm", "--name", container, "--interactive", "--network", "host", "--read-only",
                "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "256m", "--pids-limit", "64",
                "--env", internal, "--mount", f"type=bind,src={program},dst=/app/p2-recovery-api-current-probe.mjs,readonly",
                "--entrypoint", "node", info["image"], "/app/p2-recovery-api-current-probe.mjs"]
        try:
            raw = self._command(args, {**runtime.SAFE_ENV, internal: credential}, 60, json.dumps(payload))
            demand(len(raw.encode()) <= 16_384, "ROTATION_API_CURRENT_RECEIPT_BOUNDS")
            proof = json.loads(raw)
            keys = ("environment", "releaseId", "sourceCommit", "migrationImageDigest", "runtimeImageDigest",
                    "schemaBaselineSha256", "contractSha256")
            demand(proof.get("status") == "P2_RECOVERY_API_DATABASE_CURRENT" and proof.get("service") == info["service"]
                   and all(proof.get(key) == info["job"].get(key) for key in keys)
                   and proof.get("candidateSha256") == self.scope.candidate_sha256
                   and proof.get("recoveryActionId") == self.scope.action_id
                   and proof.get("pendingTags") == [] and proof.get("readOnlyVerified") is True
                   and proof.get("schemaVerified") is True and proof.get("runtimeRoleVerified") is True
                   and proof.get("sqlReplayed") is False, "ROTATION_API_DATABASE_NOT_CURRENT")
            migrate.require_contract_identity(self.selected, proof)
            return proof
        finally:
            self.scope.run(["docker", "rm", "--force", container], env=runtime.SAFE_ENV, timeout=30,
                           check=False, capture_output=True, text=True)
            remaining = self._command(["docker", "container", "ls", "--all", "--filter", "name=^/" + container + "$",
                                       "--format", "{{.ID}}"], runtime.SAFE_ENV, 15)
            demand(not remaining, "ROTATION_API_CURRENT_CONTAINER_CLEANUP_UNVERIFIED")

    def observe_runtime_boundary(self, phase):
        runtime_state = self.observe_api_configuration(phase)
        if self.profile_arguments():
            self.scope.verify()
            now = time.monotonic()
            previous = getattr(self, "_managed_current_api_proof", None)
            if previous is None or previous[0] != phase or previous[1] != runtime_state["containers"] or now - previous[2] >= 20:
                _, outcome = self.scope._replacement_custody.check_apis(
                    self.scope._profiled_scope, self.output / f"rotation-current-api-{uuid4().hex}")
                demand(outcome.get("status") == "P2_CERTIFICATION_API_DATABASES_READ_ONLY_VERIFIED",
                       "ROTATION_API_DATABASE_NOT_CURRENT")
                self._managed_current_api_proof = (phase, copy.deepcopy(runtime_state["containers"]), time.monotonic())
            course_current = community_current = True
        else:
            course_current, community_current = (
                self._observe_api_database_current(name).get("status") == "P2_RECOVERY_API_DATABASE_CURRENT"
                for name in ("course", "community"))
        snapshot = self._snapshot(phase)
        prefix, environment = runtime.compose_command(snapshot, "staging"), runtime.runtime_environment(self.selected, snapshot, **self.profile_arguments())
        probe = json.loads(self._command([*prefix, "exec", "-T", "gateway", "node", "release-probe.mjs"], environment, 30))
        demand(probe.get("status") == "API_RUNTIME_BOUNDARIES_PASS" and isinstance(probe.get("checks"), list)
               and len(probe["checks"]) == len(runtime.PROBE_CHECKS) and set(probe["checks"]) == runtime.PROBE_CHECKS,
               "ROTATION_RUNTIME_BOUNDARY_PROBE_REFUSED")
        project = vercel.release_identity(self.selected, **self.profile_arguments())[1]
        provider = vercel.promotion_state(self.client, project)
        demand(provider.get("cronsEnabled") is False, "ROTATION_NATIVE_SCHEDULES_NOT_DISABLED")
        for unit in ("lash-her-watchdog.timer", "lash-her-certificates-staging.timer"):
            raw = self._command(["systemctl", "show", "--property=LoadState,ActiveState,UnitFileState", unit],
                                runtime.SAFE_ENV, 15)
            state = dict(line.split("=", 1) for line in raw.splitlines() if "=" in line)
            demand(state.get("LoadState") == "loaded" and state.get("ActiveState") == "inactive"
                   and state.get("UnitFileState") in ("disabled", "static"),
                   "ROTATION_BUSINESS_SCHEDULES_NOT_DISABLED")
        self._runtime_guard_containers = copy.deepcopy(runtime_state["containers"])
        public_containers = [{key: row[key] for key in ("service", "containerId", "image")}
                             for row in runtime_state["containers"]]
        return {"configurationSha256": self.configurations.hashes[phase], "nativeSchedulesEnabled": False,
                "businessSchedulesEnabled": False, "containers": public_containers,
                "courseCurrent": course_current, "communityCurrent": community_current,
                "boundaryChecks": sorted(probe["checks"])}

    def observe_closed_gateway_and_native(self, phase):
        demand(phase in PHASES, "ROTATION_GUARD_PHASE_REQUIRED")
        snapshot = self._snapshot(phase)
        prefix, environment = runtime.compose_command(snapshot, "staging"), runtime.runtime_environment(self.selected, snapshot, **self.profile_arguments())
        program = ('const r=await fetch("http://127.0.0.1:9100/admission");if(!r.ok)process.exit(9);'
                   'const x=await r.json();process.stdout.write(JSON.stringify(x))')
        value = json.loads(self._command([*prefix, "exec", "-T", "gateway", "node", "--input-type=module", "--eval", program],
                                         environment, 15))
        demand(value.get("valid") is True and value.get("newWork") is False and value.get("recovery") is False
               and all(isinstance(value.get(group), dict)
                       and value[group].get("newWork") == 0 and value[group].get("recovery") == 0
                       for group in ("active", "uncertain")), "ROTATION_GATEWAY_NOT_CLOSED")
        project = vercel.release_identity(self.selected, **self.profile_arguments())[1]
        provider = vercel.promotion_state(self.client, project)
        demand(provider.get("cronsEnabled") is False, "ROTATION_NATIVE_SCHEDULES_NOT_DISABLED")
        return {"gatewayAdmissionClosed": True, "gatewayActive": 0, "gatewayUncertain": 0,
                "nativeSchedulesEnabled": False, "phase": phase,
                "configurationSha256": self.configurations.hashes[phase]}

    def recreate_apis(self, phase, *, restoration=False):
        demand(phase in PHASES, "ROTATION_MUTATING_PHASE_REQUIRED")
        self.scope.verify()
        snapshot = self._snapshot(phase, restoration=True) if restoration else self._snapshot(phase)
        token = runtime._command_scope.set(self.scope)
        try:
            runtime.preflight(self.selected, snapshot, self.jobs, pull=False, **self.profile_arguments())
            prefix, environment = runtime.compose_command(snapshot, "staging"), runtime.runtime_environment(self.selected, snapshot, **self.profile_arguments())
            self._command([*prefix, "up", "--detach", "--no-deps", "--pull", "never", "--force-recreate", "--wait",
                           "--wait-timeout", "90", *API_SERVICES], environment)
            self.api_mount_configuration = snapshot
            observed = self.observe_api_configuration(phase)
        finally:
            runtime._command_scope.reset(token)
        self.configurations.directory(phase)
        return {"status": "P2_IDENTITY_ROTATION_API_RECREATED", "phase": phase,
                "configurationSha256": self.configurations.hashes[phase], "containers": observed["containers"],
                "mutationCount": 1, "runtimeVerified": True, "sqlExecuted": False,
                "rolesPrepared": False, "loginChanged": False}

    def _frontend_environment(self):
        project = vercel.release_identity(self.selected, **self.profile_arguments())[1]
        response = self.client.request("GET", f"/v10/projects/{project}/env?decrypt=false")
        rows, pagination = response.get("envs"), response.get("pagination")
        hidden = response.get("hiddenProductionEnvCount", 0)
        demand(isinstance(rows, list) and all(isinstance(row, dict) for row in rows)
               and (pagination is None or isinstance(pagination, dict) and "next" in pagination and pagination["next"] is None)
               and type(hidden) is int and hidden == 0, "ROTATION_FRONTEND_ENVIRONMENT_UNAVAILABLE")
        selected = {}
        for row in rows:
            target = row.get("target")
            if target != "production" and (not isinstance(target, list) or "production" not in target):
                continue
            demand(target == ["production"] and not row.get("gitBranch") and not row.get("customEnvironmentIds"),
                   "ROTATION_FRONTEND_ENVIRONMENT_AMBIGUOUS")
            key = row.get("key")
            demand(isinstance(key, str) and re.fullmatch(r"[A-Z][A-Z0-9_]*", key) and key not in selected
                   and row.get("type") in ("sensitive", "encrypted", "plain")
                   and isinstance(row.get("id"), str) and re.fullmatch(r"[A-Za-z0-9_-]+", row["id"])
                   and ("value" not in row or isinstance(row.get("value"), str)),
                   "ROTATION_FRONTEND_ENVIRONMENT_AMBIGUOUS")
            selected[key] = {field: row.get(field) for field in ("id", "type", "target", "updatedAt")}
        return project, selected

    def _assert_frontend_inventory(self, actual, phase, *, require_overlay=True):
        expected = self.configurations.frontend[phase]
        overlay = set(actual) - set(expected)
        demand(set(expected).issubset(actual) and overlay.issubset(PROBE_OVERLAY_KEYS)
               and (not require_overlay or overlay == PROBE_OVERLAY_KEYS),
               "ROTATION_FRONTEND_CONFIGURATION_CHANGED")
        overlay_types = {"LASH_RELEASE_PROBE_SECRET": "sensitive", "LASH_RELEASE_PROBE_EXPIRES_AT": "plain",
                         "LASH_RELEASE_SCHEDULER_QUALIFICATION": "plain", "API_GATEWAY_STAGING_ORIGIN": "plain"}
        demand(all(actual[key]["type"] == overlay_types[key] for key in overlay),
               "ROTATION_PROBE_OVERLAY_PROVENANCE_REQUIRED")
        demand(all(actual[key]["type"] == "sensitive" for key in set(expected).intersection(PROFILE_KEYS)),
               "ROTATION_PROFILE_KEY_VISIBILITY_REFUSED")

    def _assert_frontend_inventory_one_of(self, actual, phases, *, require_overlay=True):
        demand(isinstance(phases, tuple) and phases and all(phase in PHASES for phase in phases),
               "ROTATION_FRONTEND_PRIOR_PHASE_REFUSED")
        matched = False
        for phase in phases:
            expected = self.configurations.frontend[phase]
            overlay = set(actual) - set(expected)
            overlay_types = {"LASH_RELEASE_PROBE_SECRET": "sensitive", "LASH_RELEASE_PROBE_EXPIRES_AT": "plain",
                             "LASH_RELEASE_SCHEDULER_QUALIFICATION": "plain", "API_GATEWAY_STAGING_ORIGIN": "plain"}
            if (set(expected).issubset(actual) and overlay.issubset(PROBE_OVERLAY_KEYS)
                    and (not require_overlay or overlay == PROBE_OVERLAY_KEYS)
                    and all(actual[key]["type"] == overlay_types[key] for key in overlay)
                    and all(actual[key]["type"] == "sensitive" for key in set(expected).intersection(PROFILE_KEYS))):
                matched = True
        demand(matched, "ROTATION_FRONTEND_CONFIGURATION_CHANGED")

    def _retain_frontend_base_metadata(self, actual):
        expected = set(self.configurations.frontend["baseline"]) - PROFILE_KEYS
        metadata = {key: {field: actual[key].get(field) for field in ("id", "type", "target", "updatedAt")}
                    for key in sorted(expected)}
        path = self.output / "rotation-frontend-base-metadata.json"
        if path.exists():
            retained = migrate.read_json(self.output, path.name)
            demand(retained == {"version": 1, "status": "P2_IDENTITY_ROTATION_FRONTEND_BASE_RETAINED",
                                "actionId": self.scope.action_id, "environment": metadata},
                   "ROTATION_FRONTEND_BASE_METADATA_CHANGED")
        else:
            migrate.write_json(self.output, path.name, {"version": 1,
                "status": "P2_IDENTITY_ROTATION_FRONTEND_BASE_RETAINED", "actionId": self.scope.action_id,
                "environment": metadata})

    def observe_frontend_configuration(self, phase):
        self.configurations.directory(phase)
        project, actual = self._frontend_environment()
        self._assert_frontend_inventory(actual, phase)
        self._retain_frontend_base_metadata(actual)
        state = vercel.promotion_state(self.client, project)
        demand(state["cronsEnabled"] is False and (state["aliasJob"] is None or state["aliasJob"]["jobStatus"] in ("succeeded", "failed", "skipped")),
               "ROTATION_FRONTEND_PROVIDER_BUSY")
        self.configurations.directory(phase)
        return {"configurationSha256": self.configurations.hashes[phase], "deploymentId": state["productionDeploymentId"],
                "cronsEnabled": False, "aliasJobActive": False}

    def _frontend_env_intent(self, phase, key, operation, previous_id):
        demand(key in PROFILE_KEYS and operation in ("delete", "upsert") and
               (previous_id is None and operation == "upsert" or
                isinstance(previous_id, str) and re.fullmatch(r"[A-Za-z0-9_-]+", previous_id)),
               "ROTATION_FRONTEND_ENV_INTENT_REFUSED")
        return {"version": 1, "status": "P2_IDENTITY_ROTATION_ENV_WRITE_INTENT", "actionId": self.scope.action_id,
                "phase": phase, "configurationSha256": self.configurations.hashes[phase], "key": key,
                "operation": operation, "previousEnvironmentId": previous_id}

    @staticmethod
    def _frontend_env_ack(intent, acknowledgement):
        return {**intent, "status": "P2_IDENTITY_ROTATION_ENV_WRITE_ACKNOWLEDGED",
                "acknowledgement": acknowledgement}

    def _configure_frontend(self, phase, attempt, before_phases):
        self.configurations.directory(phase)
        project, before = self._frontend_environment()
        self._assert_frontend_inventory_one_of(before, before_phases, require_overlay=False)
        self._retain_frontend_base_metadata(before)
        desired = {key: value for key, value in self.configurations.frontend[phase].items() if key in PROFILE_KEYS}
        acknowledgements = []
        for key in sorted(PROFILE_KEYS):
            current, value = before.get(key), desired.get(key)
            if current is None and value is None:
                continue
            stem = "rotation-env-" + key.lower().replace("_", "-")
            intent = self._frontend_env_intent(phase, key, "delete" if value is None else "upsert",
                                               current["id"] if current is not None else None)
            migrate.write_json(attempt, stem + "-intent.json", intent)
            if value is None:
                result = self.client.request("DELETE", f"/v9/projects/{project}/env/{current['id']}")
                demand(result == {"id": current["id"], "key": key}, "ROTATION_FRONTEND_DELETE_ACK_UNVERIFIED")
                acknowledgement = {"key": key, "operation": "delete", "environmentId": current["id"]}
            else:
                result = self.client.request("POST", f"/v10/projects/{project}/env?upsert=true", {
                    "key": key, "value": value, "type": "sensitive", "target": ["production"], "gitBranch": None,
                    "customEnvironmentIds": [], "comment": "P2 identity key rotation " + self.scope.action_id})
                created = result.get("created")
                demand(result.get("failed") == [] and isinstance(created, dict) and created.get("key") == key
                       and created.get("target") == ["production"] and created.get("type") == "sensitive"
                       and not created.get("gitBranch") and not created.get("customEnvironmentIds"),
                       "ROTATION_FRONTEND_UPSERT_ACK_UNVERIFIED")
                acknowledgement = {"key": key, "operation": "upsert"}
            migrate.write_json(attempt, stem + "-ack.json", self._frontend_env_ack(intent, acknowledgement))
            acknowledgements.append(acknowledgement)
        after = self._frontend_environment()[1]
        self._assert_frontend_inventory(after, phase, require_overlay=False)
        self._retain_frontend_base_metadata(after)
        migrate.write_json(attempt, "rotation-frontend-configuration.json", {
            "version": 1, "status": "P2_IDENTITY_ROTATION_FRONTEND_CONFIGURATION_ACKNOWLEDGED",
            "actionId": self.scope.action_id, "phase": phase,
            "configurationSha256": self.configurations.hashes[phase], "acknowledgements": acknowledgements,
            "readback": [{"key": key, "environmentId": after[key]["id"], "type": after[key]["type"]}
                         for key in sorted(desired)], "secretValuesReadBack": False})
        self.configurations.directory(phase)
        return {"configurationSha256": self.configurations.hashes[phase]}

    def _rollout_frontend(self, phase, expected_feature_controls, expected_writer_binding, stem, before_phases):
        demand(phase in PHASES and re.fullmatch(r"frontend-(?:overlap|current-only|restoration-(?:baseline|overlap))", stem),
               "ROTATION_MUTATING_PHASE_REQUIRED")
        attempt = self.output / stem
        private = self.output / f"{stem}-private"
        attempt.mkdir(mode=0o700); private.mkdir(mode=0o700)
        self.scope.verify(); self._configure_frontend(phase, attempt, before_phases); self.scope.verify()
        frontend_probe.prepare(self.client, self.selected, private, attempt, self.gateway_host, scheduler_qualification=False, **self.profile_arguments())
        vercel.stage_frontend(self.client, self.selected, attempt, **self.profile_arguments())

        verified_deployment = {}
        def verify(release, deployment):
            workload = frontend_probe.verify(self.client, release, attempt, private,
                                              probe_client=LockedProbe(self.scope.verify),
                                              expected_feature_controls=expected_feature_controls,
                                              expected_writer_admission_binding=expected_writer_binding,
                                              **self.profile_arguments())
            verified_deployment.update(deployment)
            return workload

        promotion = vercel.promote_frontend(self.client, self.selected, attempt, verify, **self.profile_arguments())
        demand(promotion.get("frontendDomainsPromoted") is True, "ROTATION_FRONTEND_PROMOTION_UNVERIFIED")
        state = self.observe_frontend_configuration(phase)
        demand(state["deploymentId"] == promotion["deploymentId"] == verified_deployment.get("deploymentId")
               and re.fullmatch(r"https://[a-z0-9][a-z0-9-]*\.vercel\.app", verified_deployment.get("url", "")),
               "ROTATION_FRONTEND_CURRENT_DEPLOYMENT_CHANGED")
        workload_sha256 = migrate.file_hash(migrate.read_input(attempt, "frontend-workload-outcome.json"))
        return {"status": "P2_IDENTITY_ROTATION_FRONTEND_PROMOTED", "phase": phase,
                "configurationSha256": self.configurations.hashes[phase], "deploymentId": promotion["deploymentId"],
                "deploymentUrl": verified_deployment["url"], "sourceCommit": self.scope.source_commit,
                "workloadReceiptSha256": workload_sha256,
                "mutationCount": 1, "runtimeVerified": True, "sqlExecuted": False,
                "rolesPrepared": False, "loginChanged": False}

    def rollout_frontend(self, phase, expected_feature_controls, expected_writer_binding):
        demand(phase in ("overlap", "current-only"), "ROTATION_MUTATING_PHASE_REQUIRED")
        before = ("baseline",) if phase == "overlap" else ("overlap",)
        return self._rollout_frontend(phase, expected_feature_controls, expected_writer_binding, f"frontend-{phase}", before)

    def restore_qualified(self, phase, expected_configuration_sha256, expected_feature_controls,
                          expected_writer_binding):
        demand(phase in ("baseline", "overlap")
               and expected_configuration_sha256 == self.configurations.hashes[phase],
               "ROTATION_RESTORATION_PHASE_REFUSED")
        self.scope.verify()
        api = self.recreate_apis(phase, restoration=True)
        before = ("baseline", "overlap") if phase == "baseline" else ("overlap", "current-only")
        frontend = self._rollout_frontend(phase, expected_feature_controls, expected_writer_binding,
                                          f"frontend-restoration-{phase}", before)
        observed_api = self.observe_api_configuration(phase)
        observed_frontend = self.observe_frontend_configuration(phase)
        self.scope.verify()
        demand(observed_api.get("configurationSha256") == expected_configuration_sha256
               and observed_frontend.get("configurationSha256") == expected_configuration_sha256
               and observed_frontend.get("deploymentId") == frontend.get("deploymentId"),
               "ROTATION_RESTORATION_UNVERIFIED")
        return {"status": "P2_IDENTITY_ROTATION_LAST_QUALIFIED_PHASE_RESTORED", "phase": phase,
                "configurationSha256": expected_configuration_sha256,
                "apiMutationCount": api["mutationCount"], "frontendMutationCount": frontend["mutationCount"],
                "sqlExecuted": False, "rolesPrepared": False, "loginChanged": False,
                "trafficAuthorized": False}

    def frontend_deployment(self, phase):
        demand(phase in ("overlap", "current-only"), "ROTATION_FRONTEND_PHASE_REQUIRED")
        attempt = self.output / f"frontend-{phase}"
        staged = migrate.read_json(attempt, "frontend-build-outcome.json")
        workload = migrate.read_input(attempt, "frontend-workload-outcome.json")
        promotion = (migrate.read_json(attempt, "frontend-promotion-outcome.json")
                     if (attempt / "frontend-promotion-outcome.json").exists() else None)
        if not (isinstance(promotion, dict) and promotion.get("status") == "FRONTEND_DOMAINS_PROMOTED"
                and promotion.get("frontendDomainsPromoted") is True):
            promotion = vercel.observe_frontend_promotion(self.client, self.selected, attempt, **self.profile_arguments())
        provider = self.observe_frontend_configuration(phase)
        demand(isinstance(staged, dict) and staged.get("status") == "FRONTEND_STAGED"
               and staged.get("readyState") == "READY" and staged.get("sourceCommit") == self.scope.source_commit
               and re.fullmatch(r"https://[a-z0-9][a-z0-9-]*\.vercel\.app", staged.get("url", ""))
               and promotion.get("deploymentId") == staged.get("deploymentId") == provider.get("deploymentId"),
               "ROTATION_FRONTEND_DEPLOYMENT_UNVERIFIED")
        return {"phase": phase, "deploymentId": staged["deploymentId"], "deploymentUrl": staged["url"],
                "sourceCommit": self.scope.source_commit, "configurationSha256": self.configurations.hashes[phase],
                "workloadReceiptSha256": migrate.file_hash(workload)}

    def retain_frontend_signer(self, phase, source_record):
        configuration_phase = signer_configuration_phase(phase)
        deployment = self.frontend_deployment(configuration_phase)
        fields = {"version", "status", "environment", "actionId", "challenge", "bindingSha256", "sourceCommit",
                  "candidateSha256", "phase", "configurationSha256", "deploymentId", "deploymentUrl",
                  "browserOrigin", "canonicalAliasReadbackSha256", "canonicalProtectedWorkloadSha256",
                  "workloadReceiptSha256", "browserProgramSha256", "windowStartedAt", "windowCompletedAt", "evidenceClass", "profiles",
                  "contextsIsolated", "sessionsFabricated", "requestsIntercepted", "storageInjected",
                  "tokenBytesOutput", "credentialHashesOutput", "releaseAccepted"}
        demand(isinstance(source_record, dict) and set(source_record) == fields and source_record.get("version") == 1
               and source_record.get("status") == "P2_IDENTITY_ROTATION_BROWSER_READS_RECORDED"
               and source_record.get("environment") == "staging" and source_record.get("actionId") == self.scope.action_id
               and source_record.get("bindingSha256") == self.scope.binding_sha256
               and source_record.get("candidateSha256") == self.scope.candidate_sha256
               and source_record.get("sourceCommit") == self.scope.source_commit and source_record.get("phase") == phase
               and re.fullmatch(r"[a-f0-9]{64}", source_record.get("challenge", ""))
               and all(source_record.get(key) == deployment[key] for key in ("configurationSha256", "deploymentId",
                    "deploymentUrl", "workloadReceiptSha256"))
               and source_record.get("browserOrigin") == "https://staging.lashher.com"
               and all(re.fullmatch(r"[a-f0-9]{64}", source_record.get(key, "")) for key in
                       ("canonicalAliasReadbackSha256", "canonicalProtectedWorkloadSha256"))
               and source_record.get("browserProgramSha256") == self.scope.browser_program_sha256
               and source_record.get("evidenceClass") == "actual-frontend-normal-course-signer-protected-http"
               and all(source_record.get(key) is expected for key, expected in {
                    "contextsIsolated": True, "sessionsFabricated": False, "requestsIntercepted": False,
                    "storageInjected": False, "tokenBytesOutput": False, "credentialHashesOutput": False,
                    "releaseAccepted": False}.items())
               and isinstance(source_record.get("windowStartedAt"), str)
               and isinstance(source_record.get("windowCompletedAt"), str)
               and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", source_record["windowStartedAt"])
               and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", source_record["windowCompletedAt"]),
               "ROTATION_FRONTEND_BROWSER_SOURCE_REFUSED")
        started = source_record["windowStartedAt"].replace("Z", "+00:00")
        completed = source_record["windowCompletedAt"].replace("Z", "+00:00")
        started_at, completed_at = datetime.fromisoformat(started), datetime.fromisoformat(completed)
        demand(completed_at >= started_at and (completed_at - started_at).total_seconds() <= 60,
               "ROTATION_FRONTEND_BROWSER_WINDOW_REFUSED")
        rows = source_record.get("profiles")
        demand(isinstance(rows, list) and len(rows) == 2
               and {row.get("profile") for row in rows} == {"course-learner", "course-admin"}
               and all(isinstance(row, dict) and set(row) == {"profile", "httpStatus", "requestId", "observedAt",
                    "privateNoStore", "courseBindingVerified"} and row.get("httpStatus") == 200
                    and row.get("privateNoStore") is True and row.get("courseBindingVerified") is True
                    and re.fullmatch(r"[a-f0-9-]{36}", row.get("requestId", ""))
                    and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", row.get("observedAt", ""))
                    and started_at <= datetime.fromisoformat(row["observedAt"].replace("Z", "+00:00")) <= completed_at
                    for row in rows), "ROTATION_FRONTEND_BROWSER_PROFILES_REFUSED")
        source_sha256 = migrate.file_hash(json.dumps(source_record, sort_keys=True, separators=(",", ":")).encode())
        signer = {"version": 1, "status": "P2_IDENTITY_ROTATION_FRONTEND_SIGNER_VERIFIED", "phase": phase,
                  "bindingSha256": self.scope.binding_sha256, "candidateSha256": self.scope.candidate_sha256,
                  "sourceCommit": self.scope.source_commit, "configurationSha256": self.configurations.hashes[configuration_phase],
                  "deploymentId": deployment["deploymentId"], "issuanceCutoffAt": source_record["windowCompletedAt"],
                  "receiptSha256": source_sha256,
                  "profiles": [{"profile": row["profile"], "status": row["httpStatus"], "requestId": row["requestId"]}
                               for row in rows],
                  "evidenceClass": source_record["evidenceClass"], "tokenBytesOutput": False, "releaseAccepted": False}
        self._validate_frontend_signer(signer, phase, deployment["deploymentId"])
        attempt = self.output / f"frontend-{configuration_phase}"
        if phase == "post-removal":
            attempt = self.output / "frontend-post-removal"
            attempt.mkdir(mode=0o700)
        migrate.write_json(attempt, "rotation-frontend-browser-source.json", source_record)
        migrate.write_json(attempt, "rotation-frontend-signer.json", signer)
        return copy.deepcopy(signer)

    def observe_frontend_signer(self, phase):
        deployment = self.frontend_deployment(signer_configuration_phase(phase))
        signer = migrate.read_json(self.output / f"frontend-{phase}", "rotation-frontend-signer.json")
        return copy.deepcopy(self._validate_frontend_signer(signer, phase, deployment["deploymentId"]))

    def retained_frontend_signer(self, phase):
        configuration_phase = signer_configuration_phase(phase)
        attempt = self.output / f"frontend-{phase}"
        source = migrate.read_json(attempt, "rotation-frontend-browser-source.json")
        signer = migrate.read_json(attempt, "rotation-frontend-signer.json")
        demand(isinstance(source, dict) and source.get("status") == "P2_IDENTITY_ROTATION_BROWSER_READS_RECORDED"
               and source.get("actionId") == self.scope.action_id and source.get("bindingSha256") == self.scope.binding_sha256
               and source.get("candidateSha256") == self.scope.candidate_sha256
               and source.get("sourceCommit") == self.scope.source_commit and source.get("phase") == phase
               and source.get("configurationSha256") == self.configurations.hashes[configuration_phase]
               and source.get("browserOrigin") == "https://staging.lashher.com"
               and all(re.fullmatch(r"[a-f0-9]{64}", source.get(key, "")) for key in
                       ("canonicalAliasReadbackSha256", "canonicalProtectedWorkloadSha256"))
               and source.get("browserProgramSha256") == self.scope.browser_program_sha256
               and source.get("deploymentId") == signer.get("deploymentId")
               and migrate.file_hash(json.dumps(source, sort_keys=True, separators=(",", ":")).encode())
                   == signer.get("receiptSha256"), "ROTATION_RETAINED_FRONTEND_SIGNER_CHANGED")
        return copy.deepcopy(self._validate_frontend_signer(signer, phase, source["deploymentId"]))

    def _validate_frontend_signer(self, signer, phase, deployment_id):
        fields = {"version", "status", "phase", "bindingSha256", "candidateSha256", "sourceCommit",
                  "configurationSha256", "deploymentId", "issuanceCutoffAt", "receiptSha256", "profiles",
                  "evidenceClass", "tokenBytesOutput", "releaseAccepted"}
        demand(isinstance(signer, dict) and set(signer) == fields and signer.get("version") == 1
               and signer.get("status") == "P2_IDENTITY_ROTATION_FRONTEND_SIGNER_VERIFIED"
               and signer.get("phase") == phase and signer.get("bindingSha256") == self.scope.binding_sha256
               and signer.get("candidateSha256") == self.scope.candidate_sha256
               and signer.get("sourceCommit") == self.scope.source_commit
               and signer.get("configurationSha256") == self.configurations.hashes[signer_configuration_phase(phase)]
               and signer.get("deploymentId") == deployment_id and re.fullmatch(r"dpl_[A-Za-z0-9]+", deployment_id or "")
               and isinstance(signer.get("issuanceCutoffAt"), str)
               and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z", signer["issuanceCutoffAt"])
               and re.fullmatch(r"[a-f0-9]{64}", signer.get("receiptSha256", ""))
               and signer.get("evidenceClass") == "actual-frontend-normal-course-signer-protected-http"
               and signer.get("tokenBytesOutput") is False and signer.get("releaseAccepted") is False
               and isinstance(signer.get("profiles"), list) and len(signer["profiles"]) == 2
               and {row.get("profile") for row in signer["profiles"]} == {"course-learner", "course-admin"}
               and all(isinstance(row, dict) and set(row) == {"profile", "status", "requestId"}
                       and row.get("status") == 200
                       and isinstance(row.get("requestId"), str)
                       and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", row["requestId"])
                       for row in signer["profiles"]), "ROTATION_FRONTEND_SIGNER_UNVERIFIED")
        return signer

    def _validate_frontend_configuration_receipt(self, value, phase, attempt):
        self.configurations.directory(phase)
        fields = {"version", "status", "actionId", "phase", "configurationSha256", "acknowledgements",
                  "readback", "secretValuesReadBack"}
        desired = {key for key in self.configurations.frontend[phase] if key in PROFILE_KEYS}
        demand(isinstance(value, dict) and set(value) == fields and value.get("version") == 1
               and value.get("status") == "P2_IDENTITY_ROTATION_FRONTEND_CONFIGURATION_ACKNOWLEDGED"
               and value.get("actionId") == self.scope.action_id and value.get("phase") == phase
               and value.get("configurationSha256") == self.configurations.hashes[phase]
               and value.get("secretValuesReadBack") is False
               and isinstance(value.get("acknowledgements"), list) and len(value["acknowledgements"]) == len(PROFILE_KEYS)
               and {row.get("key") for row in value["acknowledgements"]} == set(PROFILE_KEYS)
               and all(isinstance(row, dict) and row.get("operation") == ("upsert" if row.get("key") in desired else "delete")
                       and set(row) == ({"key", "operation"} if row.get("operation") == "upsert"
                                        else {"key", "operation", "environmentId"})
                       and (row.get("operation") != "delete" or re.fullmatch(r"[A-Za-z0-9_-]+", row.get("environmentId", "")))
                       for row in value["acknowledgements"])
               and isinstance(value.get("readback"), list) and len(value["readback"]) == len(desired)
               and {row.get("key") for row in value["readback"]} == desired
               and all(isinstance(row, dict) and set(row) == {"key", "environmentId", "type"}
                       and row.get("type") == "sensitive"
                       and re.fullmatch(r"[A-Za-z0-9_-]+", row.get("environmentId", "")) for row in value["readback"]),
               "ROTATION_FRONTEND_CONFIGURATION_ACK_REQUIRED")
        for acknowledgement in value["acknowledgements"]:
            key, operation = acknowledgement["key"], acknowledgement["operation"]
            stem = "rotation-env-" + key.lower().replace("_", "-")
            intent = migrate.read_json(attempt, stem + "-intent.json")
            previous_id = intent.get("previousEnvironmentId")
            demand(intent == self._frontend_env_intent(phase, key, operation, previous_id)
                   and (operation != "delete" or previous_id == acknowledgement["environmentId"])
                   and migrate.read_json(attempt, stem + "-ack.json") == self._frontend_env_ack(intent, acknowledgement),
                   "ROTATION_FRONTEND_ENV_ACK_CHANGED")
        return value

    def apply_mutation(self, intent, expected_feature_controls, expected_writer_binding):
        intent = self._intent(intent)
        if intent["kind"] == "api":
            self.recreate_apis(intent["phase"])
        else:
            self.rollout_frontend(intent["phase"], expected_feature_controls, expected_writer_binding)
        return self._result(intent, False)

    def reconcile_mutation(self, intent):
        intent = self._intent(intent)
        phase = intent["phase"]
        if intent["kind"] == "api":
            self.api_mount_configuration = self._snapshot(phase)
            observed = self.observe_api_configuration(phase)
            demand(observed.get("runtimeVerified") is True
                   and observed.get("configurationSha256") == self.configurations.hashes[phase],
                   "ROTATION_API_RECONCILIATION_UNRESOLVED")
            return self._result(intent, True)
        attempt = self.output / f"frontend-{phase}"
        migrate.private_directory(attempt)
        staged = vercel._staged_identity(self.selected, attempt, **self.profile_arguments())
        promotion = (migrate.read_json(attempt, "frontend-promotion-outcome.json")
                     if (attempt / "frontend-promotion-outcome.json").exists() else None)
        if not (isinstance(promotion, dict) and promotion.get("status") == "FRONTEND_DOMAINS_PROMOTED"
                and promotion.get("frontendDomainsPromoted") is True):
            try:
                promotion = vercel.observe_frontend_promotion(self.client, self.selected, attempt, **self.profile_arguments())
            except BaseException:
                raise ValueError("ROTATION_FRONTEND_RECONCILIATION_UNRESOLVED") from None
        workload = migrate.read_json(attempt, "frontend-workload-outcome.json")
        configured = migrate.read_json(attempt, "rotation-frontend-configuration.json")
        provider = self.observe_frontend_configuration(phase)
        demand(promotion.get("status") == "FRONTEND_DOMAINS_PROMOTED" and promotion.get("frontendDomainsPromoted") is True
               and promotion.get("deploymentId") == staged["deploymentId"] == provider.get("deploymentId")
               and workload.get("status") == "FRONTEND_VERIFIED" and workload.get("deploymentId") == staged["deploymentId"],
               "ROTATION_FRONTEND_RECONCILIATION_UNRESOLVED")
        self._validate_frontend_configuration_receipt(configured, phase, attempt)
        return self._result(intent, True)


SOURCE_PARENT_DISPATCH_INTEGRATED = False
