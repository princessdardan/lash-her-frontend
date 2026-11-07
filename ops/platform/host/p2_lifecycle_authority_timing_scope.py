"""Fixed-child extension of the current P2 identity host lease for S13."""
import json

import migrate
import release as runtime
from p2_identity_probe_scope import CurrentIdentityProbeScope


class CurrentAuthorityTimingScope(CurrentIdentityProbeScope):
    """Permits only the reviewed S13 program in the selected gateway image."""

    def _allowed(self, args, private_input, environment):
        if private_input is None:
            return super()._allowed(args, private_input, environment)
        migrate.demand(isinstance(private_input, bytes) and 0 < len(private_input) <= 65_536 and environment == runtime.SAFE_ENV,
            "P2_S13_PRIVATE_STDIN_REQUIRED")
        payload = json.loads(private_input)
        migrate.demand(payload.get("mode") in ("s13-capture", "s13-user-observe", "s13-mux-observe") and
            payload.get("environment") == "staging", "P2_S13_FIXED_CHILD_REQUIRED")
        gateway = next(row["containerId"] for row in self.reviewed["containers"] if row["service"] == "gateway")
        fixed = ["docker", "exec", "-i", "--workdir", "/app", "--env", "NODE_OPTIONS=--max-old-space-size=96",
            "--env", "DOTENV_CONFIG_QUIET=true", gateway, "node", "--input-type=module", "--eval", self.program.decode()]
        migrate.demand(args == fixed, "P2_S13_FIXED_CHILD_REQUIRED")

    def run_s13(self, payload):
        gateway = next(row["containerId"] for row in self.reviewed["containers"] if row["service"] == "gateway")
        args = ["docker", "exec", "-i", "--workdir", "/app", "--env", "NODE_OPTIONS=--max-old-space-size=96",
            "--env", "DOTENV_CONFIG_QUIET=true", gateway, "node", "--input-type=module", "--eval", self.program.decode()]
        return self.run(args, timeout=30, input=json.dumps(payload, sort_keys=True, separators=(",", ":")).encode(),
            env=runtime.SAFE_ENV, capture_output=True)
