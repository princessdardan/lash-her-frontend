"""Security regression tests use synthetic input; no AWS operations are executed."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


HOOK = Path(os.environ.get("LASH_HER_SECRET_HOOK", Path(__file__).with_name("secret-safety-hook.py")))


class SecretSafetyHookTests(unittest.TestCase):
    def check_event(self, tool, args, expected):
        result = subprocess.run(
            [sys.executable, str(HOOK)],
            input=json.dumps({"tool_name": tool, "tool_input": args}),
            text=True, capture_output=True, timeout=3,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        decision = json.loads(result.stdout)["hookSpecificOutput"]["permissionDecision"] if result.stdout else "allow"
        self.assertEqual(decision, expected)

    def test_blocks_cli_variants(self):
        for command in [
            "aws secretsmanager get-secret-value --secret-id synthetic",
            "aws --profile 'Dardan (Lash Her)' secretsmanager get-secret-value --secret-id synthetic",
            "aws --region us-east-1 secretsmanager --output json batch-get-secret-value --secret-id-list synthetic",
            "env AWS_PROFILE=example /usr/bin/aws secretsmanager get-secret-value --secret-id synthetic",
            "echo harmless; aws secretsmanager get-secret-value --secret-id synthetic",
        ]:
            with self.subTest(command=command):
                self.check_event("Bash", {"command": command}, "deny")

    def test_blocks_sdk_and_structured_calls(self):
        for tool, args in [
            ("mcp__aws__use_aws", {"service_name": "secretsmanager", "operation_name": "GetSecretValue"}),
            ("mcp__aws__use_aws", {"service": "secretsmanager", "operation": "batch_get_secret_value"}),
            ("mcp__aws__run_script", {"code": 'await call_boto3(service_name="secretsmanager", operation_name="GetSecretValue")'}),
            ("mcp__aws__run_script", {"code": "client.get_secret_value(SecretId='synthetic')"}),
            ("mcp__aws__run_script", {"code": 'new BatchGetSecretValueCommand({SecretIdList:["synthetic"]})'}),
            ("mcp__aws__call_aws", {"cli_command": "aws secretsmanager get-secret-value --secret-id synthetic"}),
            ("exec", {"code": 'await tools.mcp__aws__run_script({code: \'call_boto3(service_name="secretsmanager", operation_name="GetSecretValue")\'})'}),
            ("exec", {"code": 'await tools.exec_command({cmd:"aws secretsmanager batch-get-secret-value --secret-id-list synthetic"})'}),
            ("exec", {"calls": [{"serviceName": "secretsmanager", "operationName": "GetSecretValue"}]}),
            ("mcp__node_repl__js", {"code": 'client["get_secret_value"]({SecretId:"synthetic"})'}),
            ("Bash", {"command": "python3 -c 'getattr(client, \"get_secret_value\")()'"}),
            ("Bash", {"cmd": "python3 -c 'client.get_secret_value()'"}),
        ]:
            with self.subTest(tool=tool, args=args):
                self.check_event(tool, args, "deny")

    def test_blocks_daemon_variants(self):
        for host in ["localhost", "127.0.0.1", "127.0.0.2", "0.0.0.0", "[::1]", "2130706433"]:
            with self.subTest(host=host):
                self.check_event("Bash", {"command": f"curl http://{host}:2773/secretsmanager/get?secretId=synthetic"}, "deny")
        self.check_event("exec", {"code": 'fetch("http://localhost:2773/secretsmanager%2Fget?secretId=synthetic")'}, "deny")

    def test_allows_safe_operations(self):
        for tool, args in [
            ("Bash", {"command": "aws sts get-caller-identity --profile 'Dardan (Lash Her)'"}),
            ("Bash", {"command": "aws secretsmanager describe-secret --secret-id synthetic"}),
            ("Bash", {"command": "AWS_PROFILE='Dardan (Lash Her)' asm-exec -- psql 'password={{resolve:secretsmanager:synthetic:SecretString:password}}'"}),
            ("Bash", {"command": "rg 'get_secret_value' ops/aws/vendor/aws-secret-safety.py"}),
            ("Bash", {"command": "python3 ops/aws/test_secret_safety_hook.py"}),
            ("mcp__aws__run_script", {"code": 'await call_boto3(service_name="secretsmanager", operation_name="DescribeSecret")'}),
            ("mcp__aws__search_documentation", {"search_phrase": "aws secretsmanager get-secret-value documentation"}),
            ("apply_patch", {"command": "*** Add File: example\n+client.get_secret_value()"}),
            ("exec", {"code": 'await tools.exec_command({cmd:"aws lightsail get-instances"})'}),
        ]:
            with self.subTest(tool=tool, args=args):
                self.check_event(tool, args, "allow")

    def test_invalid_event_returns_explicit_deny(self):
        for payload in ["not json", "null", "{}", '{"tool_name":"Bash"}']:
            with self.subTest(payload=payload):
                result = subprocess.run([sys.executable, str(HOOK)], input=payload, text=True, capture_output=True, timeout=3)
                self.assertEqual(result.returncode, 0)
                self.assertEqual(json.loads(result.stdout)["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_missing_policy_dependency_returns_explicit_deny(self):
        with tempfile.TemporaryDirectory() as directory:
            isolated = Path(directory) / "hook.py"
            isolated.write_bytes(HOOK.read_bytes())
            result = subprocess.run(
                [sys.executable, str(isolated)],
                input=json.dumps({"tool_name": "Bash", "tool_input": {"command": "aws sts get-caller-identity"}}),
                text=True, capture_output=True, timeout=3,
            )
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stderr, "")
            self.assertEqual(json.loads(result.stdout)["hookSpecificOutput"]["permissionDecision"], "deny")


if __name__ == "__main__":
    unittest.main()
