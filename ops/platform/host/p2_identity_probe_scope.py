"""Fresh, no-SQL scope for the fixed read-only identity observer only."""
import copy
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import threading
import time

import docker_inspect
import migrate
import release as runtime

LOCK = Path("/run/lock/lash-her-release.lock")
MAX_SCOPE_SECONDS = 600
IDENTITY_FIELDS = '{{.Config.Image}}|{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}'
SECURITY_FIELDS = '{{.HostConfig.ReadonlyRootfs}}|{{json .Mounts}}'
demand = migrate.demand


class CurrentIdentityProbeScope:
    """Owns one actual host flock and bounded read-only subprocesses.

    No migration, SQL, restart, admission, arbitrary command or signing method.
    The original release references are provenance, not a new frontend proof.
    """
    def __init__(self, selected, reviewed, configuration, program, verify_inputs):
        demand(sys.platform == "linux" and os.geteuid() == 0, "P2_IDENTITY_SELECTED_LINUX_ROOT_REQUIRED")
        self.path, self.selected, self.reviewed = LOCK, selected, reviewed
        self.configuration, self.program = Path(configuration), program
        self.verify_inputs = verify_inputs
        self.mutex, self.processes = threading.RLock(), set()
        self.closed, self.revoked, self.cleanup_uncertain = False, False, False
        self.deadline = time.monotonic() + MAX_SCOPE_SECONDS
        self.ids = {row["containerId"] for row in reviewed["containers"]}
        self.descriptor = os.open(self.path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            self.identity = os.fstat(self.descriptor)
            demand(stat.S_ISREG(self.identity.st_mode) and self.identity.st_uid == os.getuid() and
                not self.identity.st_mode & 0o077, "P2_IDENTITY_PRIVATE_HOST_LOCK_REQUIRED")
            fcntl.flock(self.descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.verify()
        except BaseException:
            os.close(self.descriptor)
            self.closed = True
            raise

    def verify(self):
        demand(not self.closed and not self.revoked, "P2_IDENTITY_READONLY_SCOPE_CLOSED")
        demand(time.monotonic() < self.deadline, "P2_IDENTITY_READONLY_EXECUTION_TIMEOUT")
        current, opened = os.lstat(self.path), os.fstat(self.descriptor)
        demand(stat.S_ISREG(current.st_mode) and not stat.S_ISLNK(current.st_mode) and
            current.st_uid == os.getuid() and not current.st_mode & 0o077 and
            current.st_dev == opened.st_dev == self.identity.st_dev and
            current.st_ino == opened.st_ino == self.identity.st_ino, "P2_IDENTITY_HOST_LOCK_CHANGED")
        fcntl.flock(self.descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.verify_inputs()

    def _allowed(self, args, private_input, environment):
        demand(isinstance(args, list) and all(isinstance(item, str) for item in args), "P2_IDENTITY_READONLY_COMMAND_REQUIRED")
        if private_input is None:
            exact_env = environment in (runtime.SAFE_ENV, self._runtime_environment())
            compose = runtime.compose_command(self.configuration, "staging")
            allowed = any(args == [*compose, "ps", "--all", "--quiet", service] for service in runtime.SERVICES)
            allowed |= any(args == ["docker", "image", "inspect", "--platform", "linux/amd64", "--format", "{{.Id}}", image]
                for image in {item["image"] for item in self.selected["artifacts"].values() if isinstance(item, dict) and "image" in item})
            allowed |= any(args == ["docker", "inspect", "--format", fields, identifier]
                for identifier in self.ids for fields in (IDENTITY_FIELDS, SECURITY_FIELDS, docker_inspect.RUNTIME_FIELDS))
            demand(exact_env and allowed, "P2_IDENTITY_READONLY_COMMAND_REQUIRED")
            return
        demand(isinstance(private_input, bytes) and 0 < len(private_input) <= 262_144 and environment == runtime.SAFE_ENV,
            "P2_IDENTITY_PRIVATE_STDIN_REQUIRED")
        payload = json.loads(private_input)
        mode = payload.get("mode")
        service = "gateway" if mode in ("course-http-plan", "course-http") else {"course-verifier": "course-api", "community-verifier": "community-api"}.get(mode)
        demand(service is not None, "P2_IDENTITY_FIXED_CHILD_REQUIRED")
        identifier = next(row["containerId"] for row in self.reviewed["containers"] if row["service"] == service)
        fixed = ["docker", "exec", "-i", "--workdir", "/app", "--env", "NODE_OPTIONS=--max-old-space-size=96", "--env", "DOTENV_CONFIG_QUIET=true",
            identifier, "node", "--input-type=module", "--eval", self.program.decode()]
        demand(args == fixed and payload.get("environment") == "staging", "P2_IDENTITY_FIXED_CHILD_REQUIRED")

    def _runtime_environment(self):
        return runtime.runtime_environment(self.selected, self.configuration)

    def run(self, args, *, timeout, input=None, env=None, capture_output=True, check=False, text=False):
        demand(capture_output is True and check is False and text is False and isinstance(timeout, (int, float)) and 0 < timeout <= 30,
            "P2_IDENTITY_BOUNDED_PRIVATE_CHILD_REQUIRED")
        with self.mutex:
            self.verify()
            self._allowed(args, input, env)
            process = subprocess.Popen(args, env=env, stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
            self.processes.add(process)
        try:
            stdout, stderr = process.communicate(input=input, timeout=timeout)
            self.verify()
            demand(len(stdout) <= 65_536 and len(stderr) <= 8192, "P2_IDENTITY_CHILD_OUTPUT_BOUND")
            return subprocess.CompletedProcess(args, process.returncode, stdout, stderr)
        finally:
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=3)
                except BaseException:
                    self.cleanup_uncertain = True
            with self.mutex:
                if process.poll() is None:
                    self.cleanup_uncertain = True
                else:
                    self.processes.discard(process)

    def inventory(self, selected, configuration):
        demand(selected == self.selected and Path(configuration) == self.configuration, "P2_IDENTITY_SCOPE_INPUT_CHANGED")
        env, prefix = self._runtime_environment(), runtime.compose_command(configuration, "staging")
        metadata = []
        def read(args, environment):
            value = self.run(args, env=environment, capture_output=True, timeout=15)
            demand(value.returncode == 0 and not value.stderr, "P2_IDENTITY_RUNTIME_READ_REFUSED")
            return value.stdout.decode().strip()
        for service in runtime.SERVICES:
            ids = read([*prefix, "ps", "--all", "--quiet", service], env).split()
            demand(len(ids) == 1 and re.fullmatch(r"[a-f0-9]{64}", ids[0]), "P2_IDENTITY_EXACT_RUNTIME_REPLICA_REQUIRED")
            self.ids.add(ids[0])
            image = selected["artifacts"][runtime.IMAGE_KEYS[service]]["image"]
            local = read(["docker", "image", "inspect", "--platform", "linux/amd64", "--format", "{{.Id}}", image], runtime.SAFE_ENV)
            actual = read(["docker", "inspect", "--format", docker_inspect.RUNTIME_FIELDS, ids[0]], runtime.SAFE_ENV).split("|")
            health = "none" if service.endswith("-tls") else "healthy"
            demand(len(actual) == 5 and actual[0] in (local, image.split("@")[1]) and actual[1:] == ["true", health, "lash-her-staging", service],
                "P2_IDENTITY_RUNTIME_IDENTITY_REFUSED")
            metadata.append({"service": service, "containerId": ids[0], "image": image, "health": health})
        return metadata

    def revoke(self):
        with self.mutex:
            self.revoked = True
            children = list(self.processes)
        for process in children:
            try:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=3)
            except BaseException:
                self.cleanup_uncertain = True

    def close(self):
        if self.closed:
            return
        self.revoke()
        if self.cleanup_uncertain or any(process.poll() is None for process in self.processes):
            raise ValueError("P2_IDENTITY_CHILD_CLEANUP_UNCERTAIN")
        os.close(self.descriptor)
        self.closed = True


COMPOSE_MOUNT_FIELDS = '{{index .Config.Labels "com.docker.compose.project.working_dir"}}|{{index .Config.Labels "com.docker.compose.project.config_files"}}'
PROJECT_INVENTORY = ["docker", "container", "ls", "--all", "--no-trunc", "--filter",
                     "label=com.docker.compose.project=lash-her-staging", "--format", "{{.ID}}"]


def _replacement_profile():
    from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE
    return migrate.profile_context(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)


class ReplacementIdentityProbeScope(CurrentIdentityProbeScope):
    """The fixed v2 reader holds the canonical flock over exact replacement runtime I/O."""

    def __init__(self, selected, jobs, reviewed, configuration, source, program, verify_inputs):
        self.expected_profile = _replacement_profile()
        migrate.candidate_profile(selected, self.expected_profile)
        migrate.require_profile(self.expected_profile, reviewed)
        demand(type(reviewed.get("version")) is int and reviewed["version"] == 2 and
            selected["environment"] == "staging" and set(jobs) == {"frontend", "course", "community"} and
            migrate.file_hash(program) == reviewed["programSha256"], "P2_IDENTITY_REPLACEMENT_SCOPE_REQUIRED")
        for service, info in jobs.items():
            migrate.require_job_profile(self.expected_profile, info["job"], frontend=service == "frontend")
        self.source = Path(source)
        self._runtime_bound = False
        self.candidate_sha256 = reviewed["candidateSha256"]
        super().__init__(copy.deepcopy(selected), copy.deepcopy(reviewed), configuration, program, verify_inputs)

    def _runtime_environment(self):
        return runtime.runtime_environment(self.selected, self.configuration, expected_profile=self.expected_profile)

    def required_mounts(self, service):
        demand(service in ("gateway", "course-api", "community-api"), "P2_IDENTITY_REPLACEMENT_SCOPE_REQUIRED")
        mounts = {"gateway": {"/config/gateway.json": "gateway.json", "/admission": "admission", "/tls": "tls/gateway"},
                  "community-api": {"/tls/ca.pem": "tls/ca.pem"}, "course-api": {}}
        return {mount: self.configuration / relative for mount, relative in mounts[service].items()}

    def _gateway_command(self):
        from p2_certification_fault import GATEWAY_OBSERVER
        gateway = next(row["containerId"] for row in self.reviewed["containers"] if row["service"] == "gateway")
        return ["docker", "exec", "--workdir", "/app", gateway, "node", "--input-type=module", "--eval", GATEWAY_OBSERVER]

    def _allowed(self, args, private_input, environment):
        if private_input is None and environment == runtime.SAFE_ENV:
            if args in (PROJECT_INVENTORY, self._gateway_command()) or any(
                args == ["docker", "inspect", "--format", COMPOSE_MOUNT_FIELDS, identifier] for identifier in self.ids):
                return
        demand(private_input is None or self._runtime_bound, "P2_IDENTITY_REPLACEMENT_RUNTIME_NOT_BOUND")
        super()._allowed(args, private_input, environment)

    def run(self, args, *, timeout, input=None, env=None, capture_output=True, check=False, text=False):
        demand(type(timeout) in (int, float) and 0 < timeout <= 30, "P2_IDENTITY_BOUNDED_PRIVATE_CHILD_REQUIRED")
        remaining = self.deadline - time.monotonic()
        demand(remaining > 0, "P2_IDENTITY_READONLY_EXECUTION_TIMEOUT")
        return super().run(args, timeout=min(timeout, remaining), input=input, env=env,
                           capture_output=capture_output, check=check, text=text)

    def _read_runtime(self, args):
        result = self.run(args, env=runtime.SAFE_ENV, timeout=15)
        demand(result.returncode == 0 and not result.stderr, "P2_IDENTITY_REPLACEMENT_RUNTIME_READ_REFUSED")
        return result.stdout

    def _verify_gateway(self):
        from p2_certification_fault import MODULE
        admission_file = "admission/state.json"
        state_raw = migrate.read_input(self.configuration, admission_file, 4096)
        observed = json.loads(self._read_runtime(self._gateway_command()))
        admission = observed.get("admission")
        mounted = (self.configuration / "admission").lstat()
        demand(type(observed.get("version")) is int and observed["version"] == 1 and
            observed.get("status") == "P2_FAULT_GATEWAY_CURRENT" and observed.get("processSha256") == self.reviewed["gatewayProcessSha256"] and
            observed.get("gatewayConfigurationSha256") == migrate.file_hash(migrate.read_input(self.configuration, "gateway.json", 65_536)) and
            observed.get("faultModuleSha256") == migrate.file_hash(migrate.read_input(self.source, MODULE, 65_536)) and
            observed.get("faultLeasePresent") is False and stat.S_ISDIR(mounted.st_mode) and
            observed.get("admissionDirectory") == {"device": str(mounted.st_dev), "inode": str(mounted.st_ino)} and
            type(admission) is dict and type(admission.get("version")) is int and admission["version"] == 1 and
            admission.get("sha256") == migrate.file_hash(state_raw) and
            migrate.read_input(self.configuration, admission_file, 4096) == state_raw and
            admission.get("valid") is True and admission.get("environment") == "staging" and
            admission.get("releaseId") == self.selected["releaseId"] and admission.get("candidateSha256") == self.candidate_sha256 and
            admission.get("newWork") is False and admission.get("recovery") is False and
            all(type(admission.get(key)) is dict and set(admission[key]) == {"newWork", "recovery"} and
                all(type(value) is int and value == 0 for value in admission[key].values()) for key in ("active", "uncertain")),
            "P2_IDENTITY_REPLACEMENT_GATEWAY_NOT_CLOSED_ZERO")

    def _verify_runtime(self):
        from p2_identity_negative_probe import _canonical, _one_container
        rows = self.inventory(self.selected, self.configuration)
        ids = {row["containerId"] for row in rows}
        project = self._read_runtime(PROJECT_INVENTORY).decode().split()
        reviewed_services = {row["service"]: row for row in self.reviewed["containers"]}
        observed_services = {row["service"]: {key: row[key] for key in ("service", "containerId", "image")}
                             for row in rows if row["service"] in reviewed_services}
        demand(observed_services == reviewed_services and len(ids) == len(runtime.SERVICES) == len(project) and set(project) == ids and
            migrate.file_hash(_canonical(rows)) == self.reviewed["runtimeInventorySha256"], "P2_IDENTITY_REPLACEMENT_RUNTIME_INVENTORY_CHANGED")
        mount = (str(self.configuration) + "|" + str(self.configuration / "compose.yaml")).encode()
        for row in rows:
            actual = self._read_runtime(["docker", "inspect", "--format", COMPOSE_MOUNT_FIELDS, row["containerId"]])
            demand(actual.strip() == mount, "P2_IDENTITY_REPLACEMENT_RUNTIME_MOUNT_CHANGED")
        for row in reviewed_services.values():
            _one_container(row, self.configuration, self)
        self._verify_gateway()
        self.verify()

    def bind_runtime(self):
        demand(not self._runtime_bound, "P2_IDENTITY_REPLACEMENT_RUNTIME_ALREADY_BOUND")
        self._verify_runtime()
        self._runtime_bound = True

    def verify_runtime(self):
        demand(self._runtime_bound, "P2_IDENTITY_REPLACEMENT_RUNTIME_NOT_BOUND")
        self._verify_runtime()
