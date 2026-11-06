"""Owned actual-source interface check; input is source function output, not live evidence."""
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[4] / "ops/platform/host"))
import frontend_highlevel_history as history
context = json.loads(Path(sys.argv[1]).read_text())
source = context["requirements"]
assert context["ownedFixtureOnly"] is True and context["providerCalls"] == context["sqlCalls"] == 0
rows = {name: ([{"contacts": 0, "effects": 0, "connections": 0, "webhooks": 0}]
    if name == "historyGlobalScope" else []) for name in history.COLUMNS}
reviewed = {"environment": "staging", "sourceBindingSha256": source["configurationRecordSha256"],
    "historicalSourceCommit": source["sourceCommit"], "historyDatabaseSnapshotSha256": history.snapshot_sha256(rows)}
result = history.observe_scoped_effects(None, reviewed, rows, source)
assert (result["activeExecutions"], result["uncertainEffects"]) == (0, 0)
assert len(history.database_queries(reviewed)) == 9
assert all(sql.rstrip().endswith("LIMIT 4097") for _, sql, _ in history.database_queries(reviewed))
print(json.dumps({"status": "ACTUAL_C07_SOURCE_PIPELINE_HIGHLEVEL_COMPATIBILITY_PASS", "ownedFixtureOnly": True,
    "sourceModuleSha256": context["sourceModuleSha256"], "coveredRequirementIds": result["coveredRequirementIds"],
    "providerCalls": 0, "sqlCalls": 0, "fabricatedPrincipals": False}, sort_keys=True))
