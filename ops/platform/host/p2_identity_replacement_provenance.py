"""Read-only replacement release and successor joins for S06."""
import base64
from pathlib import Path
import re

import migrate
from p2_identity_probe_scope import _replacement_profile
import staging_state

demand = migrate.demand


def require_replacement_identity_provenance(bundle, configuration, results, source, selected, jobs, reviewed, prior_evidence):
    """Rejoin the immutable replacement guardian and optional successor without touching live state."""
    import p2_prior_gateway as prior
    from p2_certification_parent import _profiled_replacement_original_terminal
    from p2_frontend_replacement_parent import private_record, RUNTIME_REVIEW
    from p2_replacement_successor import require_successor_runtime_provenance
    from p2_replacement_terminal import TERMINAL, TERMINAL_STATUS, exact_receipt
    from qualification_target_profile import decode_qualification_target_json

    refused = "P2_IDENTITY_REPLACEMENT_PROVENANCE_REFUSED"
    expected = _replacement_profile()
    bundle, configuration, results, source = (Path(value) for value in (bundle, configuration, results, source))
    demand(all(path.is_absolute() and path == path.resolve() and prior.ROOT in path.parents
        for path in (bundle, configuration, results)), refused)
    for path in (bundle, configuration, results):
        staging_state.outside_checkout(path)
    migrate.candidate_profile(selected, expected)
    migrate.require_profile(expected, reviewed)
    demand(type(reviewed.get("version")) is int and reviewed["version"] == 2 and
        selected["environment"] == "staging" and selected["releaseId"] == reviewed["releaseId"] != reviewed["probeId"] and
        migrate.profiled_current_job_hashes(bundle) == reviewed["apiJobSha256"], refused)
    release_id = selected["releaseId"]
    demand(type(release_id) is str and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", release_id) is not None, refused)
    guardian = results / ("p2-profiled-replacement-write-" + release_id)
    original_mount = results / ("runtime-profiled-frontend-replacement-" + release_id) / "configuration"
    demand(guardian == guardian.resolve() and original_mount == original_mount.resolve(), refused)
    staging_state.outside_checkout(guardian)
    configuration_hashes = staging_state.configuration_hashes(original_mount)
    from p2_identity_negative_probe import _canonical
    demand(migrate.file_hash(_canonical(configuration_hashes)) == reviewed["configurationSha256"] and
        staging_state.configuration_hashes(configuration) == configuration_hashes, refused)

    pins = reviewed["priorEvidence"]
    demand(type(prior_evidence) is dict and set(prior_evidence) == {"originalReleaseReceipt", "frontendDeploymentRecord"}, refused)
    for key, value in prior_evidence.items():
        demand(type(value) is bytes and 0 < len(value) <= 65_536 and
            migrate.file_hash(value) == pins[key + "Sha256"], refused)
    raw_terminal = private_record(guardian, TERMINAL)
    raw_promotion = private_record(guardian, "frontend-promotion-outcome.json")
    demand(raw_terminal == prior_evidence["originalReleaseReceipt"] and
        raw_promotion == prior_evidence["frontendDeploymentRecord"], refused)
    terminal = exact_receipt(raw_terminal)
    demand(terminal["status"] == TERMINAL_STATUS and terminal["releaseId"] == release_id and
        terminal["frontendPromotionReceiptSha256"] == pins["frontendDeploymentRecordSha256"], refused)
    runtime_review = decode_qualification_target_json(private_record(guardian, RUNTIME_REVIEW), "carrier")
    migrate.require_profile(expected, runtime_review)
    frontend = jobs["frontend"]
    initial = {"qualificationTargetProfile": expected, "environment": "staging", "bundle": str(bundle), "results": str(results),
        "configuration": str(original_mount), "hostMachineId": reviewed["hostMachineId"], "apiJobSha256": reviewed["apiJobSha256"],
        "configurationSha256": configuration_hashes, "candidateSha256": reviewed["candidateSha256"], "targetSha256": reviewed["targetSha256"],
        "sourceCommit": reviewed["sources"]["frontend"], "sourceSha256": reviewed["operatorSourceFiles"],
        "certification": runtime_review["certification"],
        "owner": terminal["owner"], "frontendJob": frontend["job"],
        "frontendBaseline": decode_qualification_target_json(frontend["schema"], "carrier"),
        "originalReleaseReceipt": base64.b64encode(raw_terminal).decode()}
    plan = {"environment": "staging", "originalReleaseId": release_id, "replacementRelease": reviewed["replacementRelease"],
        "sourceCommit": initial["sourceCommit"], "targetSha256": initial["targetSha256"], "candidateSha256": initial["candidateSha256"],
        "originalReleaseReceiptSha256": pins["originalReleaseReceiptSha256"], "originalReleasePlanSha256": pins["originalReleasePlanSha256"],
        "nativePlan": {"owner": terminal["owner"], "deploymentId": terminal["deploymentId"],
                       "producer": {"producerSha256": terminal["producerSha256"], "role": terminal["runtime"]}},
        "readyReceiptSha256": {"frontend-workload-outcome.json": terminal["frontendWorkloadReceiptSha256"],
                              "frontend-promotion-outcome.json": pins["frontendDeploymentRecordSha256"]}}
    demand(_profiled_replacement_original_terminal(initial, plan, selected, results, expected, source=source) ==
        (pins["originalReleaseReceiptSha256"], True), refused)
    binding = reviewed["successorRuntime"]
    if binding is None:
        demand(configuration == original_mount, refused)
    else:
        demand(reviewed["probeId"] not in (binding["actionId"], binding["runtimeActionId"]), refused)
        plan.update(successorRuntime=binding, configurationCanonicalSha256=reviewed["configurationSha256"],
                    runtimeInventorySha256=reviewed["runtimeInventorySha256"], gatewayProcessSha256=reviewed["gatewayProcessSha256"])
        mount, _retained_epoch = require_successor_runtime_provenance(initial, plan, selected, results, source, expected)
        demand(configuration == mount, refused)
    return configuration
