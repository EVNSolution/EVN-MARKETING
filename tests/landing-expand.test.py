"""Modeled host effects. Real Linux locking, durability and Docker require CI/rehearsal."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import stat
import shutil
import sys
import tempfile
import types
import unittest
import uuid
from unittest.mock import patch

if sys.platform == 'win32':
    def unavailable_lock(*args):
        raise RuntimeError('Real host locks are not tested on Windows')
    sys.modules.setdefault('fcntl', types.SimpleNamespace(LOCK_EX=2, LOCK_NB=4, flock=unavailable_lock))
spec = importlib.util.spec_from_file_location('landing_expand', Path(__file__).resolve().parents[1] / 'deploy/landing-expand.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
POLICY = json.loads((Path(__file__).resolve().parents[1] / 'scripts/landing-schema-policy.json').read_text(encoding='utf-8'))
ACTIVE = {'revision':'a'*40, 'digest':'sha256:'+'a'*64, 'slot':'blue', 'owner':'00000000-0000-4000-8000-000000000001'}
CANDIDATE = {'revision':'c'*40, 'digest':'sha256:'+'b'*64}
OPERATIONS = {'revision':'c'*40, 'digest':'sha256:'+'c'*64}
RESTORE = 'evn-marketing-restore-00000000-0000-4000-8000-000000000002'


class Fake(m.LandingExpand):
    def __init__(self, root):
        self.root = root
        self.state = {'format':1, 'phase':'stable', 'active':copy.deepcopy(ACTIVE), 'previous':None}
        self.config = {'volume':'evn-marketing-data', 'ebsVolumeId':'vol-01', 'landingIntakeEnabled':False}
        self.evidence = {'revision':ACTIVE['revision'], 'digest':ACTIVE['digest'], 'backupId':'synthetic-backup',
                         'snapshotId':'snap-01', 'manifestSha256':'d'*64, 'restoreVolume':RESTORE}
        self.events = []
        self.storage = m.BASELINE
        self.restore_storage = m.BASELINE
        self.cfg = 'f'*64
        self.time = 10000
        self.bad_data = self.bad_backup = self.bad_restore = self.bad_recover = False
        self.migration_failure = None
        self.unknown_writer = False
        self.owner, self.mode = 0, 0o600
        self.before = {'format':1, 'ok':True, 'contractSha256':m.BASELINE, 'rows':{'Customer':1},
                       'hashes':{'Customer':'e'*64}, 'addedRows':[0,0], 'files':1, 'uploadBytes':50, 'filesSha256':'f'*64}

    def now(self): return self.time
    def config_hash(self): return self.cfg
    def manifest(self, release):
        result = copy.deepcopy(POLICY['baseline' if release['revision'] == ACTIVE['revision'] else 'expanded'])
        result['revision'] = release['revision']
        result['schemaCompatibility'] = {'landingExpansion':m.EXPANDED}
        return result
    def backup_evidence(self):
        self.events.append('backup_evidence')
        m.require(not self.bad_backup, 'backup_unavailable')
        return self.evidence
    def unused_restore(self, volume, evidence):
        m.require(not self.bad_restore and volume == RESTORE, 'restore_volume_required')
    def approved_plan(self, approval):
        size = self.plan_path().stat().st_size
        info = types.SimpleNamespace(st_nlink=1, st_uid=self.owner, st_mode=stat.S_IFREG | self.mode, st_size=size)
        # Permission branches are modeled; no claim of POSIX enforcement on Windows.
        with patch.object(Path, 'lstat', return_value=info):
            return super().approved_plan(approval)
    def audit(self, candidate, volume, expected):
        self.events.append(('audit',volume,expected))
        actual = self.storage if volume == self.config['volume'] else self.restore_storage
        m.require(actual == (m.BASELINE if expected == 'baseline' else m.EXPANDED), 'expansion_audit')
        value = {**copy.deepcopy(self.before), 'contractSha256':actual}
        if expected == 'expanded' and self.bad_data: value['hashes']['Customer'] = '0'*64
        return value
    def migrate(self, operations, volume):
        self.events.append(('migrate',volume))
        if volume == self.config['volume']:
            assert self.state['phase'] == 'maintenance' and self.state['maintenance']['stage'] == 'migrating'
            self.storage = None if self.migration_failure == 'partial' else m.EXPANDED
        else: self.restore_storage = m.EXPANDED
        if self.migration_failure: raise m.Blocked('command_failed')
    def save(self, **values): self.state.update(copy.deepcopy(values))
    def stop_worker(self, *args): self.events.append('stop_worker')
    def stop_web(self, *args): self.events.append('stop_web')
    def lease_clear(self, *args, **kwargs): self.events.append('lease_clear')
    def no_writers(self, allowed=()):
        m.require(not self.unknown_writer, 'volume_writer_running')
        self.events.append('no_writers')
    def data_command(self, arguments, mounts):
        self.events.append('offline_snapshot')
        m.require(not self.bad_backup, 'data_verification')
        assert self.state['phase'] == 'maintenance'
        return {'ok':True, 'summarySha256':'e'*64}
    def storage_contract(self):
        m.require(self.storage in (m.BASELINE,m.EXPANDED), 'schema')
        return self.storage
    def running(self, name): return False
    def recover(self):
        self.events.append('recover')
        m.require(not self.bad_recover, 'readiness')


class Checks(unittest.TestCase):
    def setUp(self):
        self.tmp = None
        if sys.platform == 'win32':
            # Python's special Windows 0700 DACL excludes the desktop sandbox
            # token. Synthetic files can inherit the explicitly writable test root.
            self.test_parent = Path(os.environ.get('MARKETING_TEST_TMP', tempfile.gettempdir())).resolve()
            self.root = self.test_parent / ('marketing-landing-unit-' + str(uuid.uuid4()))
            self.root.mkdir()
        else:
            self.tmp = tempfile.TemporaryDirectory()
            self.root = Path(self.tmp.name)
        (self.root/'state').mkdir()
        self.ops = Fake(self.root)
        self.atomic = patch.object(m, 'atomic', side_effect=lambda file,text: file.write_bytes(text.encode('utf-8')))
        self.atomic.start()
    def tearDown(self):
        self.atomic.stop()
        if self.tmp:
            self.tmp.cleanup()
        else:
            assert self.root.resolve().parent == self.test_parent
            assert self.root.name.startswith('marketing-landing-unit-')
            shutil.rmtree(self.root)
    def plan(self):
        return self.ops.rehearse(CANDIDATE['revision'],CANDIDATE['digest'],OPERATIONS['digest'])['planSha256']

    def test_exact_contract_hashes_match_javascript_policy(self):
        self.assertEqual(m.contract(POLICY['baseline']),m.BASELINE)
        self.assertEqual(m.contract(POLICY['expanded']),m.EXPANDED)

    def test_rehearsal_never_touches_live_volume_and_records_only_success(self):
        self.plan()
        self.assertNotIn(('migrate','evn-marketing-data'), self.ops.events)
        self.assertNotIn('stop_worker', self.ops.events)
        self.assertEqual(self.ops.state['phase'],'stable')
        self.ops = Fake(self.root)
        self.ops.bad_data = True
        self.ops.plan_path().unlink()
        with self.assertRaisesRegex(m.Blocked,'existing_data_changed'): self.plan()
        self.assertFalse(self.ops.plan_path().exists())

    def test_approval_permissions_age_config_source_backup_before_stop(self):
        approval = self.plan()
        for attr,value in [('owner',1000),('mode',0o644),('time',100000),('cfg','0'*64),('bad_backup',True)]:
            old = getattr(self.ops,attr);setattr(self.ops,attr,value)
            with self.assertRaises(m.Blocked): self.ops.apply(approval)
            setattr(self.ops,attr,old)
            self.assertNotIn('stop_worker',self.ops.events)
        with self.assertRaisesRegex(m.Blocked,'plan_approval'): self.ops.apply('0'*64)
        self.ops.state['active']['revision']='d'*40
        with self.assertRaisesRegex(m.Blocked,'stale_plan'): self.ops.apply(approval)
        self.ops.state['active']['revision']=ACTIVE['revision']
        self.ops.evidence['snapshotId']='snap-99'
        with self.assertRaisesRegex(m.Blocked,'backup_changed'): self.ops.apply(approval)
        self.assertNotIn('stop_worker',self.ops.events)

    def test_stops_snapshots_then_migrates_verifies_and_resumes_bridge(self):
        approval = self.plan()
        result = self.ops.apply(approval)
        self.assertTrue(result['existingDataPreserved'])
        self.assertFalse(result['intakeEnabled'])
        e = self.ops.events
        self.assertLess(e.index('stop_worker'),e.index('offline_snapshot'))
        self.assertLess(e.index('stop_web'),e.index('offline_snapshot'))
        self.assertLess(e.index('offline_snapshot'),e.index(('migrate','evn-marketing-data')))
        self.assertLess(e.index(('migrate','evn-marketing-data')),e.index('recover'))
        self.assertEqual(self.ops.state['phase'],'stable')

    def test_unknown_writer_prevents_live_migration(self):
        approval=self.plan();self.ops.unknown_writer=True
        with self.assertRaisesRegex(m.Blocked,'volume_writer_running'): self.ops.apply(approval)
        self.assertNotIn(('migrate','evn-marketing-data'),self.ops.events)
        self.assertEqual(self.ops.state['phase'],'maintenance')

    def test_partial_migration_stays_stopped_and_resume_does_not_repair(self):
        approval=self.plan();self.ops.migration_failure='partial'
        with self.assertRaises(m.Blocked): self.ops.apply(approval)
        self.assertEqual(self.ops.state['phase'],'maintenance')
        with self.assertRaisesRegex(m.Blocked,'schema'): self.ops.resume_landing()
        self.assertNotIn('recover',self.ops.events)
        self.assertEqual(self.ops.events.count(('migrate','evn-marketing-data')),1)

    def test_lost_response_after_completed_migration_can_resume_with_preservation(self):
        approval=self.plan();self.ops.migration_failure='lost_response'
        with self.assertRaises(m.Blocked): self.ops.apply(approval)
        self.ops.cfg='0'*64
        with self.assertRaisesRegex(m.Blocked,'configuration_changed'): self.ops.resume_landing()
        self.ops.cfg='f'*64
        self.ops.resume_landing()
        self.assertEqual(self.ops.state['phase'],'stable')
        self.assertEqual(self.ops.events.count(('migrate','evn-marketing-data')),1)

    def test_changed_data_and_recovery_failure_remain_recorded(self):
        approval=self.plan();self.ops.bad_data=True
        with self.assertRaisesRegex(m.Blocked,'existing_data_changed'): self.ops.apply(approval)
        with self.assertRaisesRegex(m.Blocked,'existing_data_changed'): self.ops.resume_landing()
        self.assertNotIn('recover',self.ops.events)
        self.ops.bad_data=False;self.ops.bad_recover=True
        with self.assertRaises(m.Blocked): self.ops.resume_landing()
        self.assertEqual(self.ops.state['phase'],'maintenance')
        self.assertEqual(self.ops.state['maintenance']['stage'],'expanded-verified')
        self.ops.bad_recover=False;self.ops.resume_landing()
        self.assertEqual(self.ops.state['phase'],'stable')

    def test_intake_and_unknown_schema_are_not_general_expansion_allowances(self):
        self.ops.config['landingIntakeEnabled']=True
        with self.assertRaisesRegex(m.Blocked,'intake_must_be_disabled'): self.plan()
        self.ops.config['landingIntakeEnabled']=False
        with self.assertRaisesRegex(m.Blocked,'ops_source_mismatch'):
            self.ops.targets(CANDIDATE,{**OPERATIONS,'revision':'d'*40})
        self.assertFalse(self.ops.plan_path().exists())


if __name__ == '__main__': unittest.main()
