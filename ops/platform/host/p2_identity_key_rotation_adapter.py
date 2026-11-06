"""Fixed in-process host adapter for the P2 application-user key rotation.

There is deliberately no CLI. A source-owned parent must supply an inherited
P2IdentityRotationScope, the reviewed release inputs, and the fixed three
private configuration directories.
"""
import copy
import json
import os
from pathlib import Path
import re

import frontend_probe
import migrate
import p2_identity_key_rotation as rotation_source
from p2_release_scope import P2ReleaseScope
import release as runtime
import staging_state
import vercel

demand = migrate.demand
PHASES = ("baseline", "overlap", "current-only")
PROFILE_PREFIXES = ("COURSE_LEARNER", "COURSE_ADMIN", "COMMUNITY_MEMBER", "COMMUNITY_ADMIN")
PROFILE_KEYS = frozenset(f"{prefix}_JWT_{slot}_SECRET" for prefix in PROFILE_PREFIXES for slot in ("CURRENT", "PREVIOUS"))
PROBE_OVERLAY_KEYS = frozenset(("LASH_RELEASE_PROBE_SECRET", "LASH_RELEASE_PROBE_EXPIRES_AT",
                                "LASH_RELEASE_SCHEDULER_QUALIFICATION", "API_GATEWAY_STAGING_ORIGIN"))
API_SERVICES = ("course-api", "community-api")


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


def _phase_hash(directory):
    files = (*runtime.CONFIG_FILES, *runtime.TLS_FILES, *(f"{service}.env" for service in runtime.ENV_FILES),
             "runtime.json", "frontend.env")
    payload = bytearray()
    for relative in sorted(files):
        raw = migrate.read_input(directory, relative, 65_536)
        payload.extend(relative.encode() + b"\0" + raw + b"\0")
    return migrate.file_hash(bytes(payload))


class P2IdentityRotationScope(P2ReleaseScope):
    def __init__(self, descriptor, path, verify_frontend, receipt, candidate_sha256, *, action_id, binding_sha256,
                 source_commit, release, jobs, configuration_sha256, private_configuration_sha256):
        demand(isinstance(action_id, str) and re.fullmatch(r"p2-key-rotation-[a-z0-9-]{1,40}", action_id)
               and isinstance(binding_sha256, str) and re.fullmatch(r"[a-f0-9]{64}", binding_sha256)
               and isinstance(source_commit, str) and re.fullmatch(r"[a-f0-9]{40}", source_commit)
               and release.get("environment") == "staging" and vercel.release_identity(release)[2] == source_commit
               and set(configuration_sha256) == set(private_configuration_sha256) == set(PHASES)
               and all(re.fullmatch(r"[a-f0-9]{64}", value or "") for value in configuration_sha256.values()),
               "P2_ROTATION_SCOPE_BINDING_REQUIRED")
        demand(all(re.fullmatch(r"[a-f0-9]{64}", value or "") for value in private_configuration_sha256.values())
               and all(configuration_sha256[phase] != private_configuration_sha256[phase] for phase in PHASES),
               "P2_ROTATION_PRIVATE_CONFIGURATION_BINDING_REQUIRED")
        self.action_id, self.binding_sha256, self.source_commit = action_id, binding_sha256, source_commit
        self.rotation_configuration_sha256 = copy.deepcopy(configuration_sha256)
        self.private_rotation_configuration_sha256 = copy.deepcopy(private_configuration_sha256)
        super().__init__(descriptor, path, verify_frontend, receipt, candidate_sha256, release=release, jobs=jobs)
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
        self.hashes, self.private_hashes = copy.deepcopy(public_expected), {}
        self.frontend, self.api = {}, {}
        for phase, directory in self.directories.items():
            migrate.private_directory(directory)
            self.private_hashes[phase] = _phase_hash(directory)
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
    def __init__(self, scope, selected, jobs, configuration_root, output, compose_file, client, gateway_host,
                 frontend_signer_verifier, operator_source, operator_program_sha256):
        demand(type(scope) is P2IdentityRotationScope and callable(frontend_signer_verifier),
               "P2_ROTATION_TYPED_SCOPE_REQUIRED")
        self.scope, self.selected, self.jobs, self.output = scope, copy.deepcopy(selected), copy.deepcopy(jobs), Path(output)
        self.compose_file, self.client, self.gateway_host = Path(compose_file), client, gateway_host
        self.frontend_signer_verifier = frontend_signer_verifier
        operator_source = Path(operator_source)
        demand(operator_source.is_absolute() and operator_source.resolve() == operator_source
               and operator_source == Path("/opt/lash-her/operators") / scope.source_commit
               and not any(parent.is_symlink() for parent in (operator_source, *operator_source.parents) if parent.exists()),
               "P2_ROTATION_OPERATOR_SOURCE_CHANGED")
        self.operator_program = rotation_source.private_program(operator_source)
        demand(migrate.file_hash(self.operator_program) == operator_program_sha256,
               "P2_ROTATION_OPERATOR_PROGRAM_CHANGED")
        self.configurations = RotationConfigurationSet(configuration_root, scope.rotation_configuration_sha256,
                                                       scope.private_rotation_configuration_sha256)
        demand(selected == scope.release and jobs == scope.jobs and vercel.release_identity(selected)[2] == scope.source_commit,
               "P2_ROTATION_REVIEWED_RELEASE_CHANGED")
        migrate.private_directory(self.output)

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

    def _snapshot(self, phase):
        source = self.configurations.directory(phase)
        destination = self.output / f"runtime-{phase}"
        if not destination.exists():
            compose = migrate.read_input(self.compose_file.parent, self.compose_file.name)
            runtime.snapshot_configuration(source, destination, self.selected, self.jobs, compose)
        else:
            expected = staging_state.configuration_hashes(source)
            demand(staging_state.configuration_hashes(destination) == expected
                   and migrate.file_hash(migrate.read_input(destination, "compose.yaml"))
                       == migrate.file_hash(migrate.read_input(self.compose_file.parent, self.compose_file.name)),
                   "ROTATION_RETAINED_SNAPSHOT_CHANGED")
        self.configurations.directory(phase)
        demand(_phase_hash(destination) == self.configurations.private_hashes[phase],
               "ROTATION_SNAPSHOT_CONFIGURATION_CHANGED")
        return destination

    def _private_child(self, phase, service, payload):
        demand(phase in ("overlap", "current-only") and service in ("gateway", "community-api"),
               "ROTATION_PRIVATE_CHILD_TARGET_REFUSED")
        snapshot = self._snapshot(phase)
        prefix, environment = runtime.compose_command(snapshot, "staging"), runtime.runtime_environment(self.selected, snapshot)
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

    def capture_tokens(self, subjects, course_id, binding_sha256):
        demand(isinstance(subjects, dict) and set(subjects) == {
            "course-learner", "course-admin", "community-member", "community-admin"}
            and all(isinstance(value, str) and re.fullmatch(r"[a-f0-9-]{36}", value) for value in subjects.values())
            and isinstance(course_id, str) and re.fullmatch(r"[a-f0-9-]{36}", course_id)
            and binding_sha256 == self.scope.binding_sha256, "ROTATION_CAPTURE_SUBJECT_BINDING_REQUIRED")
        if (self.output / "rotation-token-captures.json").exists():
            return copy.deepcopy(self._retained_captures())
        phase, configuration = "overlap", self.configurations.hashes["overlap"]
        gateway_ca = migrate.read_input(self._snapshot(phase), "tls/ca.pem", 65_536)
        captures = []
        for profile in ("community-admin", "community-member", "course-admin", "course-learner"):
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
            demand(value.get("status") == "P2_IDENTITY_ROTATION_PRIVATE_TOKENS_CAPTURED"
                   and value.get("bindingSha256") == binding_sha256 and value.get("profile") == profile
                   and value.get("configurationSha256") == configuration and value.get("privateCredentialBytes") is True,
                   "ROTATION_PRIVATE_CAPTURE_REFUSED")
            captures.append(value)
        record = {"version": 1, "status": "P2_IDENTITY_ROTATION_PRIVATE_CAPTURE_RETAINED",
                  "actionId": self.scope.action_id, "bindingSha256": binding_sha256,
                  "configurationSha256": configuration, "captures": captures}
        migrate.write_json(self.output, "rotation-token-captures.json", record)
        return copy.deepcopy(captures)

    def _retained_captures(self):
        self.configurations.directory("overlap")
        record = migrate.read_json(self.output, "rotation-token-captures.json")
        demand(isinstance(record, dict) and set(record) == {"version", "status", "actionId", "bindingSha256",
            "configurationSha256", "captures"} and record.get("version") == 1
            and record.get("status") == "P2_IDENTITY_ROTATION_PRIVATE_CAPTURE_RETAINED"
            and record.get("actionId") == self.scope.action_id and record.get("bindingSha256") == self.scope.binding_sha256
            and record.get("configurationSha256") == self.configurations.hashes["overlap"]
            and isinstance(record.get("captures"), list) and len(record["captures"]) == 4
            and {item.get("profile") for item in record["captures"]} == {
                "course-learner", "course-admin", "community-member", "community-admin"}
            and all(isinstance(item, dict) and item.get("status") == "P2_IDENTITY_ROTATION_PRIVATE_TOKENS_CAPTURED"
                and item.get("bindingSha256") == self.scope.binding_sha256
                and item.get("configurationSha256") == self.configurations.hashes["overlap"]
                and item.get("privateCredentialBytes") is True and item.get("commonTokenBytesOutput") is False
                and isinstance(item.get("oldToken"), str) and isinstance(item.get("newToken"), str)
                and re.fullmatch(r"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", item["oldToken"])
                and re.fullmatch(r"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", item["newToken"])
                and item["oldToken"] != item["newToken"] for item in record["captures"]),
            "ROTATION_RETAINED_CAPTURE_CHANGED")
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

    def observe_api_configuration(self, phase):
        self.scope.verify()
        snapshot = self._snapshot(phase)
        prefix, environment = runtime.compose_command(snapshot, "staging"), runtime.runtime_environment(self.selected, snapshot)
        for service in API_SERVICES:
            expected = self.configurations.api[phase][service]
            selected = {key: value for key, value in expected.items() if key in PROFILE_KEYS}
            relevant_prefixes = PROFILE_PREFIXES[:2] if service == "course-api" else PROFILE_PREFIXES[2:]
            inventory = sorted(f"{prefix}_JWT_{slot}_SECRET" for prefix in relevant_prefixes for slot in ("CURRENT", "PREVIOUS"))
            program = ("import{readFileSync}from'node:fs';import{timingSafeEqual}from'node:crypto';"
                       "const x=JSON.parse(readFileSync(0,'utf8')),a=x.inventory.filter(k=>process.env[k]!==undefined).sort(),"
                       "b=Object.keys(x.desired).sort(),eq=(l,r)=>Buffer.byteLength(l)===Buffer.byteLength(r)&&timingSafeEqual(Buffer.from(l),Buffer.from(r));"
                       "if(JSON.stringify(a)!==JSON.stringify(b)||b.some(k=>!eq(process.env[k]??'',x.desired[k])))process.exit(9)")
            self._command([*prefix, "exec", "-T", service, "node", "--input-type=module", "--eval", program],
                          environment, 30, json.dumps({"desired": selected, "inventory": inventory}))
        token = runtime._command_scope.set(self.scope)
        try:
            containers = runtime.check_containers(self.selected, snapshot)
        finally:
            runtime._command_scope.reset(token)
        self.scope.verify()
        return {"configurationSha256": self.configurations.hashes[phase], "containers": containers, "runtimeVerified": True}

    def recreate_apis(self, phase):
        demand(phase in ("overlap", "current-only"), "ROTATION_MUTATING_PHASE_REQUIRED")
        self.scope.verify()
        snapshot = self._snapshot(phase)
        token = runtime._command_scope.set(self.scope)
        try:
            runtime.preflight(self.selected, snapshot, self.jobs, pull=False)
            prefix, environment = runtime.compose_command(snapshot, "staging"), runtime.runtime_environment(self.selected, snapshot)
            self._command([*prefix, "up", "--detach", "--no-deps", "--pull", "never", "--force-recreate", "--wait",
                           "--wait-timeout", "90", *API_SERVICES], environment)
            observed = self.observe_api_configuration(phase)
        finally:
            runtime._command_scope.reset(token)
        self.configurations.directory(phase)
        return {"status": "P2_IDENTITY_ROTATION_API_RECREATED", "phase": phase,
                "configurationSha256": self.configurations.hashes[phase], "containers": observed["containers"],
                "mutationCount": 1, "runtimeVerified": True, "sqlExecuted": False,
                "rolesPrepared": False, "loginChanged": False}

    def _frontend_environment(self):
        project = vercel.release_identity(self.selected)[1]
        rows = self.client.request("GET", f"/v10/projects/{project}/env?decrypt=false").get("envs")
        demand(isinstance(rows, list), "ROTATION_FRONTEND_ENVIRONMENT_UNAVAILABLE")
        selected = {}
        for row in rows:
            if row.get("target") != ["production"] or row.get("gitBranch") or row.get("customEnvironmentIds"):
                continue
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

    def _configure_frontend(self, phase, attempt):
        self.configurations.directory(phase)
        project, before = self._frontend_environment()
        self._assert_frontend_inventory(before, "baseline" if phase == "overlap" else "overlap", require_overlay=False)
        self._retain_frontend_base_metadata(before)
        desired = {key: value for key, value in self.configurations.frontend[phase].items() if key in PROFILE_KEYS}
        acknowledgements = []
        for key in sorted(PROFILE_KEYS):
            current, value = before.get(key), desired.get(key)
            if value is None:
                if current is not None:
                    result = self.client.request("DELETE", f"/v9/projects/{project}/env/{current['id']}")
                    demand(result.get("id") == current["id"] or result.get("uid") == current["id"], "ROTATION_FRONTEND_DELETE_ACK_UNVERIFIED")
                    acknowledgements.append({"key": key, "operation": "delete", "environmentId": current["id"]})
            else:
                result = self.client.request("POST", f"/v10/projects/{project}/env?upsert=true", {
                    "key": key, "value": value, "type": "sensitive", "target": ["production"], "gitBranch": None,
                    "customEnvironmentIds": [], "comment": "P2 identity key rotation " + self.scope.action_id})
                created = result.get("created")
                demand(result.get("failed") == [] and isinstance(created, dict) and created.get("key") == key
                       and created.get("target") == ["production"] and created.get("type") == "sensitive"
                       and not created.get("gitBranch") and not created.get("customEnvironmentIds"),
                       "ROTATION_FRONTEND_UPSERT_ACK_UNVERIFIED")
                acknowledgements.append({"key": key, "operation": "upsert"})
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

    def rollout_frontend(self, phase, expected_feature_controls, expected_writer_binding):
        demand(phase in ("overlap", "current-only"), "ROTATION_MUTATING_PHASE_REQUIRED")
        attempt = self.output / f"frontend-{phase}"
        private = self.output / f"frontend-{phase}-private"
        attempt.mkdir(mode=0o700); private.mkdir(mode=0o700)
        self.scope.verify(); self._configure_frontend(phase, attempt); self.scope.verify()
        frontend_probe.prepare(self.client, self.selected, private, attempt, self.gateway_host, scheduler_qualification=False)
        vercel.stage_frontend(self.client, self.selected, attempt)

        def verify(release, _deployment):
            workload = frontend_probe.verify(self.client, release, attempt, private,
                                              expected_feature_controls=expected_feature_controls,
                                              expected_writer_admission_binding=expected_writer_binding)
            signer = self.frontend_signer_verifier(phase, release, attempt, _deployment)
            self._validate_frontend_signer(signer, phase, _deployment.get("deploymentId"))
            migrate.write_json(attempt, "rotation-frontend-signer.json", signer)
            return workload

        promotion = vercel.promote_frontend(self.client, self.selected, attempt, verify)
        demand(promotion.get("frontendDomainsPromoted") is True, "ROTATION_FRONTEND_PROMOTION_UNVERIFIED")
        state = self.observe_frontend_configuration(phase)
        demand(state["deploymentId"] == promotion["deploymentId"], "ROTATION_FRONTEND_CURRENT_DEPLOYMENT_CHANGED")
        return {"status": "P2_IDENTITY_ROTATION_FRONTEND_PROMOTED", "phase": phase,
                "configurationSha256": self.configurations.hashes[phase], "deploymentId": promotion["deploymentId"],
                "mutationCount": 1, "runtimeVerified": True, "sqlExecuted": False,
                "rolesPrepared": False, "loginChanged": False}

    def _validate_frontend_signer(self, signer, phase, deployment_id):
        fields = {"version", "status", "phase", "bindingSha256", "candidateSha256", "sourceCommit",
                  "configurationSha256", "deploymentId", "issuanceCutoffAt", "receiptSha256", "profiles",
                  "evidenceClass", "tokenBytesOutput", "releaseAccepted"}
        demand(isinstance(signer, dict) and set(signer) == fields and signer.get("version") == 1
               and signer.get("status") == "P2_IDENTITY_ROTATION_FRONTEND_SIGNER_VERIFIED"
               and signer.get("phase") == phase and signer.get("bindingSha256") == self.scope.binding_sha256
               and signer.get("candidateSha256") == self.scope.candidate_sha256
               and signer.get("sourceCommit") == self.scope.source_commit
               and signer.get("configurationSha256") == self.configurations.hashes[phase]
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

    def _validate_frontend_configuration_receipt(self, value, phase):
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
            observed = self.observe_api_configuration(phase)
            demand(observed.get("runtimeVerified") is True
                   and observed.get("configurationSha256") == self.configurations.hashes[phase],
                   "ROTATION_API_RECONCILIATION_UNRESOLVED")
            return self._result(intent, True)
        attempt = self.output / f"frontend-{phase}"
        migrate.private_directory(attempt)
        staged = vercel._staged_identity(self.selected, attempt)
        promotion = (migrate.read_json(attempt, "frontend-promotion-outcome.json")
                     if (attempt / "frontend-promotion-outcome.json").exists() else None)
        if not (isinstance(promotion, dict) and promotion.get("status") == "FRONTEND_DOMAINS_PROMOTED"
                and promotion.get("frontendDomainsPromoted") is True):
            try:
                promotion = vercel.observe_frontend_promotion(self.client, self.selected, attempt)
            except BaseException:
                raise ValueError("ROTATION_FRONTEND_RECONCILIATION_UNRESOLVED") from None
        workload = migrate.read_json(attempt, "frontend-workload-outcome.json")
        signer = migrate.read_json(attempt, "rotation-frontend-signer.json")
        configured = migrate.read_json(attempt, "rotation-frontend-configuration.json")
        provider = self.observe_frontend_configuration(phase)
        demand(promotion.get("status") == "FRONTEND_DOMAINS_PROMOTED" and promotion.get("frontendDomainsPromoted") is True
               and promotion.get("deploymentId") == staged["deploymentId"] == provider.get("deploymentId")
               and workload.get("status") == "FRONTEND_VERIFIED" and workload.get("deploymentId") == staged["deploymentId"]
               and self._validate_frontend_signer(signer, phase, staged["deploymentId"]),
               "ROTATION_FRONTEND_RECONCILIATION_UNRESOLVED")
        self._validate_frontend_configuration_receipt(configured, phase)
        return self._result(intent, True)


SOURCE_PARENT_DISPATCH_INTEGRATED = False
