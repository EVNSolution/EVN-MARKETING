"""State-machine/fault tests; Docker/AWS/TLS effects are modelled explicitly, not production evidence."""
import copy
import importlib.util
import json
import multiprocessing
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('controller', Path(__file__).resolve().parents[1] / 'deploy/controller.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
A = {'revision': 'a' * 40, 'digest': 'sha256:' + 'a' * 64, 'slot': 'blue', 'owner': '00000000-0000-4000-8000-000000000001'}
B = {'revision': 'b' * 40, 'digest': 'sha256:' + 'b' * 64, 'slot': 'green', 'owner': '00000000-0000-4000-8000-000000000002'}
CONFIG = {'proxyImage':'nginx@sha256:'+'d'*64, 'repository': '123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/evn-marketing', 'publicUrl': 'https://marketing.example.invalid',
          'volumeId': 'synthetic-volume', 'volume': 'evn-marketing-data', 'network': 'evn-marketing', 'ebsVolumeId': 'vol-00000001',
          'collectorEnabled': True, 'warpDeliveryEnabled': True, 'minFreeMemoryMiB': 1024, 'minFreeDiskMiB': 4096}
BOOTSTRAP_CONFIG = {**CONFIG, 'collectorEnabled': False, 'warpDeliveryEnabled': False}


class Fake(module.Controller):
    def __init__(self, root):
        super().__init__(root)
        self.clock = 10000
        self.webs = {'blue': copy.deepcopy(A)}
        self.worker = copy.deepcopy(A)
        self.public = copy.deepcopy(A)
        self.events = []
        self.failures = set()
        self.business_data = {'newCustomer': 'preserved', 'receipt': 'preserved'}

    def event(self, event):
        self.events.append(event)
        if event in self.failures:
            self.failures.remove(event)
            raise module.Blocked('injected_' + event)

    def now(self):
        return self.clock

    def monotonic(self):
        return self.clock

    def wait(self, seconds):
        self.clock += seconds

    def identity(self, name, release):
        self.event('identity')

    def healthy_web(self, release, public=False):
        self.event(('public_' if public else 'ready_') + release['slot'])
        assert self.webs[release['slot']]['digest'] == release['digest']
        if public:
            assert self.public['digest'] == release['digest']

    def probe(self, release, public=False):
        self.event('probe_' + release['slot'])
        assert self.public['digest'] == release['digest']

    def check_schema(self, release, other):
        self.event('schema')

    def preflight(self, release, other):
        self.event('preflight')
        self.check_schema(release, other)

    def start(self, release, worker=False):
        if worker:
            assert self.worker is None, 'must prove the other worker stopped'
            self.event('start_worker_' + release['slot'])
            self.worker = copy.deepcopy(release)
        else:
            self.event('start_web_' + release['slot'])
            assert release['slot'] not in self.webs
            self.webs[release['slot']] = copy.deepcopy(release)

    def stop_worker(self, release):
        self.event('stop_worker_' + release['slot'])
        if self.worker:
            assert self.worker['digest'] == release['digest']
        self.worker = None

    def worker_ready(self, release, retry=True):
        self.event('worker_ready_' + release['slot'])
        assert self.worker and self.worker['digest'] == release['digest']

    def activate_worker(self, release):
        self.event('activate_' + release['slot'])
        assert self.worker['digest'] == release['digest']

    def running(self, name):
        if name == 'evn-marketing-worker':
            return self.worker is not None
        return name.removeprefix('evn-marketing-web-') in self.webs

    def inspect(self, name):
        item = self.worker if name == 'evn-marketing-worker' else self.webs[name.removeprefix('evn-marketing-web-')]
        return {'Config': {'Labels': {'evn.marketing.revision': item['revision']}}}

    def lease_clear(self, release, allow_expired=False):
        self.event('lease_clear')
        assert self.worker is None

    def proxy(self, active, previous=None):
        self.event('proxy_' + active['slot'])
        self.public = copy.deepcopy(active)
        return ['old-proxy-worker']

    def drained_proxy(self, workers):
        self.event('proxy_drained')

    def stop_web(self, release):
        self.event('stop_web_' + release['slot'])
        self.webs.pop(release['slot'], None)


class BootstrapFake(module.Controller):
    def __init__(self, root):
        super().__init__(root)
        self.names = set()
        self.live = set()
        self.events = []
        self.fail_public = False
        self.unknown_proxy = False

    def docker(self, *args, **kwargs):
        if args[:2] == ('network', 'inspect'):
            return json.dumps([{'Name': self.config['network']}])
        if args[:2] == ('volume', 'inspect'):
            return json.dumps([{'Name': self.config['volume'], 'Driver': 'local', 'Options': None,
                                'Mountpoint': '/synthetic/volume'}])
        if args[0] == 'pull':
            self.events.append('pull')
            return ''
        if args[:2] == ('image', 'inspect'):
            reference = args[2]
            return json.dumps([{'Id': 'proxy-image' if reference == self.config['proxyImage'] else 'app-image',
                                'RepoDigests': [reference], 'Architecture': 'amd64',
                                'Config': {'Labels': {'org.opencontainers.image.revision': A['revision']}}}])
        if args[:2] == ('ps', '-a'):
            return '\n'.join(sorted(self.names))
        if args[:2] == ('ps', '--format'):
            return '\n'.join(sorted(self.live))
        if args[0] == 'create':
            self.events.append(('create', args))
            self.names.add('evn-marketing-proxy')
            return 'proxy'
        if args[0] == 'start':
            self.events.append('start_' + args[1])
            self.live.add(args[1])
            return args[1]
        raise AssertionError(args)

    def running(self, name):
        return name in self.live

    def inspect(self, name):
        if name == 'other':
            return {'Mounts': [{'Destination': '/data', 'Name': self.config['volume']}]}
        if name == 'evn-marketing-proxy':
            return {'Image': 'proxy-image', 'Config': {'Labels': {
                        'evn.marketing.managed': 'false' if self.unknown_proxy else 'true'}},
                    'HostConfig': {'PortBindings': {'8080/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '3080'}]}},
                    'NetworkSettings': {'Networks': {self.config['network']: {}}},
                    'Mounts': [{'Destination': '/etc/nginx', 'Source': str(self.root / 'nginx'), 'RW': False}],
                    'State': {'OOMKilled': False}}
        return {'Image': 'app-image',
                'Config': {'Labels': {'evn.marketing.managed': 'true', 'evn.marketing.revision': A['revision']}},
                'HostConfig': {'PortBindings': {'3000/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '3100'}]}},
                'NetworkSettings': {'Networks': {self.config['network']: {}}},
                'Mounts': [{'Destination': '/data', 'Name': self.config['volume']}],
                'State': {'OOMKilled': False}}

    def check_schema(self, release, other):
        self.events.append('schema')

    def lease_clear(self, release, allow_expired=False):
        self.events.append('lease')

    def start(self, release, worker=False):
        assert not worker
        name = self.web_name(release)
        self.events.append('start_web')
        self.names.add(name)
        self.live.add(name)

    def healthy_web(self, release, public=False):
        self.events.append('public' if public else 'ready')
        if public and self.fail_public:
            raise module.Blocked('readiness')

    def proxy(self, active, previous=None):
        self.events.append('proxy')
        self.live.add('evn-marketing-proxy')
        return []


def lock_attempt(root, output):
    try:
        with module.host_lock(Path(root)):
            output.put('acquired')
    except module.Blocked:
        output.put('host_busy')


class Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='marketing-deploy-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'state').mkdir()
        (self.root / 'config.json').write_text(json.dumps(CONFIG))
        (self.root / 'state/release.json').write_text(json.dumps({'format': 1, 'phase': 'stable', 'active': A, 'previous': None}))
        self.c = Fake(self.root)

    def bootstrap_controller(self):
        (self.root / 'config.json').write_text(json.dumps(BOOTSTRAP_CONFIG))
        (self.root / 'state/release.json').unlink(missing_ok=True)
        module.bootstrap_journal(self.root, A['revision'], A['digest'])
        return BootstrapFake(self.root)

    def test_bootstrap_stays_blocked_until_public_readiness_then_resumes(self):
        controller = self.bootstrap_controller()
        controller.fail_public = True
        with self.assertRaisesRegex(module.Blocked, 'readiness'):
            controller.bootstrap()
        self.assertEqual(controller.state['phase'], 'bootstrapping')
        with self.assertRaisesRegex(module.Blocked, 'recovery_required'):
            controller.release(B['revision'], B['digest'])
        with self.assertRaisesRegex(module.Blocked, 'manual_reconciliation_required'):
            controller.recover()
        controller.fail_public = False
        controller.bootstrap()
        self.assertEqual(controller.state['phase'], 'stable')
        self.assertNotIn('evn-marketing-worker', controller.names)
        create = next(event[1] for event in controller.events if isinstance(event, tuple) and event[0] == 'create')
        self.assertIn('127.0.0.1:3080:8080', create)

    def test_bootstrap_refuses_mismatch_stable_state_workers_and_unknown_containers(self):
        controller = self.bootstrap_controller()
        with self.assertRaisesRegex(module.Blocked, 'bootstrap_state'):
            module.bootstrap_journal(self.root, B['revision'], B['digest'])
        controller.config['collectorEnabled'] = True
        with self.assertRaisesRegex(module.Blocked, 'bootstrap_workers_enabled'):
            controller.bootstrap()
        controller.config['collectorEnabled'] = False
        controller.names.add('evn-marketing-worker')
        with self.assertRaisesRegex(module.Blocked, 'bootstrap_unknown_container'):
            controller.bootstrap()
        self.assertFalse(any(event == 'rm' for event in controller.events))
        controller.names.clear()
        controller.names.add('other')
        controller.live.add('other')
        with self.assertRaisesRegex(module.Blocked, 'bootstrap_volume_busy'):
            controller.bootstrap()
        controller.names.clear()
        controller.live.clear()
        controller.names.add('evn-marketing-proxy')
        controller.unknown_proxy = True
        with self.assertRaisesRegex(module.Blocked, 'bootstrap_unknown_container'):
            controller.bootstrap()
        self.assertNotIn('start_web', controller.events)
        controller.names.clear()
        controller.unknown_proxy = False
        controller.bootstrap()
        with self.assertRaisesRegex(module.Blocked, 'bootstrap_state'):
            module.bootstrap_journal(self.root, A['revision'], A['digest'])

    def test_bootstrap_journal_rejects_dangling_symlink(self):
        path = self.root / 'state/release.json'
        path.unlink()
        path.symlink_to(self.root / 'missing-release.json')
        with self.assertRaisesRegex(module.Blocked, 'unsafe_host_permissions'):
            module.bootstrap_journal(self.root, A['revision'], A['digest'])

    def test_container_memory_limits_reach_docker_run(self):
        controller = module.Controller(self.root)
        for worker, name, memory in ((False, 'evn-marketing-web-blue', '384m'),
                                     (True, 'evn-marketing-worker', '768m')):
            secrets = {'AUTH_SECRET': 'synthetic-auth'}
            if worker:
                secrets.update(MLEVERAGE_USERNAME='synthetic-user', MLEVERAGE_PASSWORD='synthetic-password',
                               WARP_MARKETING_API_KEY='synthetic-warp-key')
            with self.subTest(worker=worker), patch.object(controller, 'docker', return_value='') as docker, \
                    patch.object(controller, 'secrets', return_value=secrets), patch.object(controller, 'identity'):
                controller.start(A, worker=worker)
                runs = [call.args for call in docker.call_args_list if call.args[0] == 'run']
                self.assertEqual(len(runs), 1)
                self.assertEqual(runs[0][runs[0].index('--name') + 1], name)
                self.assertEqual(runs[0][runs[0].index('--memory') + 1], memory)
                passed = docker.call_args_list[-1].kwargs['env']
                self.assertEqual(passed['WARP_DELIVERY_ENABLED'], 'true')
                self.assertEqual('WARP_MARKETING_API_KEY' in runs[0], worker)

        controller.config['warpDeliveryEnabled'] = False
        with patch.object(controller, 'docker', return_value='') as docker, \
                patch.object(controller, 'secrets', return_value={'AUTH_SECRET': 'synthetic-auth'}), patch.object(controller, 'identity'):
            controller.start(A)
            self.assertEqual(docker.call_args_list[-1].kwargs['env']['WARP_DELIVERY_ENABLED'], 'false')

    def test_success_rollback_and_window(self):
        self.c.release(B['revision'], B['digest'])
        self.assertEqual(self.c.state['active']['digest'], B['digest'])
        self.assertEqual(self.c.state['phase'], 'stable')
        self.assertTrue(self.c.state['previous']['drained'])
        self.assertEqual(self.c.events.count('probe_green'), module.WINDOW)
        self.assertLess(self.c.events.index('stop_worker_blue'), self.c.events.index('start_worker_green'))
        self.assertLess(self.c.events.index('worker_ready_green'), self.c.events.index('activate_green'))
        self.c.release('', '', rollback=True)
        self.assertEqual(self.c.state['active']['digest'], A['digest'])
        self.assertEqual(self.c.business_data, {'newCustomer': 'preserved', 'receipt': 'preserved'})

    def test_preflight_failure_leaves_active_untouched(self):
        self.c.failures = {'preflight'}
        with self.assertRaises(module.Blocked):
            self.c.release(B['revision'], B['digest'])
        self.assertEqual(self.c.worker, A)
        self.assertEqual(self.c.public, A)
        self.assertEqual(self.c.state['phase'], 'stable')

    def test_candidate_failure_does_not_stop_active_worker(self):
        for failure in ('start_web_green', 'ready_green'):
            with self.subTest(failure=failure):
                self.c.failures = {failure}
                with self.assertRaisesRegex(module.Blocked, 'release_reverted'):
                    self.c.release(B['revision'], B['digest'])
                self.assertEqual(self.c.worker, A)
                self.assertNotIn('stop_worker_blue', self.c.events)
                self.assertEqual(self.c.state['active'], A)

    def test_each_post_drain_failure_restores_old_pair(self):
        for failure in ('proxy_green', 'public_green', 'start_worker_green', 'worker_ready_green', 'probe_green'):
            with self.subTest(failure=failure):
                c = Fake(self.root)
                c.failures = {failure}
                with self.assertRaisesRegex(module.Blocked, 'release_reverted'):
                    c.release(B['revision'], B['digest'])
                self.assertEqual(c.state['phase'], 'stable')
                self.assertEqual(c.public, A)
                self.assertEqual(c.worker, A)
                self.assertEqual(c.business_data['receipt'], 'preserved')

    def test_unfinished_journal_recovers_origin_after_process_death(self):
        self.c.save(phase='switching', origin=A, candidate=B)
        recovered = Fake(self.root)
        recovered.public, recovered.worker = copy.deepcopy(B), copy.deepcopy(B)
        recovered.webs['green'] = copy.deepcopy(B)
        recovered.recover()
        self.assertEqual(recovered.state['active'], A)
        self.assertEqual(recovered.worker, A)

    def test_unknown_or_unstoppable_worker_blocks(self):
        self.c.save(phase='starting', origin=A, candidate=B)
        self.c.worker = {**B, 'revision': 'c' * 40}
        with self.assertRaisesRegex(module.Blocked, 'unknown_worker'):
            self.c.recover()
        self.assertNotIn('start_worker_blue', self.c.events)
        self.c.worker = B
        self.c.failures = {'stop_worker_green'}
        with self.assertRaises(module.Blocked):
            self.c.recover()
        self.assertNotIn('start_worker_blue', self.c.events)

    def test_slot_reuse_waits_for_window_and_proxy_drain(self):
        self.c.webs['green'] = B
        self.c.save(previous={**B, 'expiresAt': self.c.clock + 30, 'drained': False})
        with self.assertRaisesRegex(module.Blocked, 'compatibility_window'):
            self.c.release('c' * 40, 'sha256:' + 'c' * 64)
        self.assertNotIn('stop_web_green', self.c.events)
        self.c.clock += 30
        self.c.failures = {'proxy_drained'}
        with self.assertRaises(module.Blocked):
            self.c.release('c' * 40, 'sha256:' + 'c' * 64)
        self.assertEqual(self.c.state['phase'], 'retiring')
        self.assertNotIn('stop_web_green', self.c.events)
        self.c.recover()
        self.assertTrue(self.c.state['previous']['drained'])

    def test_reboot_starts_only_recorded_active(self):
        self.c.webs.clear()
        self.c.worker = None
        self.c.recover()
        self.assertEqual(set(self.c.webs), {'blue'})
        self.assertEqual(self.c.worker, A)
        self.assertEqual(self.c.state['phase'], 'stable')

    def test_lock_is_shared_between_real_processes(self):
        ctx = multiprocessing.get_context('fork')
        output = ctx.Queue()
        with module.host_lock(self.root):
            child = ctx.Process(target=lock_attempt, args=(str(self.root), output))
            child.start()
            self.assertEqual(output.get(timeout=5), 'host_busy')
            child.join(timeout=5)
            self.assertEqual(child.exitcode, 0)
        child = ctx.Process(target=lock_attempt, args=(str(self.root), output))
        child.start()
        self.assertEqual(output.get(timeout=5), 'acquired')
        child.join(timeout=5)
        self.assertEqual(child.exitcode, 0)

    def test_atomic_journal_preserves_old_file_on_failed_replace(self):
        with patch.object(module.os, 'replace', side_effect=OSError('synthetic')):
            with self.assertRaises(OSError):
                module.atomic(self.c.state_file, 'unfinished')
        self.assertEqual(json.loads(self.c.state_file.read_text())['active'], A)
        self.assertEqual(list(self.c.state_file.parent.glob('*.tmp-*')), [])

    def test_real_backup_gate_rejects_stale_unencrypted_or_wrong_volume(self):
        c = module.Controller(self.root)
        record = {'snapshotId': 'snap-000001', 'volumeId': CONFIG['volumeId'], 'consistent': True,
                  'createdAt': 10000, 'restoreVerifiedAt': 10001, 'manifestSha256': 'a' * 64}
        file = self.root / 'state/backup.json'
        file.write_text(json.dumps(record))
        snapshot = {'State': 'completed', 'Encrypted': True, 'VolumeId': CONFIG['ebsVolumeId'], 'StartTime': '1970-01-01T02:46:40Z'}
        with patch.object(c, 'now', return_value=10002), patch.object(c, 'command') as command:
            for changed in ({'State':'pending'}, {'Encrypted':False}, {'VolumeId':'vol-ffff'}, {'StartTime':'1970-01-01T00:00:00Z'}):
                command.return_value = json.dumps({'Snapshots': [{**snapshot, **changed}]})
                with self.assertRaises(module.Blocked):
                    c.preflight(B, A)
            file.write_text(json.dumps({**record, 'createdAt': -90000}))
            command.reset_mock()
            with self.assertRaisesRegex(module.Blocked, 'backup_evidence'):
                c.preflight(B, A)
            command.assert_not_called()

    def test_command_failure_redacts_stdout_stderr_and_times_out(self):
        c = module.Controller(self.root)
        with patch.object(module.subprocess, 'run', return_value=type('Result', (), {'returncode':1,'stdout':'synthetic-secret','stderr':'synthetic-private'})()):
            with self.assertRaisesRegex(module.Blocked, '^command_failed$'):
                c.command(['synthetic'])

    def test_invalid_release_cannot_expire_proxy(self):
        self.c.save(previous={**B,'expiresAt':0,'drained':False})
        with self.assertRaisesRegex(module.Blocked, 'release_identity'):
            self.c.release('bad', 'bad')
        self.assertEqual(self.c.events, [])

    def test_readiness_keeps_three_consecutive_probes_with_spacing(self):
        c = module.Controller(self.root)
        for responses, calls, waits in (([None] * 3, 3, 2),
                                       ([None, module.Blocked('readiness'), None, None, None], 5, 4)):
            with self.subTest(calls=calls), patch.object(c, 'identity'), \
                    patch.object(c, 'probe', side_effect=responses) as probe, patch.object(c, 'wait') as wait:
                c.healthy_web(A, public=True)
                self.assertEqual(probe.call_count, calls)
                self.assertEqual(wait.call_count, waits)
                self.assertTrue(all(call.args == (1,) for call in wait.call_args_list))

    def test_schema_batches_metadata_but_rechecks_live_database(self):
        c = module.Controller(self.root)
        (self.root / 'releases').mkdir()
        def metadata(release):
            return json.dumps({'capability': '1\n', 'manifest': json.dumps({'revision': release['revision']})})
        for other in (A, B):
            replies = [metadata(A)] + ([] if other == A else [metadata(B)]) + [json.dumps({'ok': True})]
            with self.subTest(other=other['slot']), patch.object(c, 'docker', side_effect=replies * 2) as docker:
                c.check_schema(A, other)
                c.check_schema(A, other)
                self.assertEqual(docker.call_count, len(replies) * 2)
                for call in (docker.call_args_list[len(replies) - 1], docker.call_args_list[-1]):
                    self.assertIn(self.c.config['volume'] + ':/data', call.args)
                    self.assertIn('schema-check.mjs', call.args)
        for value, reason in (({'capability':'0', 'manifest':json.dumps({'revision':A['revision']})}, 'worker_gate_unsupported'),
                              ({'capability':'1', 'manifest':json.dumps({'revision':B['revision']})}, 'manifest_identity')):
            with self.subTest(reason=reason), patch.object(c, 'docker', return_value=json.dumps(value)), \
                    self.assertRaisesRegex(module.Blocked, reason):
                c.check_schema(A, A)
        with patch.object(c, 'docker', side_effect=[metadata(A), json.dumps({'ok': False})]), \
                self.assertRaisesRegex(module.Blocked, '^schema$'):
            c.check_schema(A, A)


class CompatibilityReloadTests(unittest.TestCase):
    """A reload signal must not acknowledge a completed browser fixture switch."""

    def script(self):
        fixture = (Path(__file__).resolve().parents[1] / 'tests/release-compat.sh').read_text()
        return fixture.split('python3 - "$phase" <<\'PY\'\n', 1)[1].split('\nPY', 1)[0]

    def test_both_phases_wait_for_old_workers(self):
        for phase in ('switch', 'expire'):
            with self.subTest(phase=phase), patch('sys.argv', ['-', phase]), \
                    patch('subprocess.check_output', side_effect=['/proc/8/cmdline\n', '/proc/8/cmdline\n', '/proc/9/cmdline\n']), \
                    patch('subprocess.run') as reload, patch('time.monotonic', return_value=0), patch('time.sleep') as sleep:
                exec(compile(self.script(), 'compatibility-reload-fixture', 'exec'), {})
                reload.assert_called_once()
                sleep.assert_called_once_with(0.2)

    def test_stuck_worker_fails_within_each_phase_deadline(self):
        for phase, expired in (('switch', 21), ('expire', 121)):
            with self.subTest(phase=phase), patch('sys.argv', ['-', phase]), \
                    patch('subprocess.check_output', return_value='/proc/8/cmdline\n'), \
                    patch('subprocess.run'), patch('time.monotonic', side_effect=[0, 0, expired]), patch('time.sleep'):
                with self.assertRaisesRegex(RuntimeError, 'compatibility proxy drain timed out'):
                    exec(compile(self.script(), 'compatibility-reload-fixture', 'exec'), {})


if __name__ == '__main__':
    unittest.main()
