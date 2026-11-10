#!/usr/bin/env python3
"""Fixed pinned-source SSH entry: plan by default, private packet on stdin."""
import base64
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import p2_identity_negative_probe as probe


def main():
    expected_profile = None
    try:
        raw = sys.stdin.buffer.read(262_145)
        probe.demand(0 < len(raw) <= 262_144, "P2_IDENTITY_PACKET_BOUND")
        value = json.loads(raw)
        fields = ("version", "operation", "bundleDirectory", "configurationDirectory", "reviewed", "priorEvidence")
        if probe._closed(value, (*fields, "resultsDirectory", "qualificationTargetProfile")) and type(value["version"]) is int and value["version"] == 2:
            from p2_certification_parent import _profiled_context
            from qualification_target_profile import decode_qualification_target_json
            value = decode_qualification_target_json(raw, "carrier")
            selected = _profiled_context()
            probe.demand(value["qualificationTargetProfile"] == selected and
                value["operation"] in ("plan-replacement", "execute-replacement-readonly") and
                all(type(value[name]) is str and Path(value[name]).is_absolute() and ".." not in Path(value[name]).parts
                    for name in ("bundleDirectory", "configurationDirectory", "resultsDirectory")), "P2_IDENTITY_FIXED_OPERATION_REQUIRED")
            expected_profile = selected
        else:
            probe.demand(probe._closed(value, fields) and type(value["version"]) is int and value["version"] == 1 and
                value["operation"] in ("plan", "execute-current-readonly"), "P2_IDENTITY_FIXED_OPERATION_REQUIRED")
        source = Path(__file__).resolve().parents[3]
        if value["operation"] in ("plan", "plan-replacement"):
            probe.demand(value["priorEvidence"] is None, "P2_IDENTITY_PLAN_NO_PRIVATE_PAYLOAD_REQUIRED")
            profile = {} if expected_profile is None else {"expected_profile": expected_profile}
            result = probe.make_plan(Path(value["bundleDirectory"]), Path(value["configurationDirectory"]), value["reviewed"], source, **profile)[0]
        else:
            probe.demand(probe._closed(value["priorEvidence"], ("originalReleaseReceipt", "frontendDeploymentRecord")),
                "P2_IDENTITY_ORIGINAL_EVIDENCE_BYTES_REQUIRED")
            evidence = {name: base64.b64decode(raw, validate=True) for name, raw in value["priorEvidence"].items()}
            if expected_profile is None:
                result = probe.execute_current_stage(value["bundleDirectory"], value["configurationDirectory"], value["reviewed"], source, evidence)
            else:
                result = probe.execute_replacement_stage(value["bundleDirectory"], value["configurationDirectory"], value["resultsDirectory"],
                    value["reviewed"], source, evidence)
        sys.stdout.write(json.dumps(result) + "\n")
    except BaseException as failure:
        result = failure.public_receipt if isinstance(failure, probe.NegativeProbeFailure) else {
            "version": 1, "status": "P2_STAGING_IDENTITY_NEGATIVE_PROBES_FAILED", "check": "current-stage-packet-refused",
            "readOnly": True, "oidcVerified": False, "releaseAccepted": False}
        if expected_profile is not None:
            result = {**result, "version": 2, "qualificationTargetProfile": expected_profile}
        sys.stdout.write(json.dumps(result) + "\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
