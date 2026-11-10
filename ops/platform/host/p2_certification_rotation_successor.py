"""Validate and reobserve the S06 mixed runtime without changing either mount."""
import base64
from dataclasses import dataclass
from pathlib import Path
import re

import migrate
import p2_identity_rotation_successor as rotation
import p2_replacement_operator_evidence as evidence
import p2_replacement_successor as replacement
from p2_frontend_replacement_parent import private_record
from p2_identity_key_rotation_adapter import _runtime_phase_hash
from p2_replacement_terminal import exact_receipt
from qualification_target_profile import STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE, decode_qualification_target_json


KIND = 'identity-key-rotation-mixed-mount-v1'
BINDING_FIELDS = frozenset(('kind', 'actionId', 'bindingSha256', 'receiptSha256'))
REFUSED = 'P2_CERTIFICATION_ROTATION_SUCCESSOR_REFUSED'
require = migrate.demand


@dataclass(frozen=True)
class RotationSuccessorRuntime:
    predecessor_configuration: Path
    current_only_configuration: Path
    current_only_configuration_sha256: str
    frontend: dict
    inventory: list
    frontend_epoch: str


def require_rotation_successor_runtime(initial, plan, selected, results, source, expected):
    """Rejoin fixed private evidence and derive the only eligible mount roots."""
    from p2_certification_parent import READY_FILES, require_certification_replacement_release
    from p2_release_supervisor import ROTATION_LAYOUT

    profile = migrate.profile_context(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)
    require(migrate.profile_context(expected) == profile, REFUSED)
    migrate.require_profile(profile, initial, plan)
    migrate.candidate_profile(selected, profile)
    binding = plan.get('rotationSuccessor')
    require(type(binding) is dict and set(binding) in (BINDING_FIELDS, BINDING_FIELDS | {'predecessorRuntime'}) and
            binding['kind'] == KIND and type(binding['actionId']) is str and
            re.fullmatch(r'p2-key-rotation-[a-z0-9-]{1,40}', binding['actionId']) and
            all(rotation._digest(binding.get(key)) for key in ('bindingSha256', 'receiptSha256')) and
            'successorRuntime' not in plan and plan.get('startState') == 'already-closed', REFUSED)
    results, source = Path(results), Path(source)
    release_id, action = selected['releaseId'], binding['actionId']
    descriptor = require_certification_replacement_release(plan['replacementRelease'], profile)
    require(str(results) == initial.get('results') and
            plan['certificationActionId'] == initial['certificationActionId'] and
            len({release_id, action, plan['certificationActionId']}) == 3 and
            selected['environment'] == plan['environment'] == initial['environment'] == 'staging' and
            plan['originalReleaseId'] == release_id and
            selected['sources']['frontend']['commit'] == plan['sourceCommit'] == initial['sourceCommit'] and
            all(rotation._digest(plan.get(key)) and plan[key] == initial[key] for key in ('candidateSha256', 'targetSha256')) and
            plan['originalReleasePlanSha256'] == descriptor['reviewedPlanSha256'] and
            plan['gatewayConfigurationSha256'] == initial['configurationSha256']['gateway.json'] and
            plan['configurationCanonicalSha256'] == migrate.file_hash(rotation._canonical(initial['configurationSha256'])) and
            rotation._epoch(plan.get('initialEpoch')), REFUSED)
    directory = results / (ROTATION_LAYOUT['receiptPrefix'] + action)
    rotation._private(results)
    rotation._private(directory)
    request = {'version': 1, 'qualificationTargetProfile': profile, 'operation': evidence.ROTATION_SUCCESSOR_OPERATION,
               'results': str(results), 'releaseId': release_id, 'actionId': action, 'bindingSha256': binding['bindingSha256'],
               **{key: plan[key] for key in ('environment', 'sourceCommit', 'candidateSha256',
                                            'originalReleasePlanSha256', 'originalReleaseReceiptSha256')}}
    raw = evidence.read_rotation_successor_evidence(request)
    receipt = exact_receipt(raw)
    require(migrate.file_hash(raw) == binding['receiptSha256'] and
            base64.b64encode(raw).decode('ascii') == initial.get('rotationSuccessorReceipt') and
            receipt['hostMachineId'] == initial['hostMachineId'] and
            int(plan['initialEpoch']) >= int(receipt['frontendEpoch']) and
            all(receipt[key] == plan[key] for key in ('targetSha256', 'runtimeInventorySha256', 'gatewayProcessSha256',
                                                      'gatewayConfigurationSha256')), REFUSED)

    predecessor = results / ('runtime-profiled-frontend-replacement-' + release_id) / 'configuration'
    has_predecessor = 'predecessorSuccessorReceiptSha256' in receipt
    require(has_predecessor == ('predecessorRuntime' in binding), REFUSED)
    if has_predecessor:
        historical = binding['predecessorRuntime']
        require(type(historical) is dict and set(historical) == replacement.BINDING_FIELDS and
                historical['receiptSha256'] == receipt['predecessorSuccessorReceiptSha256'] and
                {action, plan['certificationActionId']}.isdisjoint((historical['actionId'], historical['runtimeActionId'])), REFUSED)
        prior_plan = {**plan, 'successorRuntime': historical, 'runtimeInventorySha256': receipt['predecessorRuntimeInventorySha256']}
        predecessor, prior_epoch = replacement.require_successor_runtime_provenance(initial, prior_plan, selected, results, source, profile)
        require(int(prior_epoch) < int(receipt['frontendEpoch']), REFUSED)
    current = directory / 'runtime-current-only'
    require(str(predecessor) == initial['configuration'] and current != predecessor, REFUSED)
    for mount in (predecessor, current):
        rotation._private(mount)
    replacement._configuration(predecessor, initial, selected, source)
    require(migrate.read_input(current, 'compose.yaml', 65_536) == migrate.read_input(source, 'ops/platform/compose.yaml', 65_536) and
            _runtime_phase_hash(current) == receipt['currentOnlyRuntimeConfigurationSha256'], REFUSED)

    inventory_raw = private_record(directory, 'host-runtime-current-only-inventory.json')
    inventory = decode_qualification_target_json(inventory_raw, 'carrier')
    require(type(inventory) is dict and
            migrate.file_hash(inventory_raw) == receipt['phaseRuntimeInventoryReceiptSha256']['current-only'], REFUSED)
    containers = inventory.get('containers')
    rotation._inventory(containers, selected)
    current_plan = {**receipt, 'configuration': {'current-only': {'sha256': receipt['configurationSha256']}}}
    require(inventory == rotation._inventory_receipt(current_plan, 'current-only', containers) and
            migrate.file_hash(rotation._canonical(containers)) == receipt['runtimeInventorySha256'], REFUSED)

    frontend = receipt['frontend']
    native_plan = plan['nativePlan']
    require(all(frontend[key] == native_plan[key] for key in ('deploymentId', 'deploymentUrl')) and
            frontend['readyReceiptSha256'] == plan['readyReceiptSha256'] and
            frontend['readyReceiptSha256']['frontend-workload-outcome.json'] == native_plan['configurationRecordSha256'] and
            type(initial.get('readyReceipts')) is dict and set(initial['readyReceipts']) == set(READY_FILES), REFUSED)
    ready = directory / 'frontend-current-only'
    rotation._private(ready)
    for name in READY_FILES:
        payload = private_record(ready, name)
        require(migrate.file_hash(payload) == frontend['readyReceiptSha256'][name] and
                base64.b64encode(payload).decode('ascii') == initial['readyReceipts'][name], REFUSED)
    return RotationSuccessorRuntime(predecessor, current, receipt['currentOnlyRuntimeConfigurationSha256'],
                                    frontend, containers, receipt['frontendEpoch'])


def observe_rotation_successor_runtime(initial, source, successor, verify):
    """Read the exact mixed Docker runtime and require both admissions to stay closed."""
    plan, selected = initial['certificationPlan'], initial['candidate']
    results = Path(initial['results'])
    expected = migrate.profile_context(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)
    verify()
    require(require_rotation_successor_runtime(initial, plan, selected, results, source, expected) == successor, REFUSED)
    rotation._observe_mixed_runtime(initial, source, selected, plan, expected, successor.predecessor_configuration,
                                    successor.current_only_configuration, successor.inventory, verify_lock=verify)
    require(require_rotation_successor_runtime(initial, plan, selected, results, source, expected) == successor, REFUSED)
    verify()
