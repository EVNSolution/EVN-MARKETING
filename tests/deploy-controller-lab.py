"""Isolated Docker acceptance; real-time observation is explicitly opt-in."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import threading
import ssl
import sys
import urllib.request
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('--real-time', action='store_true', help='observe one release for 1800 real seconds; default runs accelerated transitions and crash recovery')
parser.add_argument('--self-test', action='store_true', help='check lab timing without Docker or CI environment')
parser.add_argument('--report', type=Path)
parser.add_argument('--suite', choices=('full', 'transitions', 'recovery'), default='full')
options = parser.parse_args()
if options.real_time and options.suite != 'full':
    parser.error('real-time observation uses the full suite')
ROOT = Path.cwd()
TIMINGS = Path(os.environ['RUNNER_TEMP']) / 'marketing-controller-timings.jsonl' if os.environ.get('RUNNER_TEMP') else None
STARTED = time.monotonic()
spec = importlib.util.spec_from_file_location('controller', ROOT / 'deploy/controller.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

def record_timing(stage, started):
    if TIMINGS:
        # One append per record also preserves timings from abruptly terminated children.
        line = json.dumps({'stage': stage, 'seconds': round(time.monotonic() - started, 4)}) + '\n'
        fd = os.open(TIMINGS, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            os.write(fd, line.encode())
        finally:
            os.close(fd)


def command(*args):
    started = time.monotonic()
    try:
        return subprocess.check_output(args, text=True).strip()
    finally:
        record_timing('setup.' + '.'.join(args[:2]), started)

def docker(*args):
    return command('docker', *args)


class Lab(m.Controller):
    def command(self, args, **kwargs):
        started = time.monotonic()
        try:
            return super().command(args, **kwargs)
        finally:
            record_timing('controller.' + '.'.join(args[:2]), started)

    def __init__(self, root):
        super().__init__(root)
        self.clock = time.time()
        self.probes = 0
        self.real_time = False
        self.exercise_drain = False
        self.held = None
        self.drains = 0
        self.observation_start = None
        self.observation_seconds = None

    def now(self):
        return time.time() if self.real_time else self.clock

    def monotonic(self):
        return time.monotonic() if self.real_time else self.clock

    def wait(self, seconds):
        started = time.monotonic()
        if not self.real_time and self.state['phase'] == 'observing':
            self.clock += seconds * 30
            time.sleep(0.01)
        else:
            self.clock += seconds
            time.sleep(seconds)
        record_timing('wait.' + self.state['phase'], started)

    def save(self, **changes):
        if changes.get('phase') == 'switching':
            self.observation_start = time.monotonic()
        if changes.get('phase') == 'stable' and self.state['phase'] == 'observing':
            self.observation_seconds = time.monotonic() - self.observation_start
        return super().save(**changes)

    def secrets(self, worker):
        secrets = {'AUTH_SECRET': 'synthetic-lab-secret-at-least-32-characters'}
        if worker:
            secrets['MARKETING_TEST_LEASE_MS'] = str(180000 if self.real_time else 10000)
        return secrets

    def preflight(self, release, other):
        # No AWS resources in CI. Pure gate validation is covered by unit tests.
        self.docker('pull', self.image(release))
        self.check_schema(release, other)

    def probe(self, release, public=False):
        assert not (self.root/'control/traffic-failed').exists(), 'synthetic API load failed'
        result = super().probe(release, public)
        if public:
            self.probes += 1
        return result

    def render_proxy(self, active, previous=None):
        if previous and not self.real_time:
            previous = {**previous, 'expiresAt': time.time() + max(0, previous['expiresAt'] - self.clock)}
        return super().render_proxy(active, previous)

    def retire(self):
        previous = self.state.get('previous')
        if self.exercise_drain and previous and not previous.get('drained') and self.now() >= previous['expiresAt']:
            for name in ('held', 'finish-held', 'held-result.json'):
                (self.root/'control'/name).unlink(missing_ok=True)
            self.held = subprocess.Popen(['docker', 'exec', 'marketing-lab-traffic', 'node',
                '/src/tests/deploy-lab-traffic.mjs', 'hold', previous['revision']],
                stdout=subprocess.DEVNULL, stderr=None)
            deadline = time.monotonic() + 10
            while not (self.root/'control/held').exists():
                assert self.held.poll() is None and time.monotonic() < deadline, 'held upload did not start'
                time.sleep(0.05)
        return super().retire()

    def drained_proxy(self, workers):
        if self.held:
            try:
                assert set(workers) & set(self.proxy_workers()), 'long request did not retain the old proxy worker'
                time.sleep(2)
                current_workers = self.proxy_workers()
                assert self.held.poll() is None and set(workers) & set(current_workers), (
                    'request drained before its body completed', self.held.poll(), workers, current_workers,
                    (self.root/'control/held-result.json').read_text() if (self.root/'control/held-result.json').exists() else 'no held result')
                (self.root/'control/finish-held').touch()
                super().drained_proxy(workers)
                assert self.held.wait(timeout=15) == 0, 'held upload failed'
                result = json.loads((self.root/'control/held-result.json').read_text())
                assert result == {'ok': True, 'slot': self.state['previous']['slot']}
                self.drains += 1
            finally:
                if self.held.poll() is None:
                    self.held.kill()
                    self.held.wait(timeout=5)
                self.held = None
        else:
            super().drained_proxy(workers)


def self_test():
    from unittest.mock import patch

    assert m.WINDOW == 1800
    lab = Lab.__new__(Lab)
    lab.clock, lab.real_time, lab.state = 0, False, {'phase': 'observing'}
    with patch.object(time, 'sleep') as sleep:
        lab.wait(1)
        assert lab.clock == 30 and sleep.call_args.args == (0.01,)
        lab.state['phase'] = 'draining'
        lab.wait(1)
        assert lab.clock == 31 and sleep.call_args.args == (1,)
        lab.state['phase'], lab.real_time = 'observing', True
        lab.wait(1)
        assert lab.clock == 32 and sleep.call_args.args == (1,)
        lab.clock, lab.real_time = 0, False
        for _ in range(2):
            for _ in range(m.WINDOW // 30):
                lab.wait(1)
        assert lab.clock == 2 * m.WINDOW and 2 * (m.WINDOW // 30) == 120
    assert lab.secrets(True)['MARKETING_TEST_LEASE_MS'] == '10000'
    assert 'MARKETING_TEST_LEASE_MS' not in lab.secrets(False)
    lab.real_time = True
    assert lab.secrets(True)['MARKETING_TEST_LEASE_MS'] == '180000'
    assert 'MARKETING_TEST_LEASE_MS' not in lab.secrets(False)
    print(json.dumps({'ok': True, 'timingSelfTest': True, 'observationSteps': 120, 'dockerRun': False}))


if options.self_test:
    self_test()
    raise SystemExit(0)

assert os.environ.get('GITHUB_ACTIONS') == 'true', 'dedicated ephemeral CI runner only'

with tempfile.TemporaryDirectory(prefix='marketing-controller-lab-') as temporary:
    root = Path(temporary)
    os.chmod(root, 0o755)
    for directory in ('state', 'releases', 'nginx', 'deploy', 'tls', 'fixture', 'control'):
        (root / directory).mkdir()
    os.chmod(root/'control', 0o777)  # Isolated synthetic synchronization files, no credentials.
    shutil.copy(ROOT / 'deploy/nginx-config.mjs', root / 'deploy/nginx-config.mjs')
    names = ('evn-marketing-worker', 'evn-marketing-web-blue', 'evn-marketing-web-green', 'evn-marketing-proxy', 'marketing-lab-tls', 'marketing-lab-traffic', 'marketing-lab-registry')
    stopped = threading.Event()
    errors = []
    probes = []
    latencies = []
    probe_times = []
    fixture_lease_ms = 180000 if options.real_time else 10000
    summary = {'sourceSha': os.environ.get('GITHUB_SHA'), 'suite': options.suite, 'synthetic': True, 'aws': False,
               'hostReboot': False, 'ssmDisconnect': False, 'observations': [],
               'mode': 'real-time' if options.real_time else 'accelerated',
               'fixtureLeaseMs': fixture_lease_ms,
               'observationAccelerationFactor': 1 if options.real_time else 30}
    def observe():
        context = ssl.create_default_context(cafile=str(root/'tls/cert.pem'))
        while not stopped.is_set():
            try:
                started = time.monotonic()
                with urllib.request.urlopen('https://localhost:3443/api/readyz', context=context, timeout=5) as response:
                    value = json.load(response)
                    assert response.status == 200 and value['ok'] and value['revision'] in ('a'*40, 'b'*40)
                    probes.append(value['revision'])
                    latencies.append(time.monotonic() - started)
                    probe_times.append(started)
            except Exception:
                errors.append('public_probe_failed')
            stopped.wait(0.2)

    def start_traffic(seed_recovery=False):
        for file in (root/'control').iterdir():
            file.unlink()
        docker('run', '-d', '--name', 'marketing-lab-traffic', '--network', 'evn-marketing',
               '-v', str(ROOT)+':/src:ro', '-v', str(root/'control')+':/control',
               '-v', 'evn-marketing-data:/data:ro', 'evn-marketing:controller-base', 'node', '/src/tests/deploy-lab-traffic.mjs',
               *(['seed-recovery'] if seed_recovery else []))
        deadline = time.monotonic() + 30
        while not (root/'control/traffic-ready').exists():
            assert not (root/'control/traffic-failed').exists() and time.monotonic() < deadline, 'API traffic startup failed'
            time.sleep(0.1)

    def finish_traffic():
        (root/'control/stop').touch()
        assert command('docker', 'wait', 'marketing-lab-traffic') == '0', 'API traffic failed'
        result = json.loads((root/'control/traffic-result.json').read_text())
        assert result['errors'] == 0 and result['saves'] == result['uploads'] == result['downloads'] == result['reads'] > 0
        docker('rm', 'marketing-lab-traffic')
        return result
    assert not any(name in docker('ps', '-a', '--format', '{{.Names}}').splitlines() for name in names)
    assert 'evn-marketing' not in docker('network', 'ls', '--format', '{{.Name}}').splitlines()
    assert 'evn-marketing-data' not in docker('volume', 'ls', '--format', '{{.Name}}').splitlines()
    try:
        docker('network', 'create', '--internal', 'evn-marketing')
        docker('volume', 'create', 'evn-marketing-data')
        docker('run', '-d', '--name', 'marketing-lab-registry', '-p', '127.0.0.1:5000:5000', 'registry:2')
        proxy_tag = '127.0.0.1:5000/evn-marketing-proxy:ci'
        docker('image', 'inspect', 'evn-marketing:proxy-ci')
        docker('tag', 'evn-marketing:proxy-ci', proxy_tag)
        docker('push', proxy_tag)
        fixture = root / 'fixture'
        shutil.copy(ROOT / 'tests/deploy-lab-worker.mjs', fixture / 'worker.mjs')
        (fixture / 'Dockerfile').write_text('FROM evn-marketing:controller-base\nUSER root\nARG REVISION\nRUN node -e "const f=require(\'fs\');const p=\'/app/schema-manifest.json\';const m=JSON.parse(f.readFileSync(p));m.revision=process.env.REVISION;f.writeFileSync(p,JSON.stringify(m))"\nCOPY worker.mjs /app/worker.mjs\nUSER node\n')
        releases = []
        for character, slot in (('a', 'blue'), ('b', 'green')):
            revision = character * 40
            tag = '127.0.0.1:5000/evn-marketing:' + revision
            docker('build', '--builder', 'default', '--platform', 'linux/amd64', '--build-arg', 'REVISION=' + revision,
                   '--label', 'org.opencontainers.image.revision=' + revision, '-t', tag, str(fixture))
            docker('push', tag)
            digest = json.loads(docker('image', 'inspect', tag))[0]['RepoDigests'][0].split('@')[1]
            releases.append({'revision': revision, 'digest': digest, 'slot': slot, 'owner': str(uuid.uuid4())})
        a, b = releases
        # Create only a synthetic volume, then use the existing app's actual schema/readiness.
        docker('run', '--rm', '--network', 'none', '-v', str(ROOT) + ':/src:ro', '-v', 'evn-marketing-data:/data', 'evn-marketing:controller-base', 'node', '/src/tests/release-setup.mjs')
        docker('run', '--rm', '--network', 'none', '-v', 'evn-marketing-data:/data', 'evn-marketing:controller-base', 'node', '-e',
            "const D=require('better-sqlite3');const d=new D('/data/marketing.db');for(const id of ['synthetic-load-0','synthetic-load-1','synthetic-held'])d.prepare('INSERT INTO Customer(id,name,updatedAt) VALUES(?,?,?)').run(id,'Synthetic load',new Date().toISOString());d.close()")
        command('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', str(root/'tls/key.pem'), '-out', str(root/'tls/cert.pem'))
        config = {'proxyImage':json.loads(docker('image','inspect',proxy_tag))[0]['RepoDigests'][0], 'repository': '127.0.0.1:5000/evn-marketing', 'publicUrl': 'https://localhost:3443', 'caFile': str(root/'tls/cert.pem'),
                  'volumeId': 'synthetic-compat-volume', 'volume': 'evn-marketing-data', 'network': 'evn-marketing', 'ebsVolumeId': 'vol-000001',
                  'collectorEnabled': False, 'warpDeliveryEnabled': False, 'minFreeMemoryMiB': 256, 'minFreeDiskMiB': 1024}
        (root/'config.json').write_text(json.dumps(config))
        # Start the separate TLS front first; its Docker DNS target may appear during bootstrap.
        tls = 'events {}\nhttp { access_log off; resolver 127.0.0.11 valid=1s ipv6=off; server { listen 3443 ssl; ssl_certificate /tls/cert.pem; ssl_certificate_key /tls/key.pem; location / { set $upstream evn-marketing-proxy; proxy_set_header Host $http_host; proxy_pass http://$upstream:8080; } } }'
        (root/'tls/nginx.conf').write_text(tls)
        docker('run', '-d', '--name', 'marketing-lab-tls', '-p', '127.0.0.1:3443:3443', '-v', str(root/'tls') + ':/tls:ro', '-v', str(root/'tls/nginx.conf') + ':/etc/nginx/nginx.conf:ro', 'evn-marketing:proxy-ci')
        docker('network', 'connect', 'evn-marketing', 'marketing-lab-tls')
        with m.host_lock(root):
            m.bootstrap_journal(root, a['revision'], a['digest'])
            controller = Lab(root)
            controller.real_time = options.real_time
            controller.bootstrap()
        assert 'evn-marketing-worker' not in docker('ps', '-a', '--format', '{{.Names}}').splitlines()
        config['collectorEnabled'] = True
        (root/'config.json').write_text(json.dumps(config))
        controller = Lab(root)
        controller.real_time = options.real_time
        a = controller.state['active']
        releases[0] = a
        controller.start(a, worker=True)
        controller.worker_ready(a)
        controller.activate_worker(a)
        record_timing('section.setup', STARTED)
        transition_started = time.monotonic()
        if options.suite == 'recovery':
            start_traffic(seed_recovery=True)
            summary['traffic'] = finish_traffic()
        else:
            preflight_spec = importlib.util.spec_from_file_location('lab_preflight', ROOT/'tests/deploy-lab-preflight.py')
            preflight = importlib.util.module_from_spec(preflight_spec)
            preflight_spec.loader.exec_module(preflight)
            summary['preflightRejections'] = preflight.run_preflight(controller, root, b)
            start_traffic()
            controller.exercise_drain = True
            observer = threading.Thread(target=observe, daemon=True)
            observer.start()
            controller.release(b['revision'], b['digest'])
            assert controller.state['active']['digest'] == b['digest']
            assert controller.state['previous']['drained']
            if not options.real_time:
                summary['preflightRejections'] += preflight.run_preflight(controller, root, a, rollback=True)
                controller.release('', '', rollback=True)
                assert controller.state['active']['digest'] == a['digest']
                # Fast probes exercise two state transitions; they are not 3600 real seconds of observation.
                assert controller.probes >= 120
                assert controller.drains == 2
                controller.exercise_drain = False
                # Actual worker failure after the public switch must restore the old pair.
                original = controller.worker_ready
                def fail_worker(release, retry=True):
                    result = original(release, retry)
                    if release['slot'] == 'green':
                        raise m.Blocked('synthetic_source_login_failure')
                    return result
                controller.worker_ready = fail_worker
                try:
                    controller.release(b['revision'], b['digest'])
                    raise AssertionError('injected source failure was not rejected')
                except m.Blocked as error:
                    assert str(error) == 'release_reverted', str(error)
                # restore_origin already runs the full readiness sequence.
                controller.probe(a, public=True)
                assert controller.state['active']['digest'] == a['digest']
            result = docker('exec', controller.web_name(controller.state['active']), 'node', '-e', "const D=require('better-sqlite3');const d=new D('/data/marketing.db',{readonly:true});if(d.pragma('integrity_check',{simple:true})!=='ok'||d.prepare('SELECT count(*) n FROM User').get().n!==1||d.prepare('SELECT memo FROM Customer WHERE id=?').get('synthetic-parallel').memo!=='synthetic worker committed after activation')process.exit(1);console.log('data_preserved')")
            assert result == 'data_preserved'
            stopped.set()
            observer.join(timeout=10)
            assert not observer.is_alive() and probes and not errors, 'continuous public probes failed during a transition'
            summary['traffic'] = finish_traffic()
            summary['publicProbes'] = len(probes)
            summary['controllerPublicProbes'] = controller.probes
            summary['publicErrors'] = len(errors)
            summary['heldUploadDrains'] = controller.drains
            record_timing('section.transitions', transition_started)
        if options.real_time:
            assert controller.observation_seconds >= m.WINDOW, 'real observation was shorter than 1800 seconds'
            assert controller.drains == 1 and controller.state['previous']['drained']
            assert len(probes) >= 1800
            assert max(b-a for a,b in zip(probe_times, probe_times[1:])) < 5, 'public probe gap exceeded 5 seconds'
            summary['observations'].append({'seconds': controller.observation_seconds, 'publicProbes': len(probes),
                'publicErrors': len(errors), 'p95Ms': sorted(latencies)[int(len(latencies)*0.95)]*1000,
                'maxGapSeconds': max(b-a for a,b in zip(probe_times, probe_times[1:])),
                'heldUploadDrains': controller.drains, 'activeDigest': controller.state['active']['digest']})
        elif options.suite in ('full', 'recovery'):
            recovery_started = time.monotonic()
            recovery_spec = importlib.util.spec_from_file_location('lab_recovery', ROOT/'tests/deploy-lab-recovery.py')
            recovery = importlib.util.module_from_spec(recovery_spec)
            recovery_spec.loader.exec_module(recovery)
            summary['recovery'] = recovery.run_recovery(Lab, root, releases, fixture_lease_ms)
            record_timing('section.recovery', recovery_started)
        summary['ok'] = True
        if TIMINGS and TIMINGS.exists():
            totals = {}
            for line in TIMINGS.read_text().splitlines():
                item = json.loads(line)
                total = totals.setdefault(item['stage'], {'calls': 0, 'seconds': 0})
                total['calls'] += 1
                total['seconds'] = round(total['seconds'] + item['seconds'], 4)
            summary['timings'] = totals
            if os.environ.get('GITHUB_STEP_SUMMARY'):
                with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as output:
                    output.write(f'\n## Controller {options.suite}\n\nSections include commands and waits; do not sum both.\n\n| Operation | Calls | Seconds |\n| --- | ---: | ---: |\n')
                    for name, item in sorted(totals.items()):
                        output.write(f"| {name} | {item['calls']} | {item['seconds']:.2f} |\n")
        if options.report:
            options.report.write_text(json.dumps(summary, indent=2)+'\n')
        print(json.dumps(summary), flush=True)
    finally:
        stopped.set()
        if sys.exc_info()[0] is not None:
            # These are isolated synthetic containers; never inspect env or production logs.
            for name in names[:-1]:
                subprocess.run(['docker','logs','--tail','15',name], check=False)
        for name in names:
            subprocess.run(['docker','rm','-f',name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if 'controller' in locals() and controller.held:
            if controller.held.poll() is None:
                controller.held.kill()
            controller.held.wait(timeout=5)
        subprocess.run(['docker','network','rm','evn-marketing'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(['docker','volume','rm','evn-marketing-data'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
