#!/usr/bin/env python3
"""Reproduce seven retained-chain false acceptances from exact C commit 269a7d3b.

Pure loader exercise only: no database, provider, network, Docker, host, or Git
working-tree source is used. The exact committed repository is extracted into a
temporary directory before imports.
"""
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile

REPOSITORY = Path("/Users/dardan/workspace/lash-her-frontend/.worktrees/phase2-known-ack-interrupted-restoration")
C_COMMIT = "269a7d3b5f07f6b6925dd787b4234b037e1f70f2"
C_HELPER = "ops/platform/host/p2_known_ack_interrupted_restoration.py"
C_HELPER_SHA256 = "dea9949abea601c0df4dab93b9f6e1e7ed785362b864e18ffb89be2e83f681d7"
B_HELPER = "ops/platform/host/p2_known_ack_loss.py"
B_HELPER_SHA256 = "445fe8aba68bb4e708e4777c936466f6c5fd54b5500f7160664cf43cd1ddf3db"
CASES = ("mode", "action", "extra", "native-sha", "intent-version", "gateway-digest", "runtime-digest")


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def committed(path):
    return subprocess.check_output([
        "git", "--no-replace-objects", "-C", str(REPOSITORY), "show", f"{C_COMMIT}:{path}"
    ])


def repin_and_load(test, source, kind):
    plan = test.values["baseline.json"]["plan"]
    if kind == "mode":
        plan["mode"] = "before-upstream"
    elif kind == "action":
        plan["nativePlan"]["commandWitnesses"][0]["action"] = "restore"
    elif kind == "extra":
        plan["nativePlan"]["commandWitnesses"].append(copy.deepcopy(plan["nativePlan"]["commandWitnesses"][0]))
    elif kind == "native-sha":
        plan["nativePlanSha256"] = "e" * 64
    elif kind == "intent-version":
        test.values["recovery-intent.json"]["intent"]["version"] = 2
    elif kind == "gateway-digest":
        test.values["recovery-intent.json"]["intent"]["gatewayProcessSha256"] = "e" * 64
    elif kind == "runtime-digest":
        test.values["recovery-intent.json"]["intent"]["runtimeInventorySha256"] = "e" * 64
    else:
        raise AssertionError("unknown fixed case")

    intent = test.values["recovery-intent.json"]
    intent["intentSha256"] = source.sha(source.canonical(intent["intent"]))
    test.values["replacement-authorization.json"]["recoveryIntentSha256"] = intent["intentSha256"]
    pins = test.selection["causalReceiptSha256"]
    for name in ("recovery-intent.json", "baseline.json", "domain.json", "request-details.json"):
        pins[name] = test.write(name, test.values[name])
    settlement = test.values["settlement.json"]
    settlement.update(
        baselineSha256=pins["baseline.json"],
        domainSha256=pins["domain.json"],
        requestDetailsSha256=pins["request-details.json"],
    )
    pins["settlement.json"] = test.write("settlement.json", settlement)
    authorization = test.values["replacement-authorization.json"]
    authorization.update(
        baselineSha256=pins["baseline.json"],
        domainSha256=pins["domain.json"],
        requestDetailsSha256=pins["request-details.json"],
        settlementSha256=pins["settlement.json"],
    )
    pins["replacement-authorization.json"] = test.write("replacement-authorization.json", authorization)
    replacement_path = test.replacement / "known-ack-replacement-intent.json"
    replacement = json.loads(replacement_path.read_bytes())
    replacement["authorization"] = authorization
    replacement["recoveryIntent"] = intent
    raw = source.canonical(replacement) + b"\n"
    replacement_path.write_bytes(raw)
    test.selection["replacementReceiptSha256"]["known-ack-replacement-intent.json"] = source.sha(raw)
    test.load()


def main():
    c_raw, b_raw = committed(C_HELPER), committed(B_HELPER)
    assert sha256(c_raw) == C_HELPER_SHA256
    assert sha256(b_raw) == B_HELPER_SHA256
    with tempfile.TemporaryDirectory(prefix="p2-c-original269-") as selected:
        archive = subprocess.check_output([
            "git", "--no-replace-objects", "-C", str(REPOSITORY), "archive", C_COMMIT
        ])
        subprocess.run(["tar", "-xf", "-", "-C", selected], input=archive, check=True)
        root = Path(selected)
        assert sha256((root / C_HELPER).read_bytes()) == C_HELPER_SHA256
        assert sha256((root / B_HELPER).read_bytes()) == B_HELPER_SHA256
        sys.path.insert(0, str(root / "ops/platform/host"))
        import p2_known_ack_interrupted_restoration as source
        from p2_known_ack_interrupted_restoration_test import RetainedChainTests

        results = {}
        for kind in CASES:
            test = RetainedChainTests()
            test.setUp()
            try:
                repin_and_load(test, source, kind)
                results[kind] = "ACCEPTED"
            except BaseException as error:
                results[kind] = "REFUSED:" + str(error)
            finally:
                test.doCleanups()
    value = {
        "version": 1,
        "status": "P2_INTERRUPTED_ORIGINAL_269_RETAINED_CHAIN_REPRO",
        "cCommit": C_COMMIT,
        "cHelperSha256": C_HELPER_SHA256,
        "bHelperSha256": B_HELPER_SHA256,
        "pureLoaderOnly": True,
        "hostProviderDatabaseTouched": False,
        "results": results,
    }
    assert set(results.values()) == {"ACCEPTED"}
    print(json.dumps(value, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
