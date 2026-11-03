"""Private subprocess bridge for the reviewed rollback/recreation parent.

Only existing pinned containers execute these exact hashed programs. Application
tokens go over private stdin; database credentials never leave API containers.
"""
import base64
import hashlib
import hmac
import json
from pathlib import Path
import re
import subprocess
import time
from uuid import uuid4

import migrate
import release as runtime
import staging_retire
import staging_state

demand = migrate.demand
UUID = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}")


def safe_code(error):
    value = str(error)
    return value if isinstance(error, ValueError) and re.fullmatch(r"[A-Z_]{1,100}", value) else "STAGING_RUNTIME_ACTION_FAILED"


def business_preserved(before, after):
    demand(before.get("status") == after.get("status") == "STAGING_BUSINESS_FINGERPRINT_READ_ONLY"
           and before.get("service") == after.get("service") and before.get("algorithm") == after.get("algorithm")
           == "HMAC-SHA256/private-action-key" and set(before.get("tables", {})) == set(after.get("tables", {})),
           "STAGING_BUSINESS_SCOPE_MISMATCH")
    count = 0
    for table, original in before["tables"].items():
        current = after["tables"][table]
        demand(original.get("count") == len(original.get("rows", [])) and current.get("count") == len(current.get("rows", [])),
               "STAGING_BUSINESS_ROW_COUNT_MISMATCH")
        actual = {r.get("key"): r.get("value") for r in current["rows"]}
        demand(len(actual) == current["count"] and all(actual.get(r.get("key")) == r.get("value") for r in original["rows"]),
               "STAGING_PRIOR_BUSINESS_ROWS_CHANGED")
        count += original["count"]
    return {"status": "STAGING_PRIOR_BUSINESS_ROWS_PRESERVED", "service": before["service"], "preservedRows": count}


def recovered(retained, source, receiver):
    demand(retained.get("status") == "STAGING_DURABLE_WORK_RETAINED" and retained.get("environment") == "staging"
           and source.get("status") == receiver.get("status") == "STAGING_WORK_ROWS_READ_ONLY"
           and source.get("service") == "course" and receiver.get("service") == "community"
           and source.get("mode") == "outbox" and receiver.get("mode") == "inbox"
           and all(value.get("readOnly") is True and value.get("authenticatedTls") is True for value in (source, receiver)),
           "STAGING_RECOVERY_SCOPE_REQUIRED")
    events, outbox, inbox = retained.get("events", []), source.get("rows", []), receiver.get("rows", [])
    demand(len(events) == len(outbox) == len(inbox) == 2 and len({e["eventId"] for e in events}) == 2
           and {r["eventId"] for r in outbox} == {r["eventId"] for r in inbox} == {e["eventId"] for e in events},
           "STAGING_EXACT_RECOVERY_EVENTS_REQUIRED")
    def epoch(value):
        from datetime import datetime
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    for event in events:
        row = next(r for r in outbox if r["eventId"] == event["eventId"])
        received = next(r for r in inbox if r["eventId"] == event["eventId"])
        demand(row.get("canonicalDigest") == received.get("canonicalDigest") == event["canonicalDigest"]
               and row.get("state") == "delivered" and received.get("status") == "applied"
               and row.get("leaseOwner") is None and row.get("leaseExpiresAt") is None
               and isinstance(row.get("deliveredAt"), str) and epoch(row["deliveredAt"]) >= epoch(event["notBefore"])
               and type(row.get("attemptsInCycle")) is int and row["attemptsInCycle"] >= event["attemptsInCycle"],
               "STAGING_ACTUAL_PENDING_EVENT_PUBLICATION_REQUIRED")
    return {"status": "STAGING_DURABLE_WORK_RECOVERED", "eventsRecovered": 2, "canonicalDigestsPreserved": True,
            "leasesCleared": True, "retryAttemptsPreserved": True, "eligibilityFloorsRespected": True}


class RuntimeOperator:
    def __init__(self, selected, jobs, configuration, containers, programs_directory, programs, output, api_only=False):
        demand(selected.get("environment") == "staging" and set(jobs) == {"frontend", "course", "community"}, "STAGING_OPERATOR_THREE_TARGETS_REQUIRED")
        for path in (configuration, programs_directory, output):
            staging_state.outside_checkout(path)
        demand(type(api_only) is bool, "STAGING_OPERATOR_EXPLICIT_CAPABILITY_REQUIRED")
        services = {"course-api", "community-api"} if api_only else set(runtime.SERVICES)
        demand({c.get("service") for c in containers} == services and len(containers) == len(services)
               and len({c.get("containerId") for c in containers}) == len(services), "STAGING_OPERATOR_EXACT_CONTAINERS_REQUIRED")
        for c in containers:
            demand(isinstance(c.get("containerId"), str) and re.fullmatch(r"[a-f0-9]{64}", c["containerId"])
                   and c.get("image") == selected["artifacts"][runtime.IMAGE_KEYS[c["service"]]]["image"], "STAGING_OPERATOR_IMAGE_BINDING_REQUIRED")
        demand(set(programs) == {"fixture", "work"}, "STAGING_OPERATOR_TWO_PROGRAMS_REQUIRED")
        self.code = {}
        for name, info in programs.items():
            demand(set(info) == {"file", "sha256"} and info["file"] == "staging-" + name + "-operator.mjs",
                   "STAGING_OPERATOR_PROGRAM_BINDING_REQUIRED")
            raw = migrate.read_input(programs_directory, info["file"], 65_536)
            demand(migrate.file_hash(raw) == info["sha256"], "STAGING_OPERATOR_REVIEWED_PROGRAM_HASH_REQUIRED")
            self.code[name] = raw.decode()
        self.selected, self.jobs, self.configuration = selected, jobs, configuration
        self.containers = {c["service"]: c for c in containers}
        self.output, self.programs, self.counter = output, programs, 0
        self.api_only = api_only

    def _child(self, service, program, payload, lines=False):
        container = self.containers[service]
        fields = '{{.Config.Image}}|{{.State.Running}}|{{.State.Health.Status}}|{{index .Config.Labels "com.docker.compose.service"}}'
        demand(runtime.command(["docker", "inspect", "--format", fields, container["containerId"]], runtime.SAFE_ENV)
               == container["image"] + "|true|healthy|" + service, "STAGING_OPERATOR_LIVE_CONTAINER_CHANGED")
        self.counter += 1
        value = subprocess.run(["docker", "exec", "-i", "--env", "NODE_OPTIONS=--max-old-space-size=96", container["containerId"],
            "node", "--input-type=module", "--eval", self.code[program]], input=json.dumps(payload).encode(),
            env=runtime.SAFE_ENV, capture_output=True, timeout=45)
        if lines and len(value.stdout) <= 2_000_000:
            observed = []
            for raw in value.stdout.splitlines():
                try:
                    row = json.loads(raw)
                except (ValueError, TypeError):
                    break
                if not isinstance(row, dict) or row.get("status") not in ("STAGING_FIXTURE_DRAFT_CREATED", "STAGING_FIXTURE_GRANT_CREATED"):
                    break
                serialized = json.dumps(row)
                demand(not any(marker in serialized for marker in (payload.get("applicationToken", "Bearer "), "postgresql://", "postgres://", "Bearer ")),
                       "STAGING_OPERATOR_PRIVATE_OUTPUT_REFUSED")
                observed.append(row)
            if observed:
                migrate.write_json(self.output, "fixture-observed-progress.json", observed)
        if value.returncode:
            # Retain diagnostics privately; never include arbitrary child output
            # in a common exception or a provider/application action receipt.
            for name, raw in (("stdout", value.stdout), ("stderr", value.stderr)):
                file = self.output / f"private-child-{self.counter}-{name}.bin"
                with file.open("xb") as stream:
                    stream.write(raw)
                file.chmod(0o600)
        demand(value.returncode == 0 and len(value.stdout) <= 2_000_000, "STAGING_OPERATOR_CHILD_REQUIRES_REVIEW")
        parsed = [json.loads(line) for line in value.stdout.splitlines()] if lines else json.loads(value.stdout)
        serialized = json.dumps(parsed)
        demand(not any(marker in serialized for marker in ("postgresql://", "postgres://", "Bearer ", "STAGING_DATABASE_URL")),
               "STAGING_OPERATOR_PRIVATE_OUTPUT_REFUSED")
        for key in ("applicationToken", "privateFingerprintKey"):
            demand(not payload.get(key) or payload[key] not in serialized, "STAGING_OPERATOR_PRIVATE_OUTPUT_REFUSED")
        return parsed

    def api(self, service, mode, **private):
        demand(service in ("course", "community") and mode in ("preflight", "fingerprint", "retain", "outbox", "inbox"),
               "STAGING_OPERATOR_FIXED_API_MODE_REQUIRED")
        demand(not self.api_only or mode != "retain", "STAGING_OPERATOR_READ_ONLY_CAPABILITY_REQUIRED")
        job = self.jobs[service]["job"]
        target = {key: job["target"][key] for key in ("host", "port", "database", "serverMajor")}
        target["user"] = job["runtimeRole"]
        return self._child(service + "-api", "work", {"version": 1, "service": service, "mode": mode, "target": target, **private})

    def fingerprint(self, private_key):
        values = {name: self.api(name, "fingerprint", privateFingerprintKey=private_key) for name in ("course", "community")}
        for name, value in values.items():
            demand(value.get("status") == "STAGING_BUSINESS_FINGERPRINT_READ_ONLY" and value.get("service") == name
                   and value.get("rawRowsExported") is False and value.get("privateKeyExported") is False,
                   "STAGING_OPERATOR_PRIVATE_FINGERPRINT_REQUIRED")
        return values

    def stop(self, services):
        demand(not self.api_only, "STAGING_OPERATOR_READ_ONLY_CAPABILITY_REQUIRED")
        stopped = []
        for service in services:
            demand(service in self.containers, "STAGING_OPERATOR_REVIEWED_SERVICE_REQUIRED")
            container = self.containers[service]
            demand(runtime.command(["docker", "stop", "--time", "90", container["containerId"]], runtime.SAFE_ENV, 110)
                   == container["containerId"], "STAGING_OPERATOR_EXACT_STOP_ACK_REQUIRED")
            stopped.append(staging_retire.stopped_container(container))
        return stopped

    def prepare_retained(self, action):
        demand(not self.api_only, "STAGING_OPERATOR_READ_ONLY_CAPABILITY_REQUIRED")
        demand(isinstance(action, str) and re.fullmatch(r"recovery-fixture-[a-z0-9][a-z0-9-]{0,64}", action), "STAGING_OPERATOR_FIXTURE_ACTION_REQUIRED")
        nonce, actor, users = uuid4().hex, str(uuid4()), [str(uuid4()), str(uuid4())]
        intent = {"actionId": action, "nonce": nonce, "actorUserId": actor, "userIds": users, "environment": "staging",
                  "publicGatewayWritesAdmitted": False, "migrationsExecuted": False}
        migrate.write_json(self.output, "retained-work-started.json", intent)
        outcome = {**intent, "status": "STAGING_RETAINED_WORK_REQUIRES_REVIEW", "phase": "pause-publisher-and-reconciliation"}
        try:
            outcome["pausedProcesses"] = self.stop(("course-publisher", "community-worker"))
            values = runtime.environment_values(migrate.read_input(self.configuration, "course-api.env", 65_536), "staging", "course-api", self.jobs)
            secret = values.get("FIRST_PARTY_AUTH_SECRET")
            demand(isinstance(secret, str) and len(secret) >= 32, "STAGING_OPERATOR_EXISTING_APPLICATION_SECRET_REQUIRED")
            now = int(time.time())
            claims = {"sub": actor, "role": "courseAdmin", "iat": now, "exp": now + 300, "jti": str(uuid4())}
            for source, target in (("FIRST_PARTY_AUTH_ISSUER", "iss"), ("FIRST_PARTY_AUTH_AUDIENCE", "aud")):
                if values.get(source):
                    claims[target] = values[source]
            def encoded(value):
                return base64.urlsafe_b64encode(value).rstrip(b"=").decode()
            unsigned = encoded(b'{"alg":"HS256","typ":"JWT"}') + "." + encoded(json.dumps(claims).encode())
            token = unsigned + "." + encoded(hmac.new(secret.encode(), unsigned.encode(), hashlib.sha256).digest())
            outcome["phase"] = "private-administrator-api-fixture"
            records = self._child("gateway", "fixture", {"version": 1, "environment": "staging", "actionId": action,
                "actorUserId": actor, "nonce": nonce, "userIds": users, "applicationToken": token}, lines=True)
            demand(isinstance(records, list) and len(records) == 4, "STAGING_OPERATOR_THREE_CALL_FIXTURE_REQUIRED")
            fixture = records[-1]
            demand(fixture.get("status") == "STAGING_FIXTURE_TWO_GRANTS_CREATED" and fixture.get("environment") == "staging"
                   and fixture.get("actionId") == action and fixture.get("courseSlug") == "p1-recovery-" + nonce
                   and fixture.get("coursePublished") is False and fixture.get("syntheticIdentitiesOnly") is True
                   and {g.get("userId") for g in fixture.get("grants", [])} == set(users), "STAGING_OPERATOR_ACTUAL_FIXTURE_BINDING_REQUIRED")
            migrate.write_json(self.output, "fixture-progress.json", records[:-1])
            migrate.write_json(self.output, "fixture-outcome.json", fixture)
            outcome["phase"] = "actual-repository-retention"
            retained = self.api("course", "retain", fixture=fixture)
            demand(retained.get("status") == "STAGING_DURABLE_WORK_RETAINED" and retained.get("environment") == "staging"
                   and retained.get("actionId") == action and retained.get("courseId") == fixture.get("courseId")
                   and len(retained.get("events", [])) == 2 and retained.get("recovered") is False, "STAGING_OPERATOR_ACTUAL_RETENTION_REQUIRED")
            migrate.write_json(self.output, "retained-work.json", retained)
            outcome.update(status="STAGING_RETAINED_WORK_PREPARED", phase="completed", events=retained["events"],
                           courseId=retained["courseId"], apiContainerId=self.containers["course-api"]["containerId"])
            return retained
        except BaseException as error:
            outcome["failureCode"] = safe_code(error)
            raise ValueError(outcome["failureCode"]) from None
        finally:
            migrate.write_json(self.output, "retained-work-outcome.json", outcome)

    def verify_recovery(self, retained, clock=time):
        deadline, source, receiver = clock.monotonic() + 100, None, None
        while clock.monotonic() < deadline:
            source = self.api("course", "outbox", retained=retained)
            receiver = self.api("community", "inbox", retained=retained)
            try:
                result = recovered(retained, source, receiver)
                migrate.write_json(self.output, "durable-recovery.json", {**result, "retained": retained,
                    "outbox": source, "inbox": receiver, "apiContainers": [self.containers[name + "-api"] for name in ("course", "community")],
                    "operatorProgramsSha256": {key: info["sha256"] for key, info in self.programs.items()}})
                return result
            except (ValueError, KeyError, StopIteration, TypeError):
                clock.sleep(3)
        # Preserve the last actual observations, never a caller's success file.
        migrate.write_json(self.output, "durable-recovery-refused.json", {"status": "STAGING_DURABLE_RECOVERY_REQUIRES_REVIEW",
            "outbox": source, "inbox": receiver, "retained": retained})
        raise ValueError("STAGING_DURABLE_RECOVERY_OBSERVATION_TIMEOUT")
