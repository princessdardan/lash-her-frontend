"""Continuous canonical host flock with only fixed SELECT and receiver children."""
import json

import migrate
import release as runtime
from p2_lifecycle_persistence_scope import CurrentLifecyclePersistenceScope

CASES = ("exact-replay", "changed-replay", "stale-restore")


class CurrentLifecycleReceiverScope(CurrentLifecyclePersistenceScope):
    """POST children preserve account state; rate-limit writes are permitted.

    There is deliberately no future-gap POST in this live scope. A host flock
    alone does not prove closed frontend/gateway/native admission.
    """
    def __init__(self, selected, reviewed, configuration, persistence_program, receiver_program, verify_inputs):
        self.receiver_program = receiver_program
        super().__init__(selected, reviewed, configuration, persistence_program, verify_inputs)

    def _allowed(self, args, private_input, environment):
        if private_input is None:
            extra = (["docker", "context", "inspect", "default", "--format", '{{(index .Endpoints "docker").Host}}'],
                ["docker", "version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"])
            if args in extra:
                migrate.demand(environment == runtime.SAFE_ENV, "P2_RECEIVER_CLOSED_ENVIRONMENT_REQUIRED")
                return
            return super()._allowed(args, private_input, environment)
        migrate.demand(isinstance(private_input, bytes) and 0 < len(private_input) <= 262_144,
            "P2_RECEIVER_PRIVATE_STDIN_REQUIRED")
        payload = json.loads(private_input)
        if payload.get("mode") not in ("post", "runtime-binding"):
            return super()._allowed(args, private_input, environment)
        service = payload.get("service")
        migrate.demand(service in ("course", "community") and payload.get("environment") == "staging"
            and environment == runtime.SAFE_ENV and (payload["mode"] != "post" or payload.get("case") in CASES),
            "P2_RECEIVER_FIXED_CASE_REQUIRED")
        container = "gateway" if payload["mode"] == "post" else service + "-api"
        identifier = next(row["containerId"] for row in self.reviewed["containers"] if row["service"] == container)
        fixed = ["docker", "exec", "-i", "--workdir", "/app", "--env", "NODE_OPTIONS=--max-old-space-size=96",
            "--env", "DOTENV_CONFIG_QUIET=true", identifier, "node", "--input-type=module", "--eval", self.receiver_program.decode()]
        migrate.demand(args == fixed, "P2_RECEIVER_FIXED_CHILD_REQUIRED")

    def run_receiver(self, payload):
        container = "gateway" if payload["mode"] == "post" else payload["service"] + "-api"
        identifier = next(row["containerId"] for row in self.reviewed["containers"] if row["service"] == container)
        args = ["docker", "exec", "-i", "--workdir", "/app", "--env", "NODE_OPTIONS=--max-old-space-size=96",
            "--env", "DOTENV_CONFIG_QUIET=true", identifier, "node", "--input-type=module", "--eval", self.receiver_program.decode()]
        return self.run(args, input=json.dumps(payload, separators=(",", ":")).encode(), env=runtime.SAFE_ENV,
            timeout=20, capture_output=True)
