"""Exact-child extension of the existing fresh read-only identity host scope."""
import json

import migrate
import release as runtime
from p2_identity_probe_scope import CurrentIdentityProbeScope


class CurrentLifecyclePersistenceScope(CurrentIdentityProbeScope):
    """Retains the existing flock/process/inventory guard and adds one fixed child."""

    def __init__(self, selected, reviewed, configuration, program, verify_inputs):
        super().__init__(selected, reviewed, configuration, program, verify_inputs)
        self.persistence_program = program

    def _allowed(self, args, private_input, environment):
        if private_input is None:
            return super()._allowed(args, private_input, environment)
        migrate.demand(isinstance(private_input, bytes) and 0 < len(private_input) <= 262_144 and environment == runtime.SAFE_ENV,
            "P2_PERSISTENCE_PRIVATE_STDIN_REQUIRED")
        payload = json.loads(private_input)
        mode = payload.get("mode")
        migrate.demand(mode in ("frontend", "course", "community", "combine"), "P2_PERSISTENCE_FIXED_CHILD_REQUIRED")
        service = "community-api" if mode == "community" else "course-api"
        identifier = next(row["containerId"] for row in self.reviewed["containers"] if row["service"] == service)
        fixed = ["docker", "exec", "-i", "--workdir", "/app", "--env", "NODE_OPTIONS=--max-old-space-size=128",
            "--env", "DOTENV_CONFIG_QUIET=true", identifier, "node", "--input-type=module", "--eval", self.persistence_program.decode()]
        migrate.demand(args == fixed and payload.get("environment") == "staging", "P2_PERSISTENCE_FIXED_CHILD_REQUIRED")

    def run_persistence(self, mode, payload):
        service = "community-api" if mode == "community" else "course-api"
        identifier = next(row["containerId"] for row in self.reviewed["containers"] if row["service"] == service)
        args = ["docker", "exec", "-i", "--workdir", "/app", "--env", "NODE_OPTIONS=--max-old-space-size=128",
            "--env", "DOTENV_CONFIG_QUIET=true", identifier, "node", "--input-type=module", "--eval", self.persistence_program.decode()]
        return self.run(args, timeout=30, input=json.dumps(payload, separators=(",", ":")).encode(), env=runtime.SAFE_ENV, capture_output=True)
