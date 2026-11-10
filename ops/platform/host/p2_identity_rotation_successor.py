"""Guardian evidence for the exact mixed runtime left by managed S06 rotation."""
import base64
import json
from pathlib import Path
import re
import stat
import subprocess
import time
from types import SimpleNamespace

import migrate
import p2_canonical_browser_origin as canonical_origin
import p2_prior_gateway as prior
import release as runtime
import staging_state
from p2_certification_fault import GATEWAY_OBSERVER, MODULE as FAULT_MODULE
from p2_frontend_replacement_parent import private_record
from p2_identity_key_rotation_adapter import API_SERVICES, P2IdentityRotationHostAdapter, _phase_hash, _runtime_phase_hash
from p2_replacement_terminal import TERMINAL as REPLACEMENT_TERMINAL
from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE, decode_qualification_target_json


RECEIPT = "p2-identity-rotation-successor-runtime.json"
STATUS = "P2_IDENTITY_ROTATION_MIXED_SUCCESSOR_RUNTIME_VERIFIED"
INVENTORY_STATUS = "P2_ROTATION_RUNTIME_INVENTORY_RETAINED"
PHASES = ("baseline", "overlap", "current-only")
MUTATIONS = (("overlap", "api"), ("overlap", "frontend"), ("current-only", "frontend"), ("current-only", "api"))
IDENTITY_FIELDS = ("actionId", "bindingSha256", "sourceCommit", "candidateSha256")
REFUSED = "P2_ROTATION_MIXED_SUCCESSOR_REFUSED"
require = migrate.demand


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


def _digest(value):
    return type(value) is str and re.fullmatch(r"(?!0+$)[a-f0-9]{64}", value) is not None


def _epoch(value):
    return type(value) is str and re.fullmatch(r"[1-9][0-9]{0,17}", value) is not None


def _private(path):
    require(path.is_absolute() and path == path.resolve() and prior.ROOT in path.parents, REFUSED)
    staging_state.outside_checkout(path)


def _directory(initial):
    action = initial["rotationActionId"]
    require(type(action) is str and re.fullmatch(r"p2-key-rotation-[a-z0-9-]{1,40}", action), REFUSED)
    directory = Path(initial["results"]) / ("p2-identity-key-rotation-" + action)
    _private(directory)
    return directory


def _identity(initial):
    selected, plan, custody = initial["candidate"], initial["rotationPlan"], initial["frontendCustody"]
    review = custody["certificationPlan"]
    expected = migrate.profile_context(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)
    migrate.candidate_profile(selected, expected)
    migrate.require_profile(expected, initial, custody, review)
    require(type(initial.get("version")) is int and initial["version"] == 2 and
            initial.get("mode") == "p2-identity-key-rotation" and
            selected["environment"] == initial["environment"] == plan["environment"] == custody["environment"] == "staging" and
            all(initial[key] == custody[key] for key in ("results", "configuration", "configurationSha256", "hostMachineId", "candidate",
                                                       "sourceCommit", "candidateSha256")) and
            initial["rotationActionId"] == plan["actionId"] == custody["certificationActionId"] == review["certificationActionId"] and
            selected["releaseId"] == review["originalReleaseId"] != plan["actionId"] and
            selected["sources"]["frontend"]["commit"] == plan["sourceCommit"] == review["sourceCommit"] == initial["sourceCommit"] and
            plan["candidateSha256"] == review["candidateSha256"] == initial["candidateSha256"] and
            plan["hostMachineId"] == initial["hostMachineId"] and
            all(_digest(review.get(key)) for key in ("targetSha256", "originalReleaseReceiptSha256", "originalReleasePlanSha256",
                                                    "runtimeInventorySha256", "gatewayProcessSha256", "gatewayConfigurationSha256")) and
            _digest(plan.get("bindingSha256")) and _epoch(review.get("initialEpoch")) and
            review.get("startState") == "already-closed" and review.get("mode") == "contain-native" and
            review["gatewayConfigurationSha256"] == initial["configurationSha256"]["gateway.json"] and
            set(plan["configuration"]) == set(PHASES) and
            all(_digest(plan["configuration"][phase].get("sha256")) for phase in PHASES),
            REFUSED)
    return selected, plan, review, expected


def _inventory(value, selected):
    require(type(value) is list and len(value) == len(runtime.SERVICES) and
            all(type(row) is dict and set(row) == {"service", "containerId", "image", "health"} for row in value) and
            [row["service"] for row in value] == list(runtime.SERVICES) and
            all(_digest(row["containerId"]) and row["image"] == selected["artifacts"][runtime.IMAGE_KEYS[row["service"]]]["image"] and
                row["health"] == ("none" if row["service"].endswith("-tls") else "healthy") for row in value) and
            len({row["containerId"] for row in value}) == len(runtime.SERVICES), REFUSED)
    return {row["service"]: row for row in value}


def _inventory_receipt(plan, phase, containers):
    return {"version": 1, "status": INVENTORY_STATUS, "environment": "staging",
            **{key: plan[key] for key in IDENTITY_FIELDS}, "phase": phase,
            "configurationSha256": plan["configuration"][phase]["sha256"], "containers": containers}


def record_rotation_runtime_inventory(broker, phase, containers):
    """Seal the adapter's already-verified full readback under the held session."""
    from p2_identity_key_rotation_parent import P2IdentityRotationBroker

    require(type(broker) is P2IdentityRotationBroker and phase in PHASES and broker.runtime_phase == phase and
            broker.directory == _directory(broker.initial), REFUSED)
    broker.scope.verify()
    broker._require_closed_frontend()
    selected, plan, review, _ = _identity(broker.initial)
    _inventory(containers, selected)
    public = [{key: row[key] for key in ("service", "containerId", "image")} for row in containers]
    require(containers == broker.adapter.runtime_guard_containers(public) and
            (phase != "baseline" or migrate.file_hash(_canonical(containers)) == review["runtimeInventorySha256"]), REFUSED)
    result = _inventory_receipt(plan, phase, containers)
    migrate.write_json(broker.directory, f"host-runtime-{phase}-inventory.json", result)
    broker.scope.verify()


def _retained_inventories(directory, selected, plan, review):
    history, receipts = {}, {}
    for phase in PHASES:
        raw = private_record(directory, f"host-runtime-{phase}-inventory.json")
        value = json.loads(raw)
        require(_canonical(value) == _canonical(_inventory_receipt(plan, phase, value["containers"])), REFUSED)
        history[phase] = _inventory(value["containers"], selected)
        receipts[phase] = migrate.file_hash(raw)
    require(migrate.file_hash(_canonical(list(history["baseline"].values()))) == review["runtimeInventorySha256"], REFUSED)
    unchanged = set(runtime.SERVICES) - set(API_SERVICES)
    require(len(unchanged) == 8 and
            all(history["baseline"][service] == history["overlap"][service] == history["current-only"][service]
                for service in unchanged), REFUSED)
    unchanged_ids = {history["baseline"][service]["containerId"] for service in unchanged}
    changed_ids = {history[phase][service]["containerId"] for service in API_SERVICES for phase in PHASES}
    require(len(changed_ids) == len(API_SERVICES) * len(PHASES) and unchanged_ids.isdisjoint(changed_ids), REFUSED)
    return list(history["current-only"].values()), receipts


def _mutations(directory, rotation_root, plan):
    expected_attempts = {f"host-{phase}-{kind}-attempted.json" for phase, kind in MUTATIONS}
    expected_observations = {f"host-{phase}-{kind}-observed.json" for phase, kind in MUTATIONS}
    require({path.name for path in directory.glob("host-*-attempted.json")} == expected_attempts and
            {path.name for path in directory.glob("host-*-observed.json")} == expected_observations and
            not any(directory.glob("host-*-reconciled.json")), REFUSED)
    evidence = []
    for phase, kind in MUTATIONS:
        attempt = private_record(directory, f"host-{phase}-{kind}-attempted.json")
        observed = private_record(directory, f"host-{phase}-{kind}-observed.json")
        intent = {"version": 1, "status": "P2_IDENTITY_ROTATION_MUTATION_INTENT", "environment": "staging",
                  **{key: plan[key] for key in IDENTITY_FIELDS}, "phase": phase, "kind": kind,
                  "fromConfigurationSha256": plan["configuration"]["baseline" if phase == "overlap" else "overlap"]["sha256"],
                  "toConfigurationSha256": plan["configuration"][phase]["sha256"],
                  "privateConfigurationRef": str(rotation_root / phase),
                  "sqlAuthorized": False, "rolePreparationAuthorized": False, "loginChangeAuthorized": False,
                  "admissionAuthorized": False}
        require(_canonical(json.loads(attempt)) == _canonical(
            {"version": 1, "status": "P2_ROTATION_HOST_MUTATION_ATTEMPTED", "intent": intent}) and
            _canonical(json.loads(observed)) == _canonical(P2IdentityRotationHostAdapter._result(intent, False)), REFUSED)
        evidence.append({"phase": phase, "kind": kind, "attemptReceiptSha256": migrate.file_hash(attempt),
                         "observationReceiptSha256": migrate.file_hash(observed)})
    return evidence


def _configuration(initial, source, selected, directory):
    original = Path(initial["configuration"])
    rotation = Path(initial["rotationConfiguration"])
    overlap, current = (directory / f"runtime-{phase}" for phase in PHASES[1:])
    source_compose = migrate.read_input(source, "ops/platform/compose.yaml", 65_536)
    require("sha256:" + migrate.file_hash(source_compose) == selected["runtime"]["composeSha256"], REFUSED)
    for path in (original, rotation, overlap, current, *(rotation / phase for phase in PHASES)):
        _private(path)
    for phase, snapshot in zip(PHASES, (original, overlap, current)):
        reviewed = rotation / phase
        require(_phase_hash(reviewed) == initial["privateRotationConfigurationSha256"][phase] and
                _runtime_phase_hash(snapshot) == _runtime_phase_hash(reviewed) and
                migrate.read_input(snapshot, "compose.yaml", 65_536) == source_compose, REFUSED)
    require(staging_state.configuration_hashes(original) == initial["configurationSha256"], REFUSED)
    return original, rotation, current


def verify_replacement_rotation_pins(custody, source, selected, expected):
    """Rejoin the managed original before ARM and again at successor publication."""
    from p2_certification_parent import require_certification_replacement_release
    from p2_frontend_replacement_parent import managed_catalog
    from p2_replacement_successor import require_successor_runtime_provenance

    review = custody["certificationPlan"]
    descriptor = require_certification_replacement_release(review["replacementRelease"], expected)
    results = Path(custody["results"])
    original = results / ("p2-profiled-replacement-write-" + selected["releaseId"])
    _private(original)
    receipt = private_record(original, REPLACEMENT_TERMINAL)
    reviewed = private_record(original, "reviewed-plan.json", 2_000_000)
    plan = decode_qualification_target_json(reviewed, "carrier")
    migrate.require_profile(expected, plan)
    require(receipt == base64.b64decode(custody["originalReleaseReceipt"], validate=True) and
            migrate.file_hash(receipt) == review["originalReleaseReceiptSha256"] and
            migrate.file_hash(reviewed) == review["originalReleasePlanSha256"] == descriptor["reviewedPlanSha256"] and
            managed_catalog(custody, plan, source=source) is not None, REFUSED)
    pins = {"originalReleaseReceiptSha256": review["originalReleaseReceiptSha256"],
            "originalReleasePlanSha256": review["originalReleasePlanSha256"],
            "predecessorRuntimeInventorySha256": review["runtimeInventorySha256"]}
    if "successorRuntime" in review:
        mount, epoch = require_successor_runtime_provenance(custody, review, selected, results, source, expected)
        require(int(review["initialEpoch"]) >= int(epoch), REFUSED)
        pins["predecessorSuccessorReceiptSha256"] = review["successorRuntime"]["receiptSha256"]
    else:
        mount = results / ("runtime-profiled-frontend-replacement-" + selected["releaseId"]) / "configuration"
    require(Path(custody["configuration"]) == mount, REFUSED)
    return pins


def _closed_terminal(directory, terminal, committed, fresh_closed, selected, plan, review, expected, *, terminal_pending):
    from p2_identity_key_rotation_parent import JOINED_RECEIPT, SESSION_CLOSED_RECEIPT
    from p2_release_supervisor import ROTATION_LAYOUT

    joined = private_record(directory, JOINED_RECEIPT)
    if terminal_pending:
        # The guardian verified the joined outcome after reap. Bind the exact
        # bytes it will publish last, so a failed mixed proof cannot qualify.
        require(not (directory / ROTATION_LAYOUT["terminalName"]).exists() and
                not (directory / ROTATION_LAYOUT["terminalName"]).is_symlink(), REFUSED)
        raw_terminal = joined
    else:
        raw_terminal = private_record(directory, ROTATION_LAYOUT["terminalName"])
    closed = private_record(directory, SESSION_CLOSED_RECEIPT)
    require(_digest(committed) and migrate.file_hash(joined) == committed and
            _canonical(json.loads(raw_terminal)) == _canonical(json.loads(joined)) == _canonical(terminal) and
            terminal.get("status") == ROTATION_LAYOUT["terminalStatus"] and terminal.get("keyRemovalVerified") is True and
            all(terminal.get(key) == plan[key] for key in IDENTITY_FIELDS) and
            terminal.get("configurationSha256") == plan["configuration"]["current-only"]["sha256"] and
            terminal.get("frontendSessionCloseReceiptSha256") == migrate.file_hash(closed) and
            all(terminal.get(key) is False for key in ("nativeSchedulesEnabled", "trafficAuthorized", "sqlExecuted",
                                                       "rolesPrepared", "loginChanged", "releaseAccepted", "g2Accepted")), REFUSED)
    admission_epoch = str(int(review["initialEpoch"]) + 6)
    migrate.require_profile(expected, fresh_closed)
    require(_epoch(admission_epoch) and _canonical(json.loads(closed)) == _canonical(fresh_closed) and
            fresh_closed.get("status") == "P2_CERTIFICATION_FRONTEND_SESSION_CLOSED" and
            fresh_closed.get("environment") == "staging" and fresh_closed.get("releaseId") == selected["releaseId"] and
            fresh_closed.get("sourceCommit") == plan["sourceCommit"] and fresh_closed.get("targetSha256") == review["targetSha256"] and
            all(fresh_closed.get(key) is True for key in ("backendAbsent", "migrationLockReleased", "nonceLockReleased")) and
            _canonical(fresh_closed.get("admission")) == _canonical({"epoch": admission_epoch, "newWork": False, "recovery": False,
                                                                     "active": 0, "uncertain": 0}), REFUSED)
    return {"terminalReceiptSha256": migrate.file_hash(raw_terminal), "frontendSessionClosedSha256": migrate.file_hash(closed),
            "frontendEpoch": admission_epoch}


def rotation_frontend_successor(directory, terminal, *, selected=None, custody=None, expected=None):
    """Join the retained final deployment and canonical signer witness without provider calls."""
    from p2_certification_parent import READY_FILES, _profiled_ready_receipts

    profile = migrate.profile_context(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)
    require((expected is None or migrate.profile_context(expected) == profile) and
            (selected is None) == (custody is None), REFUSED)
    ready, post_removal = directory / "frontend-current-only", directory / "frontend-post-removal"
    for path in (directory, ready, post_removal):
        _private(path)
    ready_bytes = {name: private_record(ready, name) for name in READY_FILES}
    ready_hashes = {name: migrate.file_hash(raw) for name, raw in ready_bytes.items()}
    workload_name = "frontend-workload-outcome.json"
    staged, workload = (decode_qualification_target_json(ready_bytes[name], "carrier") for name in
                        ("frontend-build-outcome.json", workload_name))
    source = decode_qualification_target_json(private_record(post_removal, "rotation-frontend-browser-source.json"), "carrier")
    require(all(type(record) is dict for record in (staged, workload, source)), REFUSED)
    deployment_id, deployment_url = staged.get("deploymentId"), staged.get("url")
    signer_hash = migrate.file_hash(_canonical(source))
    signer_receipts = terminal.get("frontendSignerReceiptSha256")
    alias = {"alias": canonical_origin.HOST, "projectId": canonical_origin.PROJECT, "deploymentId": deployment_id,
             "redirect": False, "deleted": False, "microfrontends": False}
    require(type(signer_receipts) is dict and signer_receipts.get("post-removal") == signer_hash and
            type(source.get("version")) is int and source["version"] == 1 and
            source.get("status") == "P2_IDENTITY_ROTATION_BROWSER_READS_RECORDED" and
            source.get("environment") == "staging" and source.get("phase") == "post-removal" and
            all(key in terminal and source.get(key) == terminal[key] for key in (*IDENTITY_FIELDS, "configurationSha256")) and
            source.get("deploymentId") == deployment_id and source.get("deploymentUrl") == deployment_url and
            source.get("workloadReceiptSha256") == ready_hashes[workload_name] and
            source.get("browserOrigin") == canonical_origin.ORIGIN and
            source.get("canonicalAliasReadbackSha256") == migrate.file_hash(_canonical(alias)) and
            _digest(source.get("canonicalProtectedWorkloadSha256")) and
            staged.get("projectId") == canonical_origin.PROJECT, REFUSED)

    if selected is None:
        # Readback has the guardian's digest pins. Rejoin the retained identity
        # without treating the receipts as independent candidate authorization.
        selected = {"releaseId": staged["releaseId"], "workload": {"projectId": canonical_origin.PROJECT},
                    **migrate.contract_identity(workload)}
        features, writer = workload.get("featureControls"), workload.get("writerAdmissionBinding")
    else:
        migrate.candidate_profile(selected, profile)
        migrate.require_profile(profile, custody, custody["certificationPlan"])
        prior_native = custody["certificationPlan"]["nativePlan"]
        features, writer = custody["certification"]["featureControls"], custody["expectedWriterAdmissionBinding"]
        require(custody["sourceCommit"] == terminal["sourceCommit"] and
                _canonical(features) == _canonical(prior_native["featureControls"]) and
                writer == prior_native["writerAdmissionBinding"], REFUSED)
    ready_initial = {"readyReceipts": {name: base64.b64encode(raw).decode() for name, raw in ready_bytes.items()},
                     "sourceCommit": terminal["sourceCommit"], "expectedWriterAdmissionBinding": writer}
    ready_plan = {"readyReceiptSha256": ready_hashes,
                  "nativePlan": {"deploymentId": deployment_id, "deploymentUrl": deployment_url,
                                 "configurationRecordSha256": ready_hashes[workload_name],
                                 "featureControls": features, "writerAdmissionBinding": writer}}
    _profiled_ready_receipts(ready_initial, ready_plan, selected, profile)
    return {"deploymentId": deployment_id, "deploymentUrl": deployment_url, "readyReceiptSha256": ready_hashes,
            "postRemovalSignerReceiptSha256": signer_hash}


def _project_container_ids(command):
    ids = command(["docker", "container", "ls", "--all", "--no-trunc", "--filter",
                   "label=com.docker.compose.project=lash-her-staging", "--format", "{{.ID}}"], runtime.SAFE_ENV, 15).splitlines()
    require(len(ids) == len(runtime.SERVICES) and len(set(ids)) == len(ids) and all(_digest(identity) for identity in ids), REFUSED)
    return set(ids)


def _observe_mixed_runtime(initial, source, selected, review, expected, original, current, inventory, *, verify_lock=None):
    from p2_release_supervisor import verify_guard_lock

    deadline = time.monotonic() + 60

    def verify():
        require(time.monotonic() < deadline, REFUSED)
        if verify_lock is None:
            verify_guard_lock(initial)
        else:
            verify_lock()

    def run(args, **kwargs):
        verify()
        timeout = min(kwargs["timeout"], deadline - time.monotonic())
        require(timeout > 0, REFUSED)
        result = subprocess.run(args, **{**kwargs, "timeout": timeout})
        verify()
        return result

    token = runtime._command_scope.set(SimpleNamespace(run=run))
    try:
        observed = runtime.check_containers(selected, current, expected_profile=expected)
        require(observed == inventory and _project_container_ids(runtime.command) ==
                {item["containerId"] for item in inventory}, REFUSED)
        labels = ('{{.Config.Image}}|{{index .Config.Labels "com.docker.compose.project.working_dir"}}|'
                  '{{index .Config.Labels "com.docker.compose.project.config_files"}}')
        for item in inventory:
            root = current if item["service"] in API_SERVICES else original
            response = runtime.command(["docker", "inspect", "--format", labels, item["containerId"]], runtime.SAFE_ENV, 10)
            require(response.split("|") == [item["image"], str(root), str(root / "compose.yaml")], REFUSED)
        # Reuse the adapter's exact read-only mount map. There is no active
        # frontend session here and no adapter with provider/mutation authority.
        mount_context = SimpleNamespace(unchanged_runtime_configuration=original, api_mount_configuration=current,
                                        _verify_original_runtime_configuration=verify, _command=runtime.command)
        P2IdentityRotationHostAdapter._validate_runtime_mounts(mount_context, current, inventory)
        gateway = prior.observe_prior_gateway(initial, selected, verify, command=runtime.command, assert_host=runtime.assert_host,
                                              expected_profile=expected)
        gateway_id = next(row["containerId"] for row in inventory if row["service"] == "gateway")
        require(prior._zero(gateway) and gateway["binding"]["configurationDirectory"] == str(original) and
                gateway["process"]["containerId"] == gateway_id, REFUSED)
        directory = (original / "admission").lstat()
        raw = runtime.command(["docker", "exec", "--workdir", "/app", gateway_id, "node", "--input-type=module",
                               "--eval", GATEWAY_OBSERVER], runtime.SAFE_ENV, 10)
        require(0 < len(raw.encode()) <= 16_384, REFUSED)
        evidence = json.loads(raw)
        require(type(evidence.get("version")) is int and evidence["version"] == 1 and
                evidence.get("status") == "P2_FAULT_GATEWAY_CURRENT" and
                evidence.get("processSha256") == review["gatewayProcessSha256"] and
                evidence.get("gatewayConfigurationSha256") == review["gatewayConfigurationSha256"] and
                evidence.get("faultModuleSha256") == migrate.file_hash(migrate.read_input(source, FAULT_MODULE, 65_536)) and
                evidence.get("faultLeasePresent") is False and stat.S_ISDIR(directory.st_mode) and
                evidence.get("admissionDirectory") == {"device": str(directory.st_dev), "inode": str(directory.st_ino)} and
                evidence.get("admission", {}).get("valid") is True and
                all(_canonical(evidence["admission"].get(key)) == _canonical(value) for key, value in gateway["admission"].items()) and
                prior._process(gateway_id, runtime.command, verify) == gateway["process"] and
                _project_container_ids(runtime.command) == {item["containerId"] for item in inventory}, REFUSED)
        verify()
    finally:
        runtime._command_scope.reset(token)


def retain_rotation_successor(initial, source, terminal, committed, fresh_closed, *, worker_reaped, terminal_pending=False):
    """Bind the distinct mixed-runtime receipt to the guardian's exact terminal bytes."""
    from p2_release_supervisor import ROTATION_LAYOUT, fixed_layout, verify_guard_boundary

    require(worker_reaped is True and type(terminal_pending) is bool and fixed_layout(initial) == ROTATION_LAYOUT, REFUSED)
    source = Path(source)
    verify_guard_boundary(initial, source)
    selected, plan, review, expected = _identity(initial)
    directory = _directory(initial)
    proof = _closed_terminal(directory, terminal, committed, fresh_closed, selected, plan, review, expected,
                             terminal_pending=terminal_pending)
    custody = initial["frontendCustody"]
    frontend = rotation_frontend_successor(directory, terminal, selected=selected, custody=custody, expected=expected)
    replacement_pins = verify_replacement_rotation_pins(custody, source, selected, expected)
    original, rotation, current = _configuration(initial, source, selected, directory)
    current_configuration_sha = _runtime_phase_hash(current)
    inventory, phase_receipts = _retained_inventories(directory, selected, plan, review)
    mutations = _mutations(directory, rotation, plan)
    _observe_mixed_runtime(initial, source, selected, review, expected, original, current, inventory)
    require(_configuration(initial, source, selected, directory) == (original, rotation, current) and
            _runtime_phase_hash(current) == current_configuration_sha and
            _closed_terminal(directory, terminal, committed, fresh_closed, selected, plan, review, expected,
                             terminal_pending=terminal_pending) == proof and
            rotation_frontend_successor(directory, terminal, selected=selected, custody=custody, expected=expected) == frontend and
            verify_replacement_rotation_pins(custody, source, selected, expected) == replacement_pins and
            _retained_inventories(directory, selected, plan, review) == (inventory, phase_receipts) and
            _mutations(directory, rotation, plan) == mutations, REFUSED)
    verify_guard_boundary(initial, source)
    result = {"version": 2, "qualificationTargetProfile": expected, "status": STATUS, "environment": "staging",
              "kind": "identity-key-rotation-mixed-mount-v1", "releaseId": selected["releaseId"],
              "hostMachineId": initial["hostMachineId"], "targetSha256": review["targetSha256"],
              **{key: plan[key] for key in IDENTITY_FIELDS}, **replacement_pins, **proof,
              "configurationSha256": plan["configuration"]["current-only"]["sha256"],
              "currentOnlyRuntimeConfigurationSha256": current_configuration_sha,
              "frontend": frontend, "mutationReceipts": mutations, "phaseRuntimeInventoryReceiptSha256": phase_receipts,
              "runtimeInventorySha256": migrate.file_hash(_canonical(inventory)),
              "gatewayProcessSha256": review["gatewayProcessSha256"],
              "gatewayConfigurationSha256": review["gatewayConfigurationSha256"],
              "unchangedOriginalServices": [name for name in runtime.SERVICES if name not in API_SERVICES],
              "currentOnlyRecreatedServices": list(API_SERVICES),
              "frontendAdmissionClosed": True, "gatewayAdmissionClosed": True,
              "nativeSchedulesEnabled": False, "trafficAuthorized": False, "releaseAccepted": False, "g2Accepted": False}
    migrate.write_json(directory, RECEIPT, result)
    return result
