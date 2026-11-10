"""Whole helper positive/forged-closure tests with actual source reducer output."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(root / "ops/platform/host"))
import frontend_resend_marketing_scope as scope
import frontend_resend_marketing_scope_test as fixture

path = Path(sys.argv[1]); owned = json.loads(path.read_text())
assert owned["ownedFixtureOnly"] is True and owned["providerCalls"] == owned["sqlCalls"] == 0
source = owned["requirements"]
rows = fixture.empty()
review = fixture.reviewed(rows)
review.update(sourceCommit=source["sourceCommit"], surfaceSha256=source["surfaceSha256"],
    sourceInventorySha256=source["sourceInventorySha256"], requirementsSha256=source["requirementsSha256"],
    configurationSha256=source["configurationRecordSha256"])
positive = scope.observe_scoped_effects(None, review, rows, source, rows)
assert positive["complete"] and not positive["providerRequestsRequired"] and positive["disposition"] == "source-inapplicable-and-effects-reconciled"
global_ids = {row["requirementId"] for row in source["sqlCredentialRequirements"]}
assert global_ids <= set(positive["coveredRequirementIds"])
checks = ["actual-source-reducer-whole-helper-positive", "global-sql-requirements-in-positive-receipt"]

def refuse(name, altered, selected=review, actual=rows):
    try:
        scope.observe_scoped_effects(None, selected, actual, altered)
    except ValueError:
        checks.append(name)
        return
    raise AssertionError("FORGED_CLOSURE_WAS_ACCEPTED:" + name)

own_index = next(i for i, row in enumerate(source["capabilityClosures"]) if row["familyId"] == "resend.broadcasts")
for sql_id in sorted(global_ids):
    bad = deepcopy(source); bad["capabilityClosures"][own_index]["requirementIds"].remove(sql_id)
    refuse("missing-global:" + sql_id, bad)
bad = deepcopy(source); bad["capabilityClosures"][own_index]["disposition"] = "absent-from-verified-source"; refuse("forged-source-absence", bad)
for key, value in (("sourceCommit", "0" * 40), ("surfaceSha256", "0" * 64), ("configurationRecordSha256", "0" * 64), ("provenanceSha256", "0" * 64)):
    bad = deepcopy(source); bad["capabilityClosures"][own_index][key] = value; refuse("forged-closure-" + key, bad)
for key, value in (("sourceCommit", "0" * 40), ("surfaceSha256", "0" * 64), ("configurationRecordSha256", "0" * 64)):
    bad = deepcopy(source); bad[key] = value; refuse("wrong-source-wrapper-" + key, bad)
bad = deepcopy(source); bad["capabilityClosures"].append(deepcopy(bad["capabilityClosures"][own_index])); refuse("duplicate-family", bad)
bad = deepcopy(source); bad["capabilityClosures"][own_index]["evidenceIds"].reverse(); refuse("noncanonical-evidence", bad)

class OwnedProvider:
    def __init__(self): self.calls = []
    def request(self, method, path, body=None):
        assert method == "GET" and body is None
        self.calls.append(path)
        if path == "/contacts?limit=100": return {"object": "list", "has_more": False, "data": []}
        if path == "/broadcasts?limit=100": return {"object": "list", "has_more": False, "data": [{"id": fixture.BROADCAST, "status": "draft"}]}
        if path == "/broadcasts/" + fixture.BROADCAST: return {"id": fixture.BROADCAST, "name": "campaign:" + fixture.CAMPAIGN, "segment_id": fixture.SEGMENT, "status": "draft"}
        raise AssertionError("OWNED_UNEXPECTED_REQUEST")

partial = deepcopy(source); partial["capabilityClosures"] = [partial["capabilityClosures"][own_index]]
actual = fixture.empty(); actual["campaigns"] = [{"id": fixture.CAMPAIGN, "status": "sent", "provider_broadcast_id": fixture.BROADCAST,
    "provider_segment_id": fixture.SEGMENT, "scheduled_at": None, "sent_at": fixture.TIME, "updated_at": fixture.TIME}]
selected = dict(review, databaseSnapshotSha256=scope.snapshot_sha256(actual)); provider = OwnedProvider()
observed = scope.observe_scoped_effects(provider, selected, actual, partial)
family = next(row for row in observed["families"] if row["familyId"] == "resend.broadcasts")
assert not observed["complete"] and family["sourceClosureContradiction"] and family["unresolvedEffects"] > 0 and family["missingRequirementIds"] and not family["coveredRequirementIds"]
checks.append("actual-source-partial-closure-cannot-erase-broadcast-contradiction")
print(json.dumps({"kind": "actual-source-context-whole-helper-check", "passed": len(checks), "checks": checks,
    "sourceContextSha256": hashlib.sha256(path.read_bytes()).hexdigest(), "sourceModuleSha256": owned["sourceModuleSha256"],
    "sourceCommit": source["sourceCommit"], "sourceInventorySha256": source["sourceInventorySha256"], "requirementsSha256": source["requirementsSha256"],
    "actualSourceGetterPrepareCollectorReducerExecuted": True, "ownedOriginalKeyCatalogEmpty": True,
    "configuredSqlPeers": 0, "actualDomainPostgresChecks": "separate owned 83-migration suite",
    "liveProviderCalls": 0, "positiveProviderRequests": 0, "contradictionProviderResponses": "owned-memory-only",
    "positiveCoveredRequirementCount": len(positive["coveredRequirementIds"]), "sqlRequirements": len(global_ids),
    "helperSha256": hashlib.sha256((root / "ops/platform/host/frontend_resend_marketing_scope.py").read_bytes()).hexdigest()}, indent=2))
