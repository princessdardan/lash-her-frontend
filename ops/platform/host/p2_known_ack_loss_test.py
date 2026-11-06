"""Source state/opaque-authority regressions; actual three-DB fixture is separate."""
import copy
import json
import unittest
from unittest.mock import Mock
import p2_known_ack_loss as source


def fixture():
    command='00000000-0000-4000-8000-000000000001'
    plan={'receiver':'course','commandSha256':'a'*64,'nativePlan':{'initialEpoch':'2','sourceCommit':'b'*40,
        'producer':{'producerSha256':'c'*64,'role':{'oid':'123'}},'commandWitnesses':[{'commandId':command,'accountVersion':'1','action':'suspend'}]}}
    deliveries=[{'command_id':command,'receiver':name,'status':'pending','attempts':0,'lease_id':None,'lease_until':None,'acknowledged_at':None,'ready':True} for name in ('community','course')]
    front={'commandId':command,'accountVersion':'1','accountStatus':'suspended','commandSha256':'a'*64,'userBindingSha256':'d'*64,
        'exports':0,'later':0,'operations':[],'deliveries':copy.deepcopy(deliveries),'outstanding':copy.deepcopy(deliveries),
        'admission':{'epoch':'2','newWork':False,'recovery':True,'active':0,'uncertain':0}}
    baseline={'frontend':front,'course':{'command':None},'community':{'command':None}}
    domain=copy.deepcopy(baseline);front=domain['frontend'];front['admission'].update(epoch='3',uncertain=1);front['outstanding']=[]
    for row in front['deliveries']:
        row.update(status='acknowledged',attempts=2 if row['receiver']=='course' else 1,acknowledged_at='2026-11-06T01:00:03.000Z')
    front['operations']=[{'id':name,'epoch':'3','kind':'recovery','producer_sha256':'c'*64,'source_sha':'b'*40,'role_oid':'123',
        'state':state,'started_at':started,'completed_at':None if state=='uncertain' else '2026-11-06T01:00:04.000Z','reconciliation_sha256':None}
        for name,state,started in [('00000000-0000-4000-8000-000000000002','uncertain','2026-11-06T01:00:00.000Z'),
            ('00000000-0000-4000-8000-000000000003','completed','2026-11-06T01:00:02.000Z')]]
    for name in ('course','community'):
        domain[name]['command']={'userBindingSha256':'d'*64,'accountVersion':'1','commandSha256':'a'*64,'acceptedAt':'2026-11-06T01:00:01.000Z','accountStatus':'suspended'}
    gateway={'admission':{'newWork':False,'recovery':True,'active':{'newWork':0,'recovery':0},'uncertain':{'newWork':0,'recovery':1}}}
    effect={'mode':'drop-after-ack','receiver':'course','sourceWitnessSha256':'a'*64,'upstreamReceiptVerified':True,
        'upstreamStarted':True,'upstreamStatus':200,'downstreamBytesStarted':False,'downstreamDisposition':'dropped-before-any-response-bytes'}
    return plan,baseline,domain,gateway,[effect]


class KnownAckSourceTests(unittest.TestCase):
    def test_two_untouched_pending_deliveries_are_required_before_fault(self):
        plan,baseline,_,_,_=fixture();source.validate_baseline(plan,baseline)
        for field,value in [('attempts',1),('status','delivering'),('lease_id','owned-lease'),('acknowledged_at','2026-11-06T00:00:00.000Z'),('ready',False)]:
            bad=copy.deepcopy(baseline);bad['frontend']['outstanding'][0][field]=value
            with self.subTest(field=field),self.assertRaises(ValueError):source.validate_baseline(plan,bad)
        bad=copy.deepcopy(baseline);bad['course']['command']={'acceptedAt':'already-accepted'}
        with self.assertRaises(ValueError):source.validate_baseline(plan,bad)

    def test_exact_drop_and_normal_replay_domain_proof_preserves_original_one(self):
        plan,baseline,domain,gateway,effects=fixture()
        self.assertEqual(source.validate_domain(plan,baseline,domain,gateway,effects),{'operationId':domain['frontend']['operations'][0]['id']})
        self.assertEqual(domain['frontend']['admission']['uncertain'],1)
        self.assertEqual(gateway['admission']['uncertain'],{'newWork':0,'recovery':1})
        closed=copy.deepcopy(domain);closed['frontend']['admission'].update(epoch='4',recovery=False)
        after=copy.deepcopy(gateway);after['admission']['recovery']=False
        self.assertIsNotNone(source.validate_domain(plan,baseline,closed,after,effects,closed=True))

    def test_active_same_source_operation_is_pending_and_can_never_authorize_settlement(self):
        plan,baseline,domain,gateway,effects=fixture()
        domain['frontend']['operations'][1].update(state='active',completed_at=None);domain['frontend']['admission']['active']=1
        gateway['admission']['active']['recovery']=1
        self.assertIsNone(source.validate_domain(plan,baseline,domain,gateway,effects))
        domain['frontend']['operations'][1]['source_sha']='f'*40
        with self.assertRaisesRegex(ValueError,'UNRELATED_OPERATION'):source.validate_domain(plan,baseline,domain,gateway,effects)

    def test_extra_effect_work_global_uncertainty_command_and_receiver_drift_refuse(self):
        for kind in ('effect','export','later','global','gateway','producer','command','version','attempt','receiver'):
            plan,baseline,domain,gateway,effects=fixture();front=domain['frontend']
            if kind=='effect':effects+=effects
            elif kind=='export':front['exports']=1
            elif kind=='later':front['later']=1
            elif kind=='global':front['admission']['uncertain']=2
            elif kind=='gateway':gateway['admission']['uncertain']['recovery']=2
            elif kind=='producer':front['operations'][0]['producer_sha256']='f'*64
            elif kind=='command':front['commandSha256']='f'*64
            elif kind=='version':front['accountVersion']='2'
            elif kind=='attempt':front['deliveries'][1]['attempts']=3
            elif kind=='receiver':domain['course']['command']['commandSha256']='f'*64
            with self.subTest(kind=kind),self.assertRaises(ValueError):source.validate_domain(plan,baseline,domain,gateway,effects)

    def test_every_request_must_join_exact_uncertain503_and_completed200_operation(self):
        plan,_,domain,_,_=fixture();operations=domain['frontend']['operations']
        artifact={'observations':[{'admittedLogLine':json.dumps({'operationId':row['id']}),'httpStatus':503 if row['state']=='uncertain' else 200} for row in operations]}
        source.validate_request_operations(plan,artifact,operations)
        for kind in ('missing','unknown','swapped','unadmitted','duplicate'):
            changed=copy.deepcopy(artifact)
            if kind=='missing':changed['observations'].pop()
            elif kind=='unknown':changed['observations'][0]['admittedLogLine']=json.dumps({'operationId':'unknown'})
            elif kind=='swapped':changed['observations'][0]['httpStatus']=200
            elif kind=='unadmitted':changed['observations'][0]['admittedLogLine']=None
            elif kind=='duplicate':changed['observations'][1]=changed['observations'][0]
            with self.subTest(kind=kind),self.assertRaises(ValueError):source.validate_request_operations(plan,changed,operations)

    def test_opaque_authorization_is_same_scope_action_fresh_and_once_only(self):
        scope=object();recorder=Mock();recorder.scope=scope
        with self.assertRaises(ValueError):source.KnownAckLossRecoveryAuthorization(object(),recorder,{})
        value=source.KnownAckLossRecoveryAuthorization(source._ISSUER,recorder,{'recoveryActionId':'owned-replacement'})
        for changed,selected,action in [({'recoveryActionId':'owned-replacement'},scope,'owned-replacement'),(copy.copy(value),scope,'owned-replacement'),
            (value,object(),'owned-replacement'),(value,scope,'wrong-action')]:
            with self.assertRaises(ValueError):source.require_known_ack_loss_authorization(changed,selected,action)
        source.require_known_ack_loss_authorization(value,scope,'owned-replacement');recorder._verify_authorization.assert_called_once()
        source.consume_known_ack_loss_authorization(value,scope,'owned-replacement')
        with self.assertRaises(ValueError):source.consume_known_ack_loss_authorization(value,scope,'owned-replacement')
        with self.assertRaises(ValueError):source.require_known_ack_loss_authorization(copy.copy(value),scope,'owned-replacement')

    def test_source_constructor_rejects_json_and_foreign_parent_before_io(self):
        for broker in ({'mode':'known-ack-recovery'},object(),Mock()):
            with self.assertRaises(ValueError):source.P2KnownAckLossRecorder(broker,'owned-replacement',{})

    def test_specific_settlement_cannot_hide_new_completed_operations_or_other_changed_receipts(self):
        plan,_,before,_,_=fixture();before['frontend']['admission'].update(epoch='4',recovery=False)
        after=copy.deepcopy(before);operation_id=before['frontend']['operations'][0]['id']
        after['frontend']['admission']['uncertain']=0
        after['frontend']['operations'][0].update(state='completed',completed_at='2026-11-06T01:00:06.000Z',reconciliation_sha256='e'*64)
        source.validate_settled(plan,before,after,operation_id,'e'*64)
        for kind in ('new-completed','other-reconciliation','wrong-reconciliation','new-epoch','receiver'):
            actual=copy.deepcopy(after)
            if kind=='new-completed':
                extra=copy.deepcopy(actual['frontend']['operations'][1]);extra['id']='00000000-0000-4000-8000-000000000099';actual['frontend']['operations'].append(extra)
            elif kind=='other-reconciliation':actual['frontend']['operations'][1]['reconciliation_sha256']='e'*64
            elif kind=='wrong-reconciliation':actual['frontend']['operations'][0]['reconciliation_sha256']='f'*64
            elif kind=='new-epoch':actual['frontend']['admission']['epoch']='5'
            elif kind=='receiver':actual['community']['command']['acceptedAt']='2026-11-06T01:00:09.000Z'
            with self.subTest(kind=kind),self.assertRaises(ValueError):source.validate_settled(plan,before,actual,operation_id,'e'*64)


if __name__=='__main__':unittest.main()
