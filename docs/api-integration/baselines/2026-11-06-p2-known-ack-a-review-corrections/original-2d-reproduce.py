import copy
import json
import sys
import threading
from unittest.mock import Mock

sys.path.insert(0, "/Users/dardan/workspace/lash-her-frontend/.worktrees/phase2-known-ack-loss/ops/platform/host")
import p2_known_ack_loss as source
from p2_known_ack_loss_test import fixture


plan, baseline, domain, gateway, effects = fixture()
extra = copy.deepcopy(domain["frontend"]["operations"][1])
extra.update(
    id="00000000-0000-4000-8000-000000000099",
    started_at="2026-11-06T01:00:03.000Z",
    completed_at="2026-11-06T01:00:05.000Z",
)
domain["frontend"]["operations"].append(extra)
domain_result = source.validate_domain(plan, baseline, domain, gateway, effects)
artifact = {
    "observations": [
        {
            "admittedLogLine": json.dumps({"operationId": row["id"]}),
            "httpStatus": 503 if row["state"] == "uncertain" else 200,
        }
        for row in domain["frontend"]["operations"]
    ]
}
source.validate_request_operations(plan, artifact, domain["frontend"]["operations"])
before = copy.deepcopy(domain)
before["frontend"]["admission"].update(epoch="4", recovery=False)
after = copy.deepcopy(before)
operation_id = before["frontend"]["operations"][0]["id"]
after["frontend"]["admission"]["uncertain"] = 0
after["frontend"]["operations"][0].update(
    state="completed",
    completed_at="2026-11-06T01:00:06.000Z",
    reconciliation_sha256="e" * 64,
)
source.validate_settled(plan, before, after, operation_id, "e" * 64)

scope = object()
recorder = Mock()
recorder.scope = scope
barrier = threading.Barrier(2)
recorder._verify_authorization.side_effect = lambda _record: barrier.wait(timeout=2)
capability = source.KnownAckLossRecoveryAuthorization(
    source._ISSUER, recorder, {"recoveryActionId": "owned-replacement"}
)
consumes = []


def consume():
    try:
        source.consume_known_ack_loss_authorization(
            capability, scope, "owned-replacement"
        )
        consumes.append("accepted")
    except ValueError:
        consumes.append("refused")


threads = [threading.Thread(target=consume) for _ in range(2)]
for thread in threads:
    thread.start()
for thread in threads:
    thread.join()

print(
    json.dumps(
        {
            "extraOperation": {
                "domainAccepted": domain_result is not None,
                "requestCountAccepted": len(artifact["observations"]),
                "settlementOperationCountAccepted": len(
                    after["frontend"]["operations"]
                ),
            },
            "concurrentCapabilityConsumes": sorted(consumes),
        },
        sort_keys=True,
    )
)
