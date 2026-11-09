"""Exact-child extension of the existing fresh read-only identity host scope."""
import json

import migrate
import release as runtime
from p2_identity_probe_scope import CurrentIdentityProbeScope

PERSISTENCE_PROGRAM_MAXIMUM = 524_288
PERSISTENCE_PROGRAM_CHUNK = 65_536
# Linux x86_64 caps one exec argument at 128 KiB, including its NUL.
# Retain the exact reviewed program and pass its bytes as bounded argv chunks.
PERSISTENCE_PROGRAM_LOADER = (
    'await import("data:text/javascript;base64,"+Buffer.from(process.argv.slice(1).join(""),"ascii").toString("base64"));'
)


def persistence_program_arguments(program):
    migrate.demand(type(program) is bytes and 0 < len(program) <= PERSISTENCE_PROGRAM_MAXIMUM and b"\x00" not in program,
                   "P2_PERSISTENCE_PRIVATE_PROGRAM_ARGUMENT_BOUND")
    chunks = [program[offset:offset + PERSISTENCE_PROGRAM_CHUNK].decode("ascii")
              for offset in range(0, len(program), PERSISTENCE_PROGRAM_CHUNK)]
    return ["node", "--input-type=module", "--eval", PERSISTENCE_PROGRAM_LOADER, "--", *chunks]


class CurrentLifecyclePersistenceScope(CurrentIdentityProbeScope):
    """Retains the existing flock/process/inventory guard and adds one fixed child."""

    def __init__(self, selected, reviewed, configuration, program, verify_inputs):
        super().__init__(selected, reviewed, configuration, program, verify_inputs)
        self.persistence_program = program
        self.runtime_bound = False

    def _actual_runtime(self):
        actual = super().inventory(self.selected, self.configuration)
        migrate.demand(actual == self.reviewed["containers"], "P2_PERSISTENCE_RUNTIME_CHANGED")

    def bind_runtime(self):
        migrate.demand(not self.runtime_bound, "P2_PERSISTENCE_RUNTIME_ALREADY_BOUND")
        self._actual_runtime()
        self.runtime_bound = True

    def verify_runtime(self):
        migrate.demand(self.runtime_bound, "P2_PERSISTENCE_RUNTIME_NOT_BOUND")
        self.verify()
        self._actual_runtime()
        self.verify()

    def _persistence_command(self, mode):
        service = "community-api" if mode == "community" else "course-api"
        identifier = next(row["containerId"] for row in self.reviewed["containers"] if row["service"] == service)
        return ["docker", "exec", "-i", "--workdir", "/app", "--env", "NODE_OPTIONS=--max-old-space-size=128",
                "--env", "DOTENV_CONFIG_QUIET=true", identifier, *persistence_program_arguments(self.persistence_program)]

    def _allowed(self, args, private_input, environment):
        if private_input is None:
            return super()._allowed(args, private_input, environment)
        migrate.demand(isinstance(private_input, bytes) and 0 < len(private_input) <= 262_144 and environment == runtime.SAFE_ENV,
            "P2_PERSISTENCE_PRIVATE_STDIN_REQUIRED")
        payload = json.loads(private_input)
        mode = payload.get("mode")
        migrate.demand(mode in ("frontend", "course", "community", "combine"), "P2_PERSISTENCE_FIXED_CHILD_REQUIRED")
        migrate.demand(args == self._persistence_command(mode) and payload.get("environment") == "staging", "P2_PERSISTENCE_FIXED_CHILD_REQUIRED")

    def run_persistence(self, mode, payload):
        return self.run(self._persistence_command(mode), timeout=30, input=json.dumps(payload, separators=(",", ":")).encode(),
                        env=runtime.SAFE_ENV, capture_output=True)
