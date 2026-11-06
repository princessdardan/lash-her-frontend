"""Owned POSIX/flock tests; Docker and allocated registry metadata projected."""
import copy
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import p2q_first_install as source

REF={'version':1,'id':'owned-first-install','sha256':'a'*64}


def request():
    return {'version':1,'operation':'observe','qualificationTargetProfile':REF,'actionId':'owned-observe',
            'candidate':{'version':3,'environment':'staging','releaseId':'owned-release','sources':{'frontend':{'commit':'b'*40}}},
            'job':{'version':2,'environment':'staging','releaseId':'owned-release','sourceCommit':'b'*40}}


class HostObservationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='p2q-first-host-');self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.staging=self.root/'staging';self.staging.mkdir(mode=0o700)
        self.machine=self.root/'machine-id';self.machine.write_text('1'*32+'\n');self.lock=self.root/'host.lock'
        self.calls=[]
        def command(args):
            self.calls.append(args)
            return '"owned-daemon"\n' if args[0]=='info' else ''
        for value in (patch.object(source,'LOCK_PATH',self.lock),patch.object(source,'STAGING_ROOT',self.staging),
                      patch.object(source,'MACHINE_ID',self.machine),patch.object(source,'profile',return_value=copy.deepcopy(REF)),
                      patch.object(source,'command',side_effect=command)):
            value.start();self.addCleanup(value.stop)

    def test_actual_flock_observation_is_not_first_use_or_release_authority(self):
        with source.HostObservation(request()) as guard:
            value=guard.observe();self.assertEqual(value['dockerContainerCount'],0)
            for key in ('firstUseAuthorized','migrationAuthorized','rolePreparationAuthorized','creationControlProven','credentialDeliveryHistoryProven','providerBeforeUseProven'):
                self.assertIs(value[key],False)
            result=subprocess.run([sys.executable,'-I','-c','import os,fcntl,sys; f=os.open(sys.argv[1],os.O_RDWR);fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)',str(self.lock)],capture_output=True)
            self.assertNotEqual(result.returncode,0)
        fd=os.open(self.lock,os.O_RDWR)
        try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        finally:os.close(fd)
        with self.assertRaisesRegex(ValueError,'OBSERVATION_CLOSED'):guard.observe()

    def test_current_or_unknown_registry_never_opens_lock_or_queries_docker(self):
        with patch.object(source,'profile',side_effect=ValueError('QUALIFICATION_TARGET_PROFILE_POLICY_REFUSED')),patch.object(source.os,'open',side_effect=AssertionError('I/O before policy')):
            with self.assertRaisesRegex(ValueError,'POLICY_REFUSED'):source.HostObservation(request())
        self.assertEqual(self.calls,[])

    def test_lock_replacement_machine_change_and_new_entry_each_refuse(self):
        for kind in ('lock','machine','entry','lineage'):
            with self.subTest(kind=kind):
                self.machine.write_text('1'*32+'\n')
                with source.HostObservation(request()) as guard:
                    if kind=='lock':self.lock.unlink();self.lock.touch(mode=0o600)
                    elif kind=='machine':self.machine.write_text('2'*32+'\n')
                    else:(self.staging/('.p2-gateway-lineage.json' if kind=='lineage' else 'unreviewed')).write_text('{}')
                    with self.assertRaises(ValueError):guard.observe()
                for path in self.staging.iterdir():path.unlink()

    def test_existing_unknown_container_or_daemon_failure_is_not_absence(self):
        for value in ('a'*64+'\n',None):
            def command(args):
                if args[0]=='info':return '"owned-daemon"'
                if value is None:raise ValueError('P2Q_FIRST_INSTALL_DOCKER_OBSERVATION_REQUIRED')
                return value
            with self.subTest(value=value),patch.object(source,'command',side_effect=command):
                with self.assertRaises(ValueError):
                    with source.HostObservation(request()):pass

    def test_private_content_is_not_read_or_hashed_and_retained_metadata_is_descriptive(self):
        path=self.staging/'private.env';path.write_text('PASSWORD=CANARY_ONE\n')
        with source.HostObservation(request()) as guard:
            before=guard.observe();path.write_text('PASSWORD=CANARY_TWO\n');after=guard.observe()
            self.assertEqual(before,after);self.assertEqual(after['retainedMetadata']['entryCount'],1)
            self.assertNotIn('CANARY',json.dumps(after));self.assertIs(after['credentialDeliveryHistoryProven'],False)

    def test_symlinks_and_profile_mutation_are_not_adopted(self):
        with source.HostObservation(request()) as guard:
            guard.ref['sha256']='f'*64
            with self.assertRaisesRegex(ValueError,'DRIFT'):guard.observe()
        (self.staging/'unsafe').symlink_to(self.machine)
        with self.assertRaisesRegex(ValueError,'UNKNOWN_HOST_ENTRY'):
            with source.HostObservation(request()):pass


if __name__=='__main__':unittest.main()
