"""Read only the fixed replacement release receipts for the exact host action."""

import base64
import json
import os
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import migrate
from p2_frontend_replacement_parent import PROFILE, private_record
from qualification_target_profile import decode_qualification_target_json

REFUSED = 'P2_REPLACEMENT_OPERATOR_EVIDENCE_REFUSED'
ROOT = Path('/var/lib/lash-her/releases/staging')
ACTION_NAMES = {
    'p2-frontend-replacement-guard-armed.json', 'p2-frontend-replacement-empty-catalog.json',
    'p2-frontend-replacement-write-intent.json', 'p2-frontend-replacement-written-observation.json',
    'p2-frontend-replacement-runtime-intent.json', 'frontend-deployment-proof.json',
    'frontend-workload-outcome.json', 'frontend-promotion-outcome.json', 'frontend-session-closed.json',
    'frontend-job-outcome.json', 'frontend-continuation-completed.json', 'frontend-release-outcome.json',
    'p2-frontend-replacement-write-commit-intent.json', 'p2-frontend-replacement-write-outcome.json',
}
OUTCOME_PREFIXES = {
    'migration-outcome.json': 'migration-profiled-frontend-replacement-',
    'runtime-outcome.json': 'runtime-profiled-frontend-replacement-',
}


def require(condition):
    migrate.demand(condition, REFUSED)


def read_replacement_evidence(request):
    require(type(request) is dict and set(request) == {'version', 'qualificationTargetProfile', 'environment',
        'releaseId', 'sourceCommit', 'candidateSha256', 'results', 'reviewedPlanSha256', 'name'} and
        type(request['version']) is int and request['version'] == 1 and request['environment'] == 'staging')
    migrate.require_profile(PROFILE, request)
    release, name = request['releaseId'], request['name']
    require(type(release) is str and re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', release) and
            migrate.source_commit(request['sourceCommit']) and all(type(request[key]) is str and
            re.fullmatch(r'(?!0+$)[a-f0-9]{64}', request[key]) for key in ('candidateSha256', 'reviewedPlanSha256')) and
            type(name) is str and name in ACTION_NAMES | OUTCOME_PREFIXES.keys())
    require(type(request['results']) is str and len(request['results']) <= 4096 and ',' not in request['results'])
    results = Path(request['results'])
    require(str(results) == request['results'] and results == results.resolve() and ROOT in results.parents)
    migrate.private_directory(results)
    action = results / ('p2-profiled-replacement-write-' + release)
    migrate.private_directory(action)
    plan_bytes = private_record(action, 'reviewed-plan.json', 2_000_000)
    require(migrate.file_hash(plan_bytes) == request['reviewedPlanSha256'])
    plan = decode_qualification_target_json(plan_bytes, 'carrier')
    migrate.require_profile(PROFILE, plan)
    require(plan.get('status') == 'P2_FRONTEND_REPLACEMENT_PLAN_PREPARED' and
            all(plan.get(key) == request[key] for key in ('environment', 'releaseId', 'sourceCommit', 'candidateSha256')))
    directory = results / (OUTCOME_PREFIXES[name] + release) if name in OUTCOME_PREFIXES else action
    migrate.private_directory(directory)
    raw = private_record(directory, name, 2_000_000 if name in OUTCOME_PREFIXES else 65_536)
    require(raw.endswith(b'\n'))
    return raw


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(8193)
        require(len(sys.argv) == 1 and os.geteuid() == 0 and 0 < len(raw) <= 8192)
        request = decode_qualification_target_json(raw, 'private-packet')
        require(Path(__file__).resolve().parents[3] == Path('/opt/lash-her/operators') / request['sourceCommit'])
        print(json.dumps({'bytes': base64.b64encode(read_replacement_evidence(request)).decode('ascii')}))
    except BaseException:
        print(REFUSED, file=sys.stderr)
        raise SystemExit(1)
