#!/usr/bin/env python3
"""Adapt the pinned AWS secret-safety hook to Codex's nested tool inputs.

This is a best-effort PreToolUse guard, not a sandbox or an IAM boundary.
It never executes the submitted command, fetches a secret, or logs input.
"""

import io
import json
import re
import runpy
import shlex
import sys
import urllib.parse
from pathlib import Path


BLOCK_REASON = (
    "Direct AWS Secrets Manager retrieval is blocked. Use "
    "{{resolve:secretsmanager:secret-id:SecretString:key}} with asm-exec."
)
OPERATION = r"(?:batch[-_]?)?get[-_]?secret[-_]?value"
OPERATION_ARGUMENT = re.compile(
    r"(?:[\"']?(?:operation_name|operationName|operation)[\"']?\s*[:=]\s*)"
    r"[\"']" + OPERATION + r"[\"']",
    re.IGNORECASE,
)
REFLECTED_CALL = re.compile(
    r"(?:getattr\s*\([^,]+,\s*|\[\s*)[\"']" + OPERATION + r"[\"']",
    re.IGNORECASE,
)
DAEMON_URL = re.compile(
    r"(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[?::1\]?|"
    r"2130706433|0x7f000001):2773/secretsmanager/get",
    re.IGNORECASE,
)
EXECUTION_TOOL = re.compile(
    r"(?:^Bash$|exec|run_script|use_aws|^mcp__|node_repl|python)",
    re.IGNORECASE,
)
NON_EXECUTING_TOOL = re.compile(
    r"(?:^apply_patch$|search_documentation$|read_documentation$|retrieve_skill$|"
    r"search_openai_docs$|fetch_openai_doc$)",
    re.IGNORECASE,
)


def normalize(value):
    return re.sub(r"[-_]", "", str(value)).lower()


def walk(value):
    yield value
    if isinstance(value, dict):
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def cli_fetch(text):
    """Handle quoted profile names, which the upstream whitespace regex misses."""
    try:
        tokens = shlex.split(text)
    except ValueError:
        return False
    for index, token in enumerate(tokens):
        if token.rsplit("/", 1)[-1] != "aws":
            continue
        tail = tokens[index + 1:index + 65]
        if "secretsmanager" not in tail:
            continue
        service_index = tail.index("secretsmanager")
        if any(normalize(x) in ("getsecretvalue", "batchgetsecretvalue")
               for x in tail[service_index + 1:]):
            return True
    return False


def blocked(event, upstream):
    name = event["tool_name"]
    if NON_EXECUTING_TOOL.search(name):
        return False
    if not EXECUTION_TOOL.search(name):
        return False
    if "secretsmanager" in normalize(name) and re.search(OPERATION, name, re.I):
        return True
    for item in walk(event["tool_input"]):
        if isinstance(item, dict):
            fields = {normalize(k): v for k, v in item.items()}
            operation = fields.get("operationname", fields.get("operation", ""))
            if normalize(operation) in upstream["GSV_OPERATIONS"]:
                return True
        if not isinstance(item, str):
            continue
        # Nested JS/MCP scripts can contain escaped quotes inside a string.
        text = re.sub(r"\\([\"'])", r"\1", item)
        if upstream["CLI_GSV_PATTERN"].search(text) or cli_fetch(text):
            return True
        if DAEMON_URL.search(urllib.parse.unquote(text)):
            return True
        if OPERATION_ARGUMENT.search(text) or REFLECTED_CALL.search(text):
            return True
        if upstream["SDK_CALL_PATTERN"].search(text):
            # Keep a simple documentation search/read mentioning a method usable.
            if name == "Bash" and upstream["_is_read_only_command"](text):
                if not upstream["_COMPOUND_OPERATORS_RE"].search(text):
                    continue
            return True
    return False


def deny(reason):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}))


def main():
    try:
        event = json.load(sys.stdin)
        if not isinstance(event, dict) or not isinstance(event.get("tool_name"), str):
            raise ValueError("invalid hook event")
        if "tool_input" not in event:
            raise ValueError("missing tool input")
        upstream = runpy.run_path(str(Path(__file__).parent / "vendor/aws-secret-safety.py"))
        if blocked(event, upstream):
            deny(BLOCK_REASON)
            return
        # Keep the upstream Bash policy for supported native shell inputs too.
        if event["tool_name"] == "Bash" and isinstance(event["tool_input"], dict):
            args = event["tool_input"]
            command = args.get("command", args.get("cmd", ""))
            if isinstance(command, str):
                sys.stdin = io.StringIO(json.dumps({
                    "tool_name": "Bash", "tool_input": {"command": command}
                }))
                upstream["main"]()
    except Exception:
        # A non-zero hook error can fail open in Codex. Return an explicit deny.
        deny("AWS secret-safety hook could not validate the tool input; execution blocked.")


if __name__ == "__main__":
    main()
