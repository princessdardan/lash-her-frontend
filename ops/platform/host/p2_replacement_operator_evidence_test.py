import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import migrate
import p2_replacement_operator_evidence as evidence


class ReplacementOperatorEvidenceTest(unittest.TestCase):
    def test_reads_only_original_receipts_for_bound_action(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            results = root / 'results'
            results.mkdir(mode=0o700)
            release_id = 'owned-replacement'
            action = results / ('p2-profiled-replacement-write-' + release_id)
            action.mkdir(mode=0o700)
            runtime = results / ('runtime-profiled-frontend-replacement-' + release_id)
            runtime.mkdir(mode=0o700)
            identity = {'version': 1, 'qualificationTargetProfile': evidence.PROFILE, 'environment': 'staging',
                        'releaseId': release_id, 'sourceCommit': 'a' * 40, 'candidateSha256': 'b' * 64}
            migrate.write_json(action, 'reviewed-plan.json', {**identity, 'status': 'P2_FRONTEND_REPLACEMENT_PLAN_PREPARED'})
            plan_sha = migrate.file_hash((action / 'reviewed-plan.json').read_bytes())
            request = {**identity, 'reviewedPlanSha256': plan_sha, 'results': str(results)}
            terminal = 'p2-frontend-replacement-write-outcome.json'
            raw = b'{ "owned" : true }\n'
            migrate.write_exact_bytes(action, terminal, raw)
            close_prepared = 'p2-frontend-replacement-close-prepared.json'
            migrate.write_exact_bytes(action, close_prepared, raw)
            migrate.write_exact_bytes(runtime, 'runtime-outcome.json', raw)
            migrate.write_exact_bytes(action, 'frontend-role-credentials.json', b'{}\n')
            with patch.object(evidence, 'ROOT', root):
                self.assertEqual(evidence.read_replacement_evidence({**request, 'name': terminal}), raw)
                self.assertEqual(evidence.read_replacement_evidence({**request, 'name': close_prepared}), raw)
                self.assertEqual(evidence.read_replacement_evidence({**request, 'name': 'runtime-outcome.json'}), raw)
                for changed in ({'reviewedPlanSha256': 'f' * 64}, {'candidateSha256': 'f' * 64},
                                {'name': 'frontend-role-credentials.json'}, {'name': '../' + terminal}):
                    with self.subTest(changed=changed), self.assertRaises(ValueError):
                        evidence.read_replacement_evidence({**request, 'name': terminal, **changed})
                (action / terminal).unlink()
                (action / terminal).symlink_to(runtime / 'runtime-outcome.json')
                with self.assertRaises(ValueError):
                    evidence.read_replacement_evidence({**request, 'name': terminal})


if __name__ == '__main__':
    unittest.main()
