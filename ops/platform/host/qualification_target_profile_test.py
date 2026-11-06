import hashlib
import importlib.util
import inspect
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path


SOURCE = Path(__file__).with_name("qualification_target_profile.py")
CURRENT_CANONICAL = (
    b'{"environment":"staging","frontend":{"canonicalOrigin":"https://staging.lashher.com",'
    b'"projectId":"prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM","teamId":"team_2Hrn5eMZyZxfAWdmYvyKi9t3",'
    b'"workloadEnvironment":"production"},"gateway":{"publicOrigin":"https://api-staging.lashher.com"},'
    b'"id":"staging-current","kind":"existing-staging","selectionPolicy":"existing-staging-v1",'
    b'"version":1}'
)
CURRENT_SHA256 = "ea88751524540bfe177e089680b41d6f35b2454d73d17ef9a40b7663381225ba"
CURRENT_REGISTRY = b'{"version":1,"profiles":[' + CURRENT_CANONICAL + b']}\n'


class QualificationTargetProfileTest(unittest.TestCase):
    def make_layout(self, registry=CURRENT_REGISTRY, registry_writer=None):
        temporary = tempfile.TemporaryDirectory(prefix="qualification-target-profile-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name).resolve()
        host = root / "ops/platform/host"
        host.mkdir(parents=True)
        module_path = host / SOURCE.name
        shutil.copyfile(SOURCE, module_path)
        registry_path = host.parent / "qualification-target-profiles.json"
        if registry_writer is None:
            registry_path.write_bytes(registry)
        else:
            registry_writer(registry_path)
        return module_path

    def load_module(self, registry=CURRENT_REGISTRY, registry_writer=None):
        module_path = self.make_layout(registry, registry_writer)
        name = f"qualification_target_profile_{uuid.uuid4().hex}"
        spec = importlib.util.spec_from_file_location(name, module_path)
        self.assertIsNotNone(spec)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def assert_code(self, module, code, operation):
        with self.assertRaises(module.QualificationTargetProfileError) as raised:
            operation()
        self.assertEqual(str(raised.exception), code)
        self.assertEqual(raised.exception.code, code)

    def current_ref(self):
        return {"version": 1, "id": "staging-current", "sha256": CURRENT_SHA256}

    def raw_carrier(self, version="1", *, profile_key="qualificationTargetProfile", version_key="version"):
        return (
            '{"' + profile_key + '":{"' + version_key + '":' + version +
            ',"id":"staging-current","sha256":"' + CURRENT_SHA256 + '"}}'
        )

    def test_current_registry_vector_reference_and_policy_are_exact(self):
        module = self.load_module()
        self.assertEqual(len(CURRENT_CANONICAL), 371)
        self.assertEqual(hashlib.sha256(CURRENT_CANONICAL).hexdigest(), CURRENT_SHA256)
        self.assertEqual(dict(module.STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE), self.current_ref())
        parsed = module.parse_qualification_target_profile_ref(self.current_ref())
        self.assertEqual(dict(parsed), self.current_ref())
        definition = module.resolve_qualification_target_profile(parsed)
        self.assertEqual(
            json.dumps(self.thaw(definition), sort_keys=True, separators=(",", ":")).encode(),
            CURRENT_CANONICAL,
        )
        self.assertEqual(definition["kind"], "existing-staging")
        self.assertEqual(definition["selectionPolicy"], "existing-staging-v1")
        for live_proof in ("releaseAccepted", "hostMachineId", "ownerOid", "runtimeOid", "providers"):
            self.assertNotIn(live_proof, definition)

    def test_exports_have_no_path_bound_or_module_selector(self):
        module = self.load_module()
        self.assertEqual(tuple(inspect.signature(module.decode_qualification_target_json).parameters), ("raw", "kind"))
        self.assertEqual(tuple(inspect.signature(module.resolve_qualification_target_profile).parameters), ("ref",))
        self.assertNotIn("getenv", SOURCE.read_text())
        self.assertNotIn("import_module", SOURCE.read_text())

    def test_registry_and_outputs_are_immutable_and_copy_isolated(self):
        module = self.load_module()
        reference = module.parse_qualification_target_profile_ref(self.current_ref())
        definition = module.resolve_qualification_target_profile(reference)
        with self.assertRaises(TypeError):
            reference["id"] = "changed"
        with self.assertRaises(TypeError):
            definition["frontend"]["projectId"] = "changed"
        supplied = self.current_ref()
        parsed = module.parse_qualification_target_profile_ref(supplied)
        supplied["id"] = "changed"
        self.assertEqual(parsed["id"], "staging-current")

    def test_raw_decoder_rejects_duplicate_decoded_keys_at_every_boundary(self):
        module = self.load_module()
        duplicate_registry = b'{"version":1,"\\u0076ersion":1,"profiles":[]}'
        duplicate_carrier = self.raw_carrier().replace(
            '"version":1,', '"version":1,"\\u0076ersion":1,', 1)
        nested_private = '{"nested":{"id":"first","\\u0069d":"second"}}'
        for raw, kind in (
            (duplicate_registry, "registry"),
            (duplicate_carrier, "carrier"),
            (nested_private, "private-packet"),
        ):
            self.assert_code(module, module.QUALIFICATION_TARGET_PROFILE_REFUSED,
                             lambda raw=raw, kind=kind: module.decode_qualification_target_json(raw, kind))

    def test_raw_decoder_enforces_canonical_profile_numeric_tokens(self):
        module = self.load_module()
        for version in ("1.0", "1e0", "-0", "9007199254740992"):
            for kind in ("carrier", "private-packet"):
                self.assert_code(
                    module,
                    module.QUALIFICATION_TARGET_PROFILE_REFUSED,
                    lambda version=version, kind=kind: module.decode_qualification_target_json(
                        self.raw_carrier(version), kind),
                )
        escaped_path = self.raw_carrier("1.0", profile_key="qualificationTarget\\u0050rofile")
        self.assert_code(module, module.QUALIFICATION_TARGET_PROFILE_REFUSED,
                         lambda: module.decode_qualification_target_json(escaped_path, "carrier"))
        for invalid_type in ("true", "null", '"1"', "{}", "[]"):
            self.assert_code(
                module,
                module.QUALIFICATION_TARGET_PROFILE_REFUSED,
                lambda invalid_type=invalid_type: module.decode_qualification_target_json(
                    self.raw_carrier(invalid_type), "carrier"),
            )

    def test_raw_registry_rejects_noncanonical_or_unsafe_numbers(self):
        module = self.load_module()
        for raw in (b'{"version":1.0,"profiles":[]}', b'{"version":1e0,"profiles":[]}',
                    b'{"version":-0,"profiles":[]}', b'{"version":9007199254740992,"profiles":[]}'):
            self.assert_code(module, module.QUALIFICATION_TARGET_PROFILE_REFUSED,
                             lambda raw=raw: module.decode_qualification_target_json(raw, "registry"))

    def test_unrelated_unicode_and_fractional_private_values_are_preserved(self):
        module = self.load_module()
        decoded = module.decode_qualification_target_json(
            '{"display":"café 漢字","ratio":1.5,"negativeZero":-0,"large":9007199254740992}',
            "private-packet",
        )
        self.assertEqual(decoded["display"], "café 漢字")
        self.assertEqual(decoded["ratio"], 1.5)
        self.assertEqual(decoded["negativeZero"], 0)
        self.assertEqual(decoded["large"], 9007199254740992)
        self.assertEqual(
            module.decode_qualification_target_json('{"value":"\\ud83d\\ude00"}', "private-packet")["value"],
            "😀",
        )

    def test_escaped_lone_surrogates_in_values_and_keys_refuse(self):
        module = self.load_module()
        for raw in ('{"value":"\\ud800"}', '{"\\udfff":"value"}'):
            self.assert_code(
                module,
                module.QUALIFICATION_TARGET_PROFILE_REFUSED,
                lambda raw=raw: module.decode_qualification_target_json(raw, "private-packet"),
            )

    def test_strict_utf8_bom_constants_bounds_and_depth_refuse(self):
        module = self.load_module()
        invalid = (
            (b"\xff", "carrier"),
            (b"\xef\xbb\xbf{}", "carrier"),
            ('"\ud800"', "carrier"),
            (b'{"value":NaN}', "carrier"),
            (b'{"value":Infinity}', "private-packet"),
            (b'{"value":1e10000}', "private-packet"),
            ("[" * 129 + "0" + "]" * 129, "carrier"),
            (" " * 2_000_001, "carrier"),
        )
        for raw, kind in invalid:
            self.assert_code(module, module.QUALIFICATION_TARGET_PROFILE_REFUSED,
                             lambda raw=raw, kind=kind: module.decode_qualification_target_json(raw, kind))
        accepted = module.decode_qualification_target_json("[" * 128 + "0" + "]" * 128, "carrier")
        for _ in range(128):
            self.assertIsInstance(accepted, list)
            accepted = accepted[0]
        self.assertEqual(accepted, 0)
        for invalid_kind in (None, "", "caller-bound", 1):
            self.assert_code(module, module.QUALIFICATION_TARGET_PROFILE_REFUSED,
                             lambda invalid_kind=invalid_kind: module.decode_qualification_target_json("{}", invalid_kind))

    def test_reference_shape_types_lookup_and_hash_are_closed(self):
        module = self.load_module()
        malformed = (
            None,
            [],
            {**self.current_ref(), "extra": True},
            {"version": True, "id": "staging-current", "sha256": CURRENT_SHA256},
            {"version": 1, "id": "Staging-current", "sha256": CURRENT_SHA256},
            {"version": 1, "id": "staging-current", "sha256": "sha256:" + CURRENT_SHA256},
            {"version": 1, "id": "staging-current", "sha256": CURRENT_SHA256.upper()},
            {"version": 1, "id": "staging-current", "sha256": "0" * 64},
        )
        for value in malformed:
            self.assert_code(module, module.QUALIFICATION_TARGET_PROFILE_REFUSED,
                             lambda value=value: module.parse_qualification_target_profile_ref(value))
        self.assert_code(
            module,
            module.QUALIFICATION_TARGET_PROFILE_UNKNOWN,
            lambda: module.parse_qualification_target_profile_ref(
                {"version": 1, "id": "p2q-20261106", "sha256": "1" * 64}),
        )
        self.assert_code(
            module,
            module.QUALIFICATION_TARGET_PROFILE_DIGEST_MISMATCH,
            lambda: module.parse_qualification_target_profile_ref(
                {"version": 1, "id": "staging-current", "sha256": "1" * 64}),
        )

    def test_require_refuses_zero_missing_legacy_and_mismatched_carriers(self):
        module = self.load_module()
        expected = module.STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE
        self.assert_code(module, module.QUALIFICATION_TARGET_PROFILE_REQUIRED,
                         lambda: module.require_qualification_target_profile(expected))
        for carrier in ({}, {"version": 2}, None):
            self.assert_code(
                module,
                module.QUALIFICATION_TARGET_PROFILE_REQUIRED,
                lambda carrier=carrier: module.require_qualification_target_profile(expected, carrier),
            )
        verified = module.require_qualification_target_profile(
            expected,
            {"qualificationTargetProfile": self.current_ref()},
            {"qualificationTargetProfile": dict(expected)},
        )
        self.assertEqual(dict(verified), self.current_ref())
        self.assert_code(
            module,
            module.QUALIFICATION_TARGET_PROFILE_DIGEST_MISMATCH,
            lambda: module.require_qualification_target_profile(
                expected,
                {"qualificationTargetProfile": {**self.current_ref(), "sha256": "1" * 64}},
            ),
        )

    def test_registry_is_fixed_current_only_and_cannot_enable_isolated_policy(self):
        module = self.load_module()
        isolated = json.loads(CURRENT_CANONICAL)
        isolated.update(id="p2q-20261106", kind="isolated-allocated", selectionPolicy="isolated-allocated-v1")
        raw = json.dumps({"version": 1, "profiles": [json.loads(CURRENT_CANONICAL), isolated]},
                         separators=(",", ":")).encode()
        with self.assertRaisesRegex(Exception, f"^{module.QUALIFICATION_TARGET_PROFILE_POLICY_REFUSED}$"):
            self.load_module(raw)

    def test_registry_rejects_shape_literal_and_raw_drift(self):
        module = self.load_module()
        cases = []
        envelope = json.loads(CURRENT_REGISTRY)
        changed_origin = json.loads(CURRENT_REGISTRY)
        changed_origin["profiles"][0]["frontend"]["canonicalOrigin"] = "https://caller.invalid"
        extra = json.loads(CURRENT_REGISTRY)
        extra["profiles"][0]["extra"] = True
        boolean_version = json.loads(CURRENT_REGISTRY)
        boolean_version["profiles"][0]["version"] = True
        cases.extend((changed_origin, extra, boolean_version))
        for value in cases:
            raw = json.dumps(value, separators=(",", ":")).encode()
            with self.assertRaises(Exception) as raised:
                self.load_module(raw)
            self.assertIn(
                str(raised.exception),
                (module.QUALIFICATION_TARGET_PROFILE_REFUSED,
                 module.QUALIFICATION_TARGET_PROFILE_POLICY_REFUSED),
            )
        self.assertEqual(envelope["profiles"][0]["id"], "staging-current")

    def test_fixed_registry_refuses_symlink_fifo_empty_and_oversize_sources(self):
        module = self.load_module()

        def symlink_writer(path):
            target = path.with_name("canonical-registry.json")
            target.write_bytes(CURRENT_REGISTRY)
            path.symlink_to(target.name)

        with self.assertRaisesRegex(Exception, f"^{module.QUALIFICATION_TARGET_PROFILE_REFUSED}$"):
            self.load_module(registry_writer=symlink_writer)
        for raw in (b"", b" " * 131_073):
            with self.assertRaisesRegex(Exception, f"^{module.QUALIFICATION_TARGET_PROFILE_REFUSED}$"):
                self.load_module(raw)

        module_path = self.make_layout(registry_writer=lambda path: os.mkfifo(path, 0o600))
        script = (
            "import importlib.util,sys,uuid;"
            "p=sys.argv[1];s=importlib.util.spec_from_file_location('q'+uuid.uuid4().hex,p);"
            "m=importlib.util.module_from_spec(s);"
            "\ntry:s.loader.exec_module(m)\n"
            "except Exception as e:print(str(e));sys.exit(0)\n"
            "sys.exit(2)"
        )
        completed = subprocess.run(
            [sys.executable, "-c", script, str(module_path)],
            check=False,
            capture_output=True,
            text=True,
            timeout=3,
        )
        self.assertEqual(completed.returncode, 0)
        self.assertEqual(completed.stdout.strip(), module.QUALIFICATION_TARGET_PROFILE_REFUSED)
        self.assertEqual(completed.stderr, "")

    @staticmethod
    def thaw(value):
        if hasattr(value, "items"):
            return {key: QualificationTargetProfileTest.thaw(child) for key, child in value.items()}
        if isinstance(value, tuple):
            return [QualificationTargetProfileTest.thaw(child) for child in value]
        return value


if __name__ == "__main__":
    unittest.main()
