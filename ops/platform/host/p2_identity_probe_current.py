#!/usr/bin/env python3
"""Fixed pinned-source SSH entry: plan by default, private packet on stdin."""
import base64
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import p2_identity_negative_probe as probe


def main():
    try:
        raw = sys.stdin.buffer.read(262_145)
        probe.demand(0 < len(raw) <= 262_144, "P2_IDENTITY_PACKET_BOUND")
        value = json.loads(raw)
        probe.demand(probe._closed(value, ("version", "operation", "bundleDirectory", "configurationDirectory", "reviewed", "priorEvidence")) and
            value["version"] == 1 and value["operation"] in ("plan", "execute-current-readonly"), "P2_IDENTITY_FIXED_OPERATION_REQUIRED")
        source = Path(__file__).resolve().parents[3]
        if value["operation"] == "plan":
            probe.demand(value["priorEvidence"] is None, "P2_IDENTITY_PLAN_NO_PRIVATE_PAYLOAD_REQUIRED")
            result = probe.make_plan(Path(value["bundleDirectory"]), Path(value["configurationDirectory"]), value["reviewed"], source)[0]
        else:
            probe.demand(probe._closed(value["priorEvidence"], ("originalReleaseReceipt", "frontendDeploymentRecord")),
                "P2_IDENTITY_ORIGINAL_EVIDENCE_BYTES_REQUIRED")
            evidence = {name: base64.b64decode(raw, validate=True) for name, raw in value["priorEvidence"].items()}
            result = probe.execute_current_stage(value["bundleDirectory"], value["configurationDirectory"], value["reviewed"], source, evidence)
        sys.stdout.write(json.dumps(result) + "\n")
    except BaseException as failure:
        result = failure.public_receipt if isinstance(failure, probe.NegativeProbeFailure) else {
            "version": 1, "status": "P2_STAGING_IDENTITY_NEGATIVE_PROBES_FAILED", "check": "current-stage-packet-refused",
            "readOnly": True, "oidcVerified": False, "releaseAccepted": False}
        sys.stdout.write(json.dumps(result) + "\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
