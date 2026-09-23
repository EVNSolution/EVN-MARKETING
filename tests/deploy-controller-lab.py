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

assert os.environ.get('GITHUB_ACTIONS') == 'true', 'dedicated ephemeral CI runner only'
parser = argparse.ArgumentParser()
parser.add_argument('--real-time', action='store_true', help='observe one release for 1800 real seconds; default runs accelerated transitions and crash recovery')
parser.add_argument('--report', type=Path)
options = parser.parse_args()
ROOT = Path.cwd()
spec = importlib.util.spec_from_file_location('controller', ROOT / 'deploy/controller.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

def command(*args):
    return subprocess.check_output(args, text=True).strip()

def docker(*args):
    return command('docker', *args)


class Lab(m.Controller):
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
        self.clock += seconds
        # Accelerate observation only; real processes still need real startup/drain time.
        time.sleep(0.01 if not self.real_time and self.state['phase'] == 'observing' else seconds)

    def save(self, **changes):
        if changes.get('phase') == 'switching':
            self.observation_start = time.monotonic()
        if changes.get('phase') == 'stable' and self.state['phase'] == 'observing':
            self.observation_seconds = time.monotonic() - self.observation_start
        return super().save(**changes)

    def secrets(self, worker):
        return {'AUTH_SECRET': 'synthetic-lab-secret-at-least-32-characters'}

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

    def proxy(self, active, previous=None):
        if previous and not self.real_time:
            previous = {**previous, 'expiresAt': time.time() + max(0, previous['expiresAt'] - self.clock)}
        return super().proxy(active, previous)

    def retire(self):
        previous = self.state.get('previous')
        if self.exercise_drain and previous and not previous.get('drained') and self.now() >= previous['expiresAt']:
            for name in ('held', 'finish-held', 'held-result.json'):
                (self.root/'control'/name).unlink(missing_ok=True)
            self.held = subprocess.Popen(['docker', 'exec', 'marketing-lab-traffic', 'node',
                '/src/tests/deploy-lab-traffic.mjs', 'hold', previous['revision']],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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
                assert self.held.poll() is None and set(workers) & set(self.proxy_workers()), 'request drained before its body completed'
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
    summary = {'sourceSha': os.environ.get('GITHUB_SHA'), 'synthetic': True, 'aws': False,
               'hostReboot': False, 'ssmDisconnect': False, 'observations': []}
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

    def start_traffic():
        for file in (root/'control').iterdir():
            file.unlink()
        docker('run', '-d', '--name', 'marketing-lab-traffic', '--network', 'evn-marketing',
               '-v', str(ROOT)+':/src:ro', '-v', str(root/'control')+':/control',
               '-v', 'evn-marketing-data:/data:ro', 'evn-marketing:ci', 'node', '/src/tests/deploy-lab-traffic.mjs')
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
        docker('pull', 'nginx:1.28-alpine')
        fixture = root / 'fixture'
        shutil.copy(ROOT / 'tests/deploy-lab-worker.mjs', fixture / 'worker.mjs')
        (fixture / 'Dockerfile').write_text('FROM evn-marketing:ci\nUSER root\nARG REVISION\nRUN node -e "const f=require(\'fs\');const p=\'/app/schema-manifest.json\';const m=JSON.parse(f.readFileSync(p));m.revision=process.env.REVISION;f.writeFileSync(p,JSON.stringify(m))"\nCOPY worker.mjs /app/worker.mjs\nUSER node\n')
        releases = []
        for character, slot in (('a', 'blue'), ('b', 'green')):
            revision = character * 40
            tag = '127.0.0.1:5000/evn-marketing:' + revision
            docker('build', '--build-arg', 'REVISION=' + revision, '-t', tag, str(fixture))
            docker('push', tag)
            digest = json.loads(docker('image', 'inspect', tag))[0]['RepoDigests'][0].split('@')[1]
            releases.append({'revision': revision, 'digest': digest, 'slot': slot, 'owner': str(uuid.uuid4())})
        a, b = releases
        # Create only a synthetic volume, then use the existing app's actual schema/readiness.
        docker('run', '--rm', '--network', 'none', '-v', str(ROOT) + ':/src:ro', '-v', 'evn-marketing-data:/data', 'evn-marketing:ci', 'node', '/src/tests/release-setup.mjs')
        docker('run', '--rm', '--network', 'none', '-v', 'evn-marketing-data:/data', 'evn-marketing:ci', 'node', '-e',
            "const D=require('better-sqlite3');const d=new D('/data/marketing.db');for(const id of ['synthetic-load-0','synthetic-load-1','synthetic-held'])d.prepare('INSERT INTO Customer(id,name,updatedAt) VALUES(?,?,?)').run(id,'Synthetic load',new Date().toISOString());d.close()")
        command('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', str(root/'tls/key.pem'), '-out', str(root/'tls/cert.pem'))
        config = {'proxyImage':json.loads(docker('image','inspect','nginx:1.28-alpine'))[0]['RepoDigests'][0], 'repository': '127.0.0.1:5000/evn-marketing', 'publicUrl': 'https://localhost:3443', 'caFile': str(root/'tls/cert.pem'),
                  'volumeId': 'synthetic-compat-volume', 'volume': 'evn-marketing-data', 'network': 'evn-marketing', 'ebsVolumeId': 'vol-000001',
                  'collectorEnabled': True, 'warpDeliveryEnabled': False, 'minFreeMemoryMiB': 256, 'minFreeDiskMiB': 1024}
        (root/'config.json').write_text(json.dumps(config))
        (root/'state/release.json').write_text(json.dumps({'format':1,'phase':'stable','active':a,'previous':None}))
        controller = Lab(root)
        controller.start(a)
        controller.healthy_web(a)
        controller.start(a, worker=True)
        controller.worker_ready(a)
        controller.activate_worker(a)
        # Existing runtime proxy bootstrap and a dedicated TLS frontend; no published app ports beyond loopback.
        initial = controller.docker('run', '--rm', '-i', '--network', 'none', '-v', str(root/'deploy/nginx-config.mjs') + ':/renderer.mjs:ro', controller.image(a), 'node', '/renderer.mjs', '/dev/stdin', stdin=json.dumps({'active':{'id':a['revision'],'slot':'blue'},'publicUrl':config['publicUrl']}))
        (root/'nginx/nginx.conf').write_text(initial)
        docker('run', '-d', '--name', 'evn-marketing-proxy', '--network', 'evn-marketing', '-v', str(root/'nginx') + ':/etc/nginx:ro', 'nginx:1.28-alpine')
        # Publish only the TLS front on loopback. Resolve the internal proxy through
        # Docker DNS: its IP can change when the recovery scenario restarts it.
        tls = 'events {}\nhttp { access_log off; resolver 127.0.0.11 valid=1s ipv6=off; server { listen 3443 ssl; ssl_certificate /tls/cert.pem; ssl_certificate_key /tls/key.pem; location / { set $upstream evn-marketing-proxy; proxy_set_header Host $http_host; proxy_pass http://$upstream:8080; } } }'
        (root/'tls/nginx.conf').write_text(tls)
        docker('run', '-d', '--name', 'marketing-lab-tls', '-p', '127.0.0.1:3443:3443', '-v', str(root/'tls') + ':/tls:ro', '-v', str(root/'tls/nginx.conf') + ':/etc/nginx/nginx.conf:ro', 'nginx:1.28-alpine')
        docker('network', 'connect', 'evn-marketing', 'marketing-lab-tls')
        controller.healthy_web(a, public=True)
        start_traffic()
        controller.exercise_drain = True
        controller.real_time = options.real_time
        observer = threading.Thread(target=observe, daemon=True)
        observer.start()
        controller.release(b['revision'], b['digest'])
        assert controller.state['active']['digest'] == b['digest']
        assert controller.state['previous']['drained']
        if not options.real_time:
            controller.release('', '', rollback=True)
            assert controller.state['active']['digest'] == a['digest']
            assert controller.probes >= 3600
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
            controller.healthy_web(a, public=True)
            assert controller.state['active']['digest'] == a['digest']
        result = docker('exec', controller.web_name(controller.state['active']), 'node', '-e', "const D=require('better-sqlite3');const d=new D('/data/marketing.db',{readonly:true});if(d.pragma('integrity_check',{simple:true})!=='ok'||d.prepare('SELECT count(*) n FROM User').get().n!==1||d.prepare('SELECT memo FROM Customer WHERE id=?').get('synthetic-parallel').memo!=='synthetic worker committed after activation')process.exit(1);console.log('data_preserved')")
        assert result == 'data_preserved'
        stopped.set()
        observer.join(timeout=10)
        assert not observer.is_alive() and probes and not errors, 'continuous public probes failed during a transition'
        summary['traffic'] = finish_traffic()
        summary['publicProbes'] = len(probes)
        summary['publicErrors'] = len(errors)
        summary['heldUploadDrains'] = controller.drains
        if options.real_time:
            assert controller.observation_seconds >= m.WINDOW, 'real observation was shorter than 1800 seconds'
            assert controller.drains == 1 and controller.state['previous']['drained']
            assert len(probes) >= 1800
            assert max(b-a for a,b in zip(probe_times, probe_times[1:])) < 5, 'public probe gap exceeded 5 seconds'
            summary['observations'].append({'seconds': controller.observation_seconds, 'publicProbes': len(probes),
                'publicErrors': len(errors), 'p95Ms': sorted(latencies)[int(len(latencies)*0.95)]*1000,
                'maxGapSeconds': max(b-a for a,b in zip(probe_times, probe_times[1:])),
                'heldUploadDrains': controller.drains, 'activeDigest': controller.state['active']['digest']})
        else:
            recovery_spec = importlib.util.spec_from_file_location('lab_recovery', ROOT/'tests/deploy-lab-recovery.py')
            recovery = importlib.util.module_from_spec(recovery_spec)
            recovery_spec.loader.exec_module(recovery)
            summary['recovery'] = recovery.run_recovery(Lab, root, releases)
        summary['ok'] = True
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
