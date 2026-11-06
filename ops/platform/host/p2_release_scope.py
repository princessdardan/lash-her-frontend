"""Process-local, actual flock scope for the fixed P2 host broker.

This object cannot be supplied through the migration CLI or decoded from JSON.
The broker retains the descriptor and a live frontend PostgreSQL observer.
"""
import copy
import fcntl
import hashlib
import json
import os
import stat
import subprocess
import threading


class P2ReleaseScope:
    def __init__(self, descriptor, path, verify_frontend, receipt, candidate_sha256=None, *, release=None, jobs=None, configuration_sha256=None):
        self.descriptor, self.path = descriptor, path
        self.identity = os.fstat(descriptor)
        self.verify_frontend = verify_frontend
        self.receipt = copy.deepcopy(receipt)
        self.candidate_sha256 = candidate_sha256
        self.release, self.jobs = copy.deepcopy(release), copy.deepcopy(jobs)
        self.configuration_sha256 = copy.deepcopy(configuration_sha256)
        self.closed = False
        self.revoked = threading.Event()
        self.processes, self.mutations = set(), threading.Lock()
        self.verify()

    def verify(self):
        if self.closed or self.revoked.is_set():
            raise ValueError("P2_RELEASE_SCOPE_CLOSED")
        current, opened = os.lstat(self.path), os.fstat(self.descriptor)
        if not (stat.S_ISREG(current.st_mode) and not stat.S_ISLNK(current.st_mode)
                and current.st_uid == os.getuid() and not current.st_mode & 0o077
                and current.st_dev == opened.st_dev == self.identity.st_dev
                and current.st_ino == opened.st_ino == self.identity.st_ino):
            raise ValueError("P2_ENVIRONMENT_LOCK_IDENTITY_CHANGED")
        # The broker acquired this actual descriptor before constructing us.
        # Rechecking the same open file description never acquires a second lock.
        fcntl.flock(self.descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.verify_frontend()

    def revoke(self):
        self.revoked.set()
        with self.mutations:
            running = list(self.processes)
        for process in running:
            try:
                if process.poll() is None:
                    process.kill()
            except BaseException:
                self.cleanup_uncertain = True
        for process in running:
            try:
                process.wait(timeout=15)
            except BaseException:
                self.cleanup_uncertain = True

    def run(self, args, *, timeout, check=False, capture_output=False, text=False, input=None, **options):
        # Revocation and Popen registration share one mutex. Once revoked, no
        # worker can issue another startup/apply command, including after an
        # already-running Compose command unwinds.
        with self.mutations:
            self.verify()
            if capture_output:
                options.update(stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if input is not None:
                if 'stdin' in options:
                    raise ValueError('P2_CHILD_STDIN_CONFLICT')
                options['stdin'] = subprocess.PIPE
            process = subprocess.Popen(args, text=text, **options)
            self.processes.add(process)
        try:
            try:
                stdout, stderr = process.communicate(input=input, timeout=timeout)
            except BaseException:
                process.kill(); process.wait(timeout=15); raise
            result = subprocess.CompletedProcess(args, process.returncode, stdout, stderr)
            if check:
                result.check_returncode()
            self.verify()
            return result
        finally:
            with self.mutations:
                if process.poll() is None:
                    self.cleanup_uncertain = True
                else:
                    self.processes.discard(process)

    def require_release(self, release, jobs):
        self.verify()
        if self.release is not None and (release != self.release or jobs != self.jobs):
            raise ValueError('P2_REVIEWED_RELEASE_INPUTS_CHANGED')

    def require_configuration(self, directory):
        self.verify()
        if self.configuration_sha256 is not None:
            import staging_state
            if staging_state.configuration_hashes(directory) != self.configuration_sha256:
                raise ValueError('P2_REVIEWED_CONFIGURATION_CHANGED')

    def require_frontend(self, release, info):
        self.verify()
        job, receipt = info["job"], self.receipt
        keys = ("environment", "releaseId", "sourceCommit", "migrationImageDigest", "sqlArtifactSha256",
                "contractManifestSha256", "schemaBaselineSha256", "contractPhase", "phase2ContractManifestSha256")
        target = {key: job["target"][key] for key in ("host", "port", "database", "user", "serverMajor")}
        expected = job["target"]["approvedPendingTags"]
        if not (release.get("environment") == "staging" and release.get("contractPhase") == "p2"
                and all(receipt.get(key) == job.get(key) and receipt.get(key) is not None for key in keys)
                and receipt.get("status") == "DATABASE_VERIFIED" and receipt.get("service") == "frontend"
                and receipt.get("schemaVerified") is True and receipt.get("runtimeRoleVerified") is True
                and receipt.get("trafficAuthorized") is False and receipt.get("migrationMode") == "apply-forward"
                and receipt.get("target") == target and receipt.get("failureCode") is None
                and isinstance(receipt.get("after"), list) and receipt["after"]
                and [entry.get("tag") for entry in receipt.get("applied", [])] == expected):
            raise ValueError("P2_LIVE_FRONTEND_RECEIPT_BINDING_REFUSED")
        return copy.deepcopy(receipt)

    def initialize_runtime(self, snapshot, release):
        """The new gateway starts closed; no previous admission file is reused."""
        import staging_admission
        self.verify()
        gateway = json.loads((snapshot / "gateway.json").read_bytes())
        if gateway.get("admission") != {"file": "/admission/state.json", "releaseId": release["releaseId"],
                                       "candidateSha256": self.candidate_sha256}:
            raise ValueError("P2_GATEWAY_ADMISSION_BINDING_REQUIRED")
        staging_admission.persist_state(snapshot, {"releaseId": release["releaseId"],
                                                  "candidateSha256": self.candidate_sha256},
                                        "p2-release-held-" + release["releaseId"], new_work=False, recovery=False)

    @staticmethod
    def receipt_bytes(receipt):
        return (json.dumps(receipt, separators=(",", ":")) + "\n").encode()

    @staticmethod
    def sha256(value):
        return hashlib.sha256(value).hexdigest()
