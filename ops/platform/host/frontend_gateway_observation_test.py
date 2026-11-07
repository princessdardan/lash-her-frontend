import json
from pathlib import Path
import tempfile
import unittest

import frontend_gateway_observation as gateway
import migrate


class GatewayObservationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(); self.root = Path(self.directory.name).resolve()
        self.root.chmod(0o700); (self.root / "admission").mkdir(mode=0o700)
        self.binding = {"hostMachineId": "1" * 32, "releaseId": "existing-host", "candidateSha256": "2" * 64,
            "gatewayImage": "ghcr.io/princessdardan/lash-her-platform-gateway@sha256:" + "3" * 64}
        target = {"environment": "staging", "releaseId": "existing-host", "hostMachineId": "1" * 32}
        config = {"appEnv": "staging", "admission": {"file": "/admission/state.json", "releaseId": "existing-host", "candidateSha256": "2" * 64}}
        for name, value, key in (("runtime.json", target, "runtimeConfigurationSha256"), ("gateway.json", config, "gatewayConfigurationSha256")):
            raw = json.dumps(value).encode(); (self.root / name).write_bytes(raw); (self.root / name).chmod(0o600); self.binding[key] = migrate.file_hash(raw)
        state = {"version": 1, "environment": "staging", "releaseId": "existing-host", "candidateSha256": "2" * 64,
            "actionId": "already-reviewed-host-state", "newWork": False, "recovery": True}
        raw = json.dumps(state).encode(); (self.root / "admission/state.json").write_bytes(raw); (self.root / "admission/state.json").chmod(0o600)
        self.state = {**state, "sha256": migrate.file_hash(raw), "valid": True, "active": {"newWork": 0, "recovery": 0}, "uncertain": {"newWork": 0, "recovery": 0}}
        self.calls, self.verifications, self.bad_mount = [], 0, False

    def tearDown(self): self.directory.cleanup()
    def verify(self): self.verifications += 1
    def command(self, args, env, timeout):
        self.calls.append(args); self.assertLessEqual(timeout, 5)
        if args[1:3] == ["container", "ls"]: return "a" * 64
        if args[1:3] == ["image", "inspect"]: return "sha256:" + "3" * 64
        if args[1] == "inspect" and args[3] == "{{json .Mounts}}":
            return json.dumps([{"Destination": dest, "Source": str(source), "Type": "bind", "RW": self.bad_mount} for dest, source in
                (("/config/gateway.json", self.root / "gateway.json"), ("/admission", self.root / "admission"))])
        if args[1] == "inspect": return "sha256:" + "3" * 64 + "|true|healthy|lash-her-staging|gateway"
        if args[1] == "exec": return json.dumps(self.state)
        raise AssertionError("unexpected command")
    def observe(self):
        return gateway.observe(self.root, self.binding, self.verify, self.command, lambda target: self.assertEqual(target, {"hostMachineId": "1" * 32}))

    def test_exact_existing_config_mount_image_and_actual_admission_are_readonly(self):
        before = {str(path): path.read_bytes() for path in self.root.rglob("*.json")}
        result = self.observe(); self.assertEqual(result["admission"]["sha256"], self.state["sha256"]); self.assertFalse(result["gatewayMutated"])
        self.assertGreaterEqual(self.verifications, len(self.calls) * 2)
        self.assertFalse(any(any(value in args for value in ("restart", "up", "stop")) for args in self.calls))
        for name, raw in before.items(): self.assertEqual(Path(name).read_bytes(), raw)

    def test_changed_configuration_wrong_mount_or_unknown_counts_refuse(self):
        original = (self.root / "gateway.json").read_bytes()
        (self.root / "gateway.json").write_text("{}"); self.assertRaisesRegex(ValueError, "CONFIGURATION_CHANGED", self.observe)
        (self.root / "gateway.json").write_bytes(original); self.bad_mount = True; self.assertRaisesRegex(ValueError, "MOUNT_CHANGED", self.observe)
        self.bad_mount = False; self.state["uncertain"]["recovery"] = None; self.assertRaisesRegex(ValueError, "COUNTS_REQUIRED", self.observe)

    def test_gateway_must_ack_exact_durable_state_and_source_not_only_flags(self):
        self.state["sha256"] = "f" * 64; self.assertRaisesRegex(ValueError, "ADMISSION_ACK_REFUSED", self.observe)
        self.state["sha256"] = migrate.file_hash((self.root / "admission/state.json").read_bytes()); self.state["candidateSha256"] = "e" * 64
        self.assertRaisesRegex(ValueError, "ADMISSION_ACK_REFUSED", self.observe)

if __name__ == "__main__": unittest.main()
