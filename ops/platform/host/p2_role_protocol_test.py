"""Role proof RPC shape; OS/TLS/SQL lease enforcement is exercised separately."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from p2_release_broker import Broker


class RoleProtocolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.plan = {'planSha256': 'a'*64, 'actionId': 'owned', 'sourceCommit': 'b'*40, 'targetSha256': 'c'*64,
                     'jobSha256': 'd'*64, 'producerSha256': ['e'*64]}
        self.proof = {**self.plan, 'environment': 'staging', 'status': 'FRONTEND_ROLES_PREPARED', 'committed': True,
                      'runtimeCredentialVerified': True, 'owner': {'name': 'lash_her_frontend_staging_admission_owner_p2', 'oid': '100'},
                      'runtime': {'name': 'lash_her_frontend_staging_runtime_p2', 'oid': '101'}}
        self.proof['producers'] = [{'producerSha256': 'e'*64, 'sourceCommit': 'b'*40, 'role': self.proof['runtime']}]
        self.seal(self.proof)
        self.events = []
        self.broker = Broker({'rolePreparation': self.plan}, self.events.append)
        self.broker.directory = self.root
        self.broker.jobs = {'frontend': {'job': {'target': {'runtimeRole': 'lash_her_frontend_staging_runtime_p2'}}}}
        self.broker.check = lambda: None  # known verified context for this codec-only test

    def tearDown(self): self.temp.cleanup()

    @staticmethod
    def seal(proof):
        body = {key: value for key, value in proof.items() if key != 'proofSha256'}
        proof['proofSha256'] = hashlib.sha256(json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()

    def test_exact_observed_role_proof_binds_producers_and_is_consumed_once(self):
        self.broker.command({'id': 1, 'operation': 'roles-prepared', 'proof': self.proof})
        self.assertEqual(self.broker.initial['owner'], self.proof['owner'])
        self.assertEqual(self.events[-1]['status'], 'ROLES_PREPARED')
        self.assertEqual(json.loads((self.root/'p2-observed-role-preparation.json').read_bytes()), self.proof)
        with self.assertRaises(ValueError): self.broker.command({'id': 2, 'operation': 'roles-prepared', 'proof': self.proof})

    def test_wrong_source_target_oid_or_producers_refuses_before_a_role_receipt(self):
        for mutate in [lambda p: p.update(sourceCommit='f'*40), lambda p: p.update(targetSha256='f'*64),
                       lambda p: p['owner'].update(oid='0'), lambda p: p['runtime'].update(oid='9999999999'),
                       lambda p: p.update(producers=[]), lambda p: p['producers'][0].update(producerSha256='f'*64)]:
            proof = copy.deepcopy(self.proof); mutate(proof); self.seal(proof)
            with self.assertRaises(ValueError): self.broker.command({'id': 1, 'operation': 'roles-prepared', 'proof': proof})
            self.assertFalse((self.root/'p2-observed-role-preparation.json').exists())
