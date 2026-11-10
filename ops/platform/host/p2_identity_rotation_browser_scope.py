"""Source-only, host-bound P2 identity rotation browser admission."""
import copy
import hashlib
import hmac
import re
import secrets
import time

import migrate
from p2_identity_key_rotation_adapter import P2IdentityRotationScope
from p2_interactive_window import _material

ORIGIN = "https://staging.lashher.com"
AUTH_STAGE = "identity"
SIGNER_STAGE = "rotation-admin"
AUTH_DURATION = 300
SIGNER_DURATION = 60
AUTH_COUNTS = {"new-work": 5, "recovery": 2}
EVIDENCE_PHASES = ("overlap", "current-only", "post-removal")
PURPOSES = {"authentication": AUTH_DURATION, "signer-read": SIGNER_DURATION}
WINDOW_ORDER = tuple((phase, kind) for phase in EVIDENCE_PHASES for kind in PURPOSES)
CUSTOMER_SELECTOR_PREFIX = b"p2q-rot-cust-v1\0".hex()
ADMIN_SELECTOR_PREFIX = b"p2q-rot-admn-v1\0".hex()
UUID = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}")
EPOCH = re.compile(r"[1-9][0-9]{0,17}")
SHA = re.compile(r"[a-f0-9]{64}")
SOURCE = re.compile(r"[a-f0-9]{40}")
DEPLOYMENT = re.compile(r"https://([a-z0-9][a-z0-9-]*\.vercel\.app)")
WINDOW_FIELDS = {"version", "actionId", "bindingSha256", "phase", "kind", "maximumSeconds", "source",
                 "deploymentId", "configurationSha256", "sourceCommit", "candidateSha256", "browserOrigin",
                 "canonicalAliasReadbackSha256", "canonicalProtectedWorkloadSha256"}
OPERATION_FIELDS = {"id", "epoch", "kind", "state", "producer_sha256", "source_sha", "role_oid",
                    "completed_at", "reconciliation_sha256"}
RETAINED_WINDOW_FIELDS = ("actionId", "bindingSha256", "phase", "kind", "deploymentId", "configurationSha256",
                          "sourceCommit", "candidateSha256", "canonicalAliasReadbackSha256", "canonicalProtectedWorkloadSha256")
require = migrate.demand


def _matches(pattern, value):
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def _sha(value):
    return hashlib.sha256(value.encode()).hexdigest()


def _retained_window(window):
    return {**{key: window[key] for key in RETAINED_WINDOW_FIELDS},
            "challengeSha256": _sha(window["source"]["challenge"])}


def _admission(epoch, opened=False):
    return {"epoch": epoch, "newWork": opened, "recovery": opened, "active": 0, "uncertain": 0}


def _exact_admission(observed, expected):
    return (type(observed) is dict and observed == expected and
            all(type(observed[key]) is bool for key in ("newWork", "recovery")) and
            all(type(observed[key]) is int for key in ("active", "uncertain")))


def _signer_cookie(key, deployment_host, source, target, epoch, issued, duration, nonce, selector):
    body = f"v2.{epoch}.{SIGNER_STAGE}.{issued}.{issued + duration}.{nonce}.{selector}"
    message = f"lash-her:p2q:interactive:browser:v1\n{deployment_host}\n{source}\n{target}\n{body}"
    return f"{body}.{hmac.digest(key.encode(), message.encode(), 'sha256').hex()}"


class P2IdentityRotationBrowserScope:
    """Issue one exact private scope per ordered, source-owned browser window."""

    def __init__(self, broker, scoped_cron_secret):
        from p2_identity_key_rotation_parent import P2IdentityRotationBroker

        require(type(broker) is P2IdentityRotationBroker and type(broker.scope) is P2IdentityRotationScope and
                broker.scope.release == broker.selected and broker.scope.jobs == broker.jobs and
                callable(broker.observe_rotation_browser_writer_scope) and
                _matches(re.compile(r"[!-~]{32,8192}"), scoped_cron_secret),
                "P2_ROTATION_BROWSER_WRITER_PARENT_REQUIRED")
        plan, scope = broker.initial["rotationPlan"], broker.scope
        target, native = broker.initial["targetSha256"], broker.initial["nativePlan"]
        require(_matches(SHA, target) and _matches(SOURCE, scope.source_commit) and
                scope.action_id == plan["actionId"] == broker.action_id() and scope.binding_sha256 == plan["bindingSha256"] and
                scope.candidate_sha256 == plan["candidateSha256"] and scope.source_commit == plan["sourceCommit"] and
                scope.browser_program_sha256 == broker.browser_program_sha256 and
                all(_matches(UUID, plan["subjects"].get(profile)) for profile in ("course-learner", "course-admin")) and
                _matches(UUID, plan["courseId"]), "P2_ROTATION_BROWSER_WRITER_BINDING_REQUIRED")
        self.broker, self.scope, self.target, self._key = broker, scope, target, scoped_cron_secret
        self.customer_id, self.admin_id = (plan["subjects"][profile] for profile in ("course-learner", "course-admin"))
        self.course_id = plan["courseId"]
        if scope.receipt.get("version") == 2:
            probe = broker.armed_probe
            admission = scope.receipt.get("admission")
            require(type(probe) is dict and probe.get("receipt") == scope.receipt and type(admission) is dict
                    and _matches(EPOCH, admission.get("epoch")) and admission == _admission(admission["epoch"]),
                    "P2_ROTATION_BROWSER_WRITER_REPLACEMENT_PROBE_REQUIRED")
            self.original = copy.deepcopy(probe["producers"])
            self.closed_epoch = admission["epoch"]
        else:
            self.original = copy.deepcopy(scope.receipt["producers"])
            self.closed_epoch = scope.receipt["admissionEpoch"]
        runtime = copy.deepcopy(native["producer"])
        require(isinstance(self.original, list) and 1 <= len(self.original) <= 256 and runtime in self.original and
                all(self._valid_producer(item) for item in self.original) and
                len({item["producerSha256"] for item in self.original}) == len(self.original),
                "P2_ROTATION_BROWSER_WRITER_PRODUCERS_REQUIRED")
        self.interactive = {"producerSha256": _sha(f"lash-her:p2q:interactive-producer:v1\n{scope.source_commit}\n{target}"),
                            "role": runtime["role"]}
        require(self.interactive["producerSha256"] not in {item["producerSha256"] for item in self.original},
                "P2_ROTATION_BROWSER_WRITER_PRODUCERS_REQUIRED")
        migrate.private_directory(broker.directory)
        require(_matches(EPOCH, self.closed_epoch), "P2_ROTATION_BROWSER_WRITER_EPOCH_REQUIRED")
        self.completed = []
        self._active = None

    @staticmethod
    def _valid_producer(value):
        if type(value) is not dict or set(value) != {"producerSha256", "role"} or not _matches(SHA, value["producerSha256"]):
            return False
        role = value["role"]
        return (type(role) is dict and set(role) == {"name", "oid"} and
                _matches(re.compile(r"[a-z][a-z0-9_]{0,62}"), role["name"]) and
                _matches(re.compile(r"[1-9][0-9]{0,9}"), role["oid"]) and int(role["oid"]) <= 4_294_967_295)

    def _check(self):
        self.broker.check()
        self.scope.verify()

    def _observe(self, admission, operation_epoch, producers):
        self._check()
        observed = self.broker.observe_rotation_browser_writer_scope(operation_epoch)
        physical = self.broker.observer.probe("observe").get("admission")
        require(type(observed) is dict and set(observed) == {"admission", "producers", "operations"} and
                _exact_admission(physical, admission) and _exact_admission(observed["admission"], admission) and
                isinstance(observed["producers"], list) and all(self._valid_producer(item) for item in observed["producers"]) and
                sorted(observed["producers"], key=lambda item: item["producerSha256"]) ==
                sorted(producers, key=lambda item: item["producerSha256"]) and isinstance(observed["operations"], list),
                "P2_ROTATION_BROWSER_WRITER_READBACK_REFUSED")
        self._check()
        return observed["operations"]

    def _window(self, window):
        plan = self.broker.initial["rotationPlan"]
        require(type(window) is dict and set(window) == WINDOW_FIELDS and type(window["version"]) is int and window["version"] == 1 and
                isinstance(window["kind"], str) and window["kind"] in PURPOSES and
                window["maximumSeconds"] == PURPOSES[window["kind"]] and window["phase"] in EVIDENCE_PHASES and
                window["actionId"] == self.scope.action_id and window["bindingSha256"] == self.scope.binding_sha256 and
                window["sourceCommit"] == self.scope.source_commit and window["candidateSha256"] == self.scope.candidate_sha256 and
                window["browserOrigin"] == ORIGIN and
                all(_matches(SHA, window[key]) for key in ("canonicalAliasReadbackSha256", "canonicalProtectedWorkloadSha256")) and
                type(window["source"]) is dict and set(window["source"]) == {"challenge", "bindingSha256", "browserProgramSha256"} and
                _matches(SHA, window["source"]["challenge"]) and window["source"]["challenge"] != "0" * 64 and
                window["source"]["bindingSha256"] == self.scope.binding_sha256 and
                window["source"]["browserProgramSha256"] == self.scope.browser_program_sha256,
                "P2_ROTATION_BROWSER_WRITER_WINDOW_REFUSED")
        phase = "current-only" if window["phase"] == "post-removal" else window["phase"]
        require(window["configurationSha256"] == plan["configuration"][phase]["sha256"],
                "P2_ROTATION_BROWSER_WRITER_CONFIGURATION_REFUSED")
        return phase

    def prepare(self, window):
        """Before an admission change, pin the next exact window and its epochs."""
        self._check()
        phase = self._window(window)
        require(self._active is None and len(self.completed) < len(WINDOW_ORDER) and
                WINDOW_ORDER[len(self.completed)] == (window["phase"], window["kind"]),
                "P2_ROTATION_BROWSER_WRITER_WINDOW_ORDER_REFUSED")
        challenge_sha = _sha(window["source"]["challenge"])
        if window["kind"] == "authentication":
            require(all(row["challengeSha256"] != challenge_sha for row in self.completed),
                    "P2_ROTATION_BROWSER_WRITER_CHALLENGE_REPLAY")
            epoch, closed_epoch = (str(int(self.closed_epoch) + offset) for offset in (1, 2))
        else:
            previous = self.completed[-1]
            require(previous["challengeSha256"] == challenge_sha and all(previous[key] == window[key] for key in
                    ("deploymentId", "configurationSha256", "canonicalAliasReadbackSha256", "canonicalProtectedWorkloadSha256")),
                    "P2_ROTATION_BROWSER_WRITER_CHALLENGE_CHANGED")
            epoch = closed_epoch = self.closed_epoch
        require(_matches(EPOCH, epoch) and _matches(EPOCH, closed_epoch),
                "P2_ROTATION_BROWSER_WRITER_EPOCH_REQUIRED")
        deployment = self.broker.adapter.frontend_deployment(phase)
        url = deployment.get("deploymentUrl")
        require(_matches(DEPLOYMENT, url) and _matches(re.compile(r"dpl_[A-Za-z0-9]+"), window["deploymentId"]) and
                all(window[key] == deployment.get(key) for key in ("deploymentId", "configurationSha256", "sourceCommit")),
                "P2_ROTATION_BROWSER_WRITER_DEPLOYMENT_REFUSED")
        require(self._observe(_admission(self.closed_epoch), epoch, self.original) == [],
                "P2_ROTATION_BROWSER_WRITER_PREEXISTING_OPERATIONS")
        epochs = {"beforeEpoch": self.closed_epoch, "permitEpoch": epoch, "closedEpoch": closed_epoch}
        migrate.write_json(self.broker.directory, f"browser-{window['phase']}-{window['kind']}-writer-intent.json", {
            "version": 1, "status": "P2_ROTATION_BROWSER_WRITER_SCOPE_PREPARED", **_retained_window(window), **epochs})
        self._active = {"window": copy.deepcopy(window), "deploymentUrl": url, "epoch": epoch, "closedEpoch": closed_epoch,
                        "deadline": time.monotonic() + window["maximumSeconds"], "issued": False, "closeAttempted": False}
        return epochs

    def _take(self, window, kind):
        self._check()
        active = self._active
        require(active is not None and active["window"] == window and window["kind"] == kind and not active["issued"],
                "P2_ROTATION_BROWSER_WRITER_PERMIT_REFUSED")
        auth = kind == "authentication"
        require(self._observe(_admission(active["epoch"], auth), active["epoch"], [self.interactive] if auth else self.original) == [],
                "P2_ROTATION_BROWSER_WRITER_PREEXISTING_OPERATIONS")
        now, remaining = int(time.time()), int(active["deadline"] - time.monotonic())
        require(1_000_000_000 <= now < 9_999_999_700 and 30 <= remaining <= window["maximumSeconds"],
                "P2_ROTATION_BROWSER_WRITER_PERMIT_EXPIRED")
        active["issued"] = True
        return active, now, remaining

    def take_private_authentication_permits(self, window):
        active, now, remaining = self._take(window, "authentication")
        cookies = {}
        for actor, prefix, actor_id in (("customer", CUSTOMER_SELECTOR_PREFIX, self.customer_id),
                                         ("admin", ADMIN_SELECTOR_PREFIX, self.admin_id)):
            cookie, _, _, expires = _material(self._key, active["deploymentUrl"], self.scope.source_commit,
                self.target, active["epoch"], AUTH_STAGE, now, remaining, secrets.token_hex(16), prefix + actor_id.replace("-", ""))
            cookies[f"{actor}Cookie"] = cookie
        return {"stage": AUTH_STAGE, "epoch": active["epoch"], "expires": expires, **cookies}

    def take_private_signer_permit(self, window):
        active, now, remaining = self._take(window, "signer-read")
        cookie = _signer_cookie(self._key, DEPLOYMENT.fullmatch(active["deploymentUrl"]).group(1),
            self.scope.source_commit, self.target, active["epoch"], now, remaining, secrets.token_hex(16),
            (self.admin_id + self.course_id).replace("-", ""))
        return {"stage": SIGNER_STAGE, "epoch": active["epoch"], "expires": now + remaining, "adminCookie": cookie}

    def retain_closed(self, window):
        """After fencing, independently join exact zero-state and ledger evidence."""
        self._check()
        active = self._active
        require(active is not None and active["window"] == window and active["issued"] and not active["closeAttempted"],
                "P2_ROTATION_BROWSER_WRITER_CLOSE_REFUSED")
        active["closeAttempted"] = True
        operations = self._observe(_admission(active["closedEpoch"]), active["epoch"], self.original)
        counts = dict.fromkeys(AUTH_COUNTS, 0)
        ids = set()
        for row in operations:
            require(type(row) is dict and set(row) == OPERATION_FIELDS and _matches(UUID, row["id"]) and row["id"] not in ids and
                    row["epoch"] == active["epoch"] and isinstance(row["kind"], str) and row["kind"] in counts and
                    row["state"] == "completed" and row["producer_sha256"] == self.interactive["producerSha256"] and
                    row["source_sha"] == self.scope.source_commit and row["role_oid"] == self.interactive["role"]["oid"] and
                    isinstance(row["completed_at"], str) and row["reconciliation_sha256"] is None,
                    "P2_ROTATION_BROWSER_WRITER_OPERATION_REFUSED")
            ids.add(row["id"])
            counts[row["kind"]] += 1
        require(counts == (AUTH_COUNTS if window["kind"] == "authentication" else dict.fromkeys(AUTH_COUNTS, 0)),
                "P2_ROTATION_BROWSER_WRITER_OPERATION_COUNTS_REFUSED")
        record = {"version": 1, "status": "P2_ROTATION_BROWSER_WRITER_SCOPE_CLOSED",
                  **_retained_window(window), "permitEpoch": active["epoch"],
                  "closedEpoch": active["closedEpoch"], "operationCounts": counts,
                  "newWork": False, "recovery": False, "active": 0, "uncertain": 0}
        migrate.write_json(self.broker.directory, f"browser-{window['phase']}-{window['kind']}-writer-scope.json", record)
        self.completed.append(copy.deepcopy(record))
        self.closed_epoch = active["closedEpoch"]
        self._active = None
        return record
