"""Host ordering and fail-closed guards. AWS effects are modeled, not executed."""
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

DEPLOY = Path(__file__).resolve().parents[1] / 'deploy'
sys.path.insert(0, str(DEPLOY))
spec = importlib.util.spec_from_file_location('data_ops', DEPLOY / 'data-ops.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
active = {'revision': 'a'*40, 'digest': 'sha256:'+'a'*64, 'slot':'blue','owner':'00000000-0000-4000-8000-000000000001'}


class Fake(m.DataOps):
    def __init__(self, root):
        self.root = root
        self.state_file = root / 'state/release.json'
        self.config = {'volume':'evn-marketing-data','volumeId':'synthetic','ebsVolumeId':'vol-01','repository':'synthetic/evn-marketing','network':'evn-marketing'}
        self.state = {'format':1,'phase':'stable','active':active.copy(),'previous':None}
        self.live = {'evn-marketing-worker','evn-marketing-web-blue'}
        self.events = []
        self.fail_data = False
        self.fail_lease = False
        self.encrypted = True
        self.restored_ebs = 'vol-02'
        self.snapshot_state = 'completed'

    def now(self): return 10100
    def volume(self): return self.root
    def encrypted_storage(self, directory, expected_volume=None, expected_snapshot=None):
        m.require(self.encrypted, 'encrypted_storage_required')
        return expected_volume or self.restored_ebs
    def running(self,name): return name in self.live
    def identity(self,*args): pass
    def check_schema(self,*args): self.events.append('schema')
    def retire(self):
        previous = self.state.get('previous')
        if previous and not previous.get('drained'):
            self.events.append('retire')
            if getattr(self, 'fail_retire', False): raise m.Blocked('proxy_drain_timeout')
            self.save(previous={**previous, 'drained':True})
    def stop_worker(self,*args): self.events.append('stop_worker'); self.live.discard('evn-marketing-worker')
    def stop_web(self,release): self.events.append('stop_web'); self.live.discard(self.web_name(release))
    def lease_clear(self,*args,**kwargs): m.require(not self.fail_lease,'lease_not_released')
    def inspect(self,name): return {'Name':'/'+name,'Mounts':[{'Name':'evn-marketing-data','RW':True}]}
    def docker(self,*args,**kwargs):
        if args[:2] == ('ps','-q'): return '\n'.join(self.live)
        if args[:2] == ('volume','ls'): return 'evn-marketing-data'
        if 'console.log(JSON.stringify([process.getuid(),process.getgid()]))' in args: return '[1000,1000]'
        if args[-2:] == ('id','-u'): return str(os.getuid())
        self.events.append(args)
        if 'warp-recovery.mjs' in args:
            self.recovery_environment = kwargs.get('env',{})
            return '{"status":"ok","selected":1}'
        return ''
    def data_command(self,arguments,mounts):
        m.require(not self.fail_data,'data_verification')
        if arguments[0] == 'snapshot':
            assert 'evn-marketing-worker' not in self.live and self.state['phase'] == 'maintenance'
        self.events.append(arguments[0])
        return {'ok':True,'summarySha256':'b'*64,'restoreSeconds':0.1,'rows':{},'files':0}
    def recover(self): self.events.append('resume'); self.live.update(('evn-marketing-worker','evn-marketing-web-blue'))
    def aws(self,*args):
        self.events.append(args[0])
        assert self.live, 'snapshotting occurs after live service resumes'
        snapshot = {'SnapshotId':'snap-01','StartTime':'1970-01-01T02:46:40Z','Encrypted':True,'VolumeId':'vol-01','State':self.snapshot_state}
        return snapshot if args[0] == 'create-snapshot' else {'Snapshots':[snapshot]}


class Checks(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        (self.root/'state').mkdir()
        self.ops = Fake(self.root)
    def tearDown(self): self.tmp.cleanup()

    def test_backup_stops_every_writer_and_never_forges_restore_proof(self):
        result = self.ops.backup()
        self.assertFalse(result['restoreVerified'])
        self.assertFalse((self.root/'state/backup.json').exists())
        self.assertLess(self.ops.events.index('stop_web'),self.ops.events.index('snapshot'))
        self.assertLess(self.ops.events.index('snapshot'),self.ops.events.index('resume'))
        self.assertLess(self.ops.events.index('resume'),self.ops.events.index('create-snapshot'))
        self.assertEqual(self.ops.state['phase'],'stable')

    def test_keep_web_preserves_service_and_resumes_worker_on_copy_failure(self):
        self.ops.backup(keep_web=True)
        self.assertNotIn('stop_web', self.ops.events)
        self.assertIn('stop_worker', self.ops.events)
        self.assertIn('evn-marketing-web-blue', self.ops.live)
        self.ops.fail_data = True
        with self.assertRaises(m.Blocked): self.ops.backup(keep_web=True)
        self.assertEqual(self.ops.state['phase'], 'stable')
        self.assertIn('evn-marketing-worker', self.ops.live)

    def test_backup_failure_persists_maintenance_and_explicit_resume(self):
        self.ops.fail_data = True
        with self.assertRaises(m.Blocked): self.ops.backup()
        self.assertEqual(self.ops.state['phase'],'maintenance')
        self.assertFalse(self.ops.live)
        with self.assertRaisesRegex(m.Blocked,'manual_reconciliation_required'):
            m.Controller.recover(self.ops)
        self.ops.resume()
        self.assertEqual(self.ops.state['phase'],'stable')

    def test_unknown_writer_blocks_copy(self):
        self.ops.live.add('unexpected-cli')
        with self.assertRaisesRegex(m.Blocked,'volume_writer_running'): self.ops.backup()
        self.assertNotIn('snapshot',self.ops.events)

    def test_retained_previous_does_not_block_backup_and_offline_mode_drains_first(self):
        for keep_web in (True, False):
            with self.subTest(keep_web=keep_web):
                ops = Fake(self.root)
                previous = {**active,'revision':'b'*40,'digest':'sha256:'+'b'*64,'slot':'green','drained':False}
                ops.state['previous'] = previous
                ops.live.add('evn-marketing-web-green')
                ops.backup(keep_web=keep_web)
                self.assertEqual(ops.state['phase'],'stable')
                if keep_web:
                    self.assertNotIn('retire',ops.events)
                    self.assertNotIn('stop_web',ops.events)
                    self.assertFalse(ops.state['previous']['drained'])
                    self.assertIn('evn-marketing-web-green',ops.live)
                    ops.fail_data = True
                    with self.assertRaisesRegex(m.Blocked,'data_verification'): ops.backup(keep_web=True)
                    self.assertEqual(ops.state['phase'],'stable')
                    self.assertIn('evn-marketing-worker',ops.live)
                    self.assertIn('evn-marketing-web-green',ops.live)
                else:
                    self.assertTrue(ops.state['previous']['drained'])
                    self.assertLess(ops.events.index('retire'),ops.events.index('stop_worker'))
                    self.assertEqual(ops.events.count('stop_web'),2)

    def test_encryption_or_failed_drain_blocks_before_worker_stop(self):
        self.ops.encrypted = False
        with self.assertRaises(m.Blocked): self.ops.backup()
        self.assertNotIn('stop_worker',self.ops.events)
        self.ops.encrypted = True
        self.ops.state['previous'] = {**active,'slot':'green','drained':False}
        self.ops.fail_retire = True
        with self.assertRaisesRegex(m.Blocked,'proxy_drain_timeout'): self.ops.backup()
        self.assertNotIn('stop_worker',self.ops.events)
        self.assertNotIn('stop_web',self.ops.events)
        self.assertNotIn('snapshot',self.ops.events)

    def test_only_completed_snapshot_separate_restore_publishes_gate(self):
        result = self.ops.backup()
        bundle = self.root/'bundle'; bundle.mkdir()
        self.ops.snapshot_state = 'pending'
        with self.assertRaisesRegex(m.Blocked,'snapshot_unavailable'):
            self.ops.verify_snapshot_restore(result['backupId'],bundle)
        self.ops.snapshot_state = 'completed'
        self.ops.restored_ebs = 'vol-01'
        with self.assertRaisesRegex(m.Blocked,'separate_restore_required'):
            self.ops.verify_snapshot_restore(result['backupId'],bundle)
        self.ops.restored_ebs = 'vol-02'
        proof = self.ops.verify_snapshot_restore(result['backupId'],bundle)
        self.assertTrue(proof['restoreVerified'])
        self.assertFalse(proof['activated'])
        self.assertTrue(proof['restoreVolume'].startswith('evn-marketing-restore-'))
        stored = json.loads((self.root/'state/backup.json').read_text())
        self.assertTrue(stored['consistent'])
        self.assertEqual(stored['manifestSha256'],'b'*64)
        self.assertEqual(stored['restoreVerifiedAt'],10100)

    def test_real_storage_guard_checks_device_encryption_and_snapshot(self):
        responses = {'findmnt': {'filesystems':[{'source':'/dev/nvme1n1'}]},
                     'lsblk': {'blockdevices':[{'type':'disk','serial':'vol01'}]}}
        self.ops.command = lambda args,**kw: json.dumps(responses[args[0]])
        volume = {'Encrypted':True,'SnapshotId':'snap-02'}
        self.ops.aws = lambda *args: {'Volumes':[volume]}
        self.assertEqual(m.DataOps.encrypted_storage(self.ops,self.root.resolve(),'vol-01','snap-02'),'vol-01')
        volume['Encrypted'] = False
        with self.assertRaises(m.Blocked): m.DataOps.encrypted_storage(self.ops,self.root.resolve(),'vol-01')
        volume['Encrypted'] = True
        with self.assertRaises(m.Blocked): m.DataOps.encrypted_storage(self.ops,self.root.resolve(),expected_snapshot='snap-03')
        with self.assertRaises(m.Blocked): m.DataOps.encrypted_storage(self.ops,self.root.resolve(),'vol-99')

    def test_recovery_plan_offline_and_approval_before_secret_or_stop(self):
        directory = self.root/'recovery'; directory.mkdir(mode=0o700)
        file = directory/'input.json'; file.write_text('[]'); file.chmod(0o600)
        self.ops.receipt_recovery(str(file),output=str(directory/'plan.json'))
        self.assertEqual(self.ops.state['phase'],'stable')
        command = next(e for e in self.ops.events if isinstance(e,tuple) and 'warp-recovery.mjs' in e)
        self.assertIn('none',command)
        self.assertNotIn('WARP_MARKETING_API_KEY',command)
        with self.assertRaisesRegex(m.Blocked,'recovery_approval'):
            self.ops.receipt_recovery(str(file),approval='0'*64)
        self.assertEqual(self.ops.state['phase'],'stable')
        self.ops.config.update(network='evn-marketing',parameters={'WARP_MARKETING_API_KEY':'/evn-marketing/production/warp-api-key'})
        file.write_text(' ' * 32769)
        with self.assertRaisesRegex(m.Blocked,'recovery_approval'):
            self.ops.receipt_recovery(str(file),approval=hashlib.sha256(file.read_bytes()).hexdigest())
        self.assertEqual(self.ops.state['phase'],'stable')
        self.assertNotIn('stop_worker',self.ops.events)
        file.write_text('[]')
        self.ops.command = lambda args,**kw: json.dumps({'Parameter':{'Name':args[6],'Type':'SecureString','Value':'synthetic-recovery-key-not-a-real-key'}})
        result = self.ops.receipt_recovery(str(file),approval=hashlib.sha256(file.read_bytes()).hexdigest())
        self.assertEqual(result['status'],'ok')
        self.assertIn('WARP_MARKETING_API_KEY',self.ops.recovery_environment)
        self.assertNotIn('synthetic-recovery-key-not-a-real-key',str(self.ops.events))
        self.assertEqual(self.ops.state['phase'],'stable')

    def test_migration_only_unused_restore_volume_with_matching_source(self):
        target = 'evn-marketing-restore-00000000-0000-4000-8000-000000000001'
        digest = 'sha256:'+'b'*64
        with self.assertRaisesRegex(m.Blocked,'ops_identity'):
            self.ops.migrate_check('evn-marketing-data',digest)
        volume = {'Labels':{'evn.marketing.restore':'true'},'Driver':'local'}
        mismatch = False
        calls = []
        def docker(*args,**kwargs):
            calls.append(args)
            if args[:2] == ('volume','inspect'): return json.dumps([volume])
            if args[:2] == ('ps','-q'): return ''
            if args[-1] == '/app/schema-manifest.json':
                return json.dumps({'revision': 'b'*40 if mismatch and digest in args[-2] else 'a'*40})
            return ''
        self.ops.docker = docker
        volume['Labels'] = {}
        with self.assertRaisesRegex(m.Blocked,'restore_volume_required'): self.ops.migrate_check(target,digest)
        volume['Labels'] = {'evn.marketing.restore':'true'}
        mismatch = True
        with self.assertRaisesRegex(m.Blocked,'ops_source_mismatch'): self.ops.migrate_check(target,digest)
        self.assertFalse(any('prisma' in call for call in calls))
        mismatch = False
        self.assertTrue(self.ops.migrate_check(target,digest)['unchangedSchema'])
        self.assertFalse(any('evn-marketing-data:/data' in call for call in calls))


if __name__ == '__main__': unittest.main()
