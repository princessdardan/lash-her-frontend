"""Explicit frozen-helper + actual source-manifest repro; owned responses only."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

helper, manifest = map(Path, sys.argv[1:3])
root = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(root / "ops/platform/host"))
import frontend_resend_marketing_scope_test as fixture
spec = importlib.util.spec_from_file_location("frozen_resend_scope", helper)
scope = importlib.util.module_from_spec(spec); spec.loader.exec_module(scope)
actual_source = json.loads(manifest.read_text())
assert actual_source["status"] == "FRONTEND_HISTORICAL_SOURCE_VERIFIED"
source = json.loads(json.dumps(actual_source))
# Deliberately forged caller closure context, never an actual capability proof.
source.update(surfaceSha256="e" * 64, configurationRecordSha256="d" * 64, provenanceSha256="f" * 64)

def ids(family):
    return [row["requirementId"] for key in ("configurationConditions", "sqlIntentRequirements", "untrackedPotentialRequests") for row in family[key]]

def closure(family, sql=True, disposition="no-capability-observed"):
    required = ids(family) + ([row["requirementId"] for row in source["sqlCredentialRequirements"]] if sql else [])
    return {"familyId": family["familyId"], "disposition": disposition, "requirementIds": sorted(set(required)), "evidenceIds": ["e" * 64]}

class OwnedProvider:
    def __init__(self): self.calls = 0
    def request(self, method, path, body=None):
        assert method == "GET" and body is None
        self.calls += 1
        if path == "/broadcasts?limit=100": return {"object": "list", "has_more": False, "data": [{"id": fixture.BROADCAST, "status": "draft"}]}
        if path == "/broadcasts/" + fixture.BROADCAST: return {"id": fixture.BROADCAST, "name": "campaign:" + fixture.CAMPAIGN, "segment_id": fixture.SEGMENT, "status": "draft"}
        if path == "/contacts?limit=100": return {"object": "list", "has_more": False, "data": []}
        raise AssertionError("OWNED_REPRO_UNEXPECTED_REQUEST")

families = [row for row in source["providerFamilies"] if row["familyId"] in scope.FAMILIES]
rows = fixture.empty()
reviewed = fixture.reviewed(rows)
reviewed.update(sourceCommit=source["sourceCommit"], surfaceSha256=source["surfaceSha256"], sourceInventorySha256=source["sourceInventorySha256"], requirementsSha256=source["requirementsSha256"])
source["capabilityClosures"] = [closure(family, sql=False) for family in families]
missing_sql = scope.observe_scoped_effects(None, reviewed, rows, source)
source["capabilityClosures"] = [closure(family, disposition="absent-from-verified-source") for family in families]
wrong_absence = scope.observe_scoped_effects(None, reviewed, rows, source)
rows["campaigns"] = [{"id": fixture.CAMPAIGN, "status": "sent", "provider_broadcast_id": fixture.BROADCAST,
    "provider_segment_id": fixture.SEGMENT, "scheduled_at": None, "sent_at": fixture.TIME, "updated_at": fixture.TIME}]
reviewed["databaseSnapshotSha256"] = scope.snapshot_sha256(rows)
source["capabilityClosures"] = [closure(next(row for row in families if row["familyId"] == "resend.broadcasts"))]
provider = OwnedProvider()
contradictory = scope.observe_scoped_effects(provider, reviewed, rows, source)
family = next(row for row in contradictory["families"] if row["familyId"] == "resend.broadcasts")
result = {"kind": "frozen-source-reproduction", "frozenHelperSha256": hashlib.sha256(helper.read_bytes()).hexdigest(),
    "actualVerifiedSourceManifestSha256": hashlib.sha256(manifest.read_bytes()).hexdigest(), "sourceCommit": source["sourceCommit"],
    "sourceInventorySha256": source["sourceInventorySha256"], "requirementsSha256": source["requirementsSha256"],
    "callerClosureContextIsDeliberatelyForged": True, "providerResponses": "owned-memory-only", "liveCalls": 0,
    "missingGlobalSqlIdsErroneouslyCompletes": missing_sql["complete"],
    "reachableSourceWrongAbsenceErroneouslyCompletes": wrong_absence["complete"],
    "contradictoryBroadcastErroneouslyFamilyComplete": family["unresolvedEffects"] == 0 and bool(family["coveredRequirementIds"]),
    "ownedProviderReadCount": provider.calls}
assert all(result[key] for key in ("missingGlobalSqlIdsErroneouslyCompletes", "reachableSourceWrongAbsenceErroneouslyCompletes", "contradictoryBroadcastErroneouslyFamilyComplete"))
print(json.dumps(result, indent=2))
