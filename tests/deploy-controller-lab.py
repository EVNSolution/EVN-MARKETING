"""Real Docker/Nginx/TLS/SQLite lab, synthetic AWS/source and accelerated observation clock."""
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

    def now(self):
        return self.clock

    def monotonic(self):
        return self.clock

    def wait(self, seconds):
        self.clock += seconds
        # Accelerate observation only; real processes still need real startup/drain time.
        time.sleep(0.01 if self.state['phase'] == 'observing' else seconds)

    def secrets(self, worker):
        return {'AUTH_SECRET': 'synthetic-lab-secret-at-least-32-characters'}

    def preflight(self, release, other):
        # No AWS resources in CI. Pure gate validation is covered by unit tests.
        self.docker('pull', self.image(release))
        self.check_schema(release, other)

    def probe(self, release, public=False):
        result = super().probe(release, public)
        if public:
            self.probes += 1
        return result

    def proxy(self, active, previous=None):
        if previous:
            previous = {**previous, 'expiresAt': time.time() + max(0, previous['expiresAt'] - self.clock)}
        return super().proxy(active, previous)


with tempfile.TemporaryDirectory(prefix='marketing-controller-lab-') as temporary:
    root = Path(temporary)
    os.chmod(root, 0o755)
    for directory in ('state', 'releases', 'nginx', 'deploy', 'tls', 'fixture'):
        (root / directory).mkdir()
    shutil.copy(ROOT / 'deploy/nginx-config.mjs', root / 'deploy/nginx-config.mjs')
    names = ('evn-marketing-worker', 'evn-marketing-web-blue', 'evn-marketing-web-green', 'evn-marketing-proxy', 'marketing-lab-tls', 'marketing-lab-registry')
    stopped = threading.Event()
    errors = []
    probes = []
    def observe():
        context = ssl.create_default_context(cafile=str(root/'tls/cert.pem'))
        while not stopped.is_set():
            try:
                with urllib.request.urlopen('https://localhost:3443/api/readyz', context=context, timeout=5) as response:
                    value = json.load(response)
                    assert response.status == 200 and value['ok'] and value['revision'] in ('a'*40, 'b'*40)
                    probes.append(value['revision'])
            except Exception:
                errors.append('public_probe_failed')
            stopped.wait(0.2)
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
        # Internal bridges allow host -> container IP, not portable published-port access.
        # The TLS front runs like the planned host edge and listens on loopback only.
        proxy_ip = json.loads(docker('inspect', 'evn-marketing-proxy'))[0]['NetworkSettings']['Networks']['evn-marketing']['IPAddress']
        tls = 'events {}\nhttp { access_log off; server { listen 127.0.0.1:3443 ssl; ssl_certificate /tls/cert.pem; ssl_certificate_key /tls/key.pem; location / { proxy_set_header Host $http_host; proxy_pass http://' + proxy_ip + ':8080; } } }'
        (root/'tls/nginx.conf').write_text(tls)
        docker('run', '-d', '--name', 'marketing-lab-tls', '--network', 'host', '-v', str(root/'tls') + ':/tls:ro', '-v', str(root/'tls/nginx.conf') + ':/etc/nginx/nginx.conf:ro', 'nginx:1.28-alpine')
        controller.healthy_web(a, public=True)
        observer = threading.Thread(target=observe, daemon=True)
        observer.start()
        controller.release(b['revision'], b['digest'])
        assert controller.state['active']['digest'] == b['digest']
        assert controller.state['previous']['drained']
        controller.release('', '', rollback=True)
        assert controller.state['active']['digest'] == a['digest']
        assert controller.probes >= 3600
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
        result = docker('exec', 'evn-marketing-web-blue', 'node', '-e', "const D=require('better-sqlite3');const d=new D('/data/marketing.db',{readonly:true});if(d.pragma('integrity_check',{simple:true})!=='ok'||d.prepare('SELECT count(*) n FROM User').get().n!==1||d.prepare('SELECT memo FROM Customer WHERE id=?').get('synthetic-parallel').memo!=='synthetic worker committed after activation')process.exit(1);console.log('data_preserved')")
        assert result == 'data_preserved'
        stopped.set()
        observer.join(timeout=10)
        assert probes and not errors, 'continuous public probes failed during a transition'
        print('controller Docker lab passed: actual digest/TLS/schema/worker handoff, accelerated A-B-A observation, expiry/drain, failed worker rollback and latest data preservation')
    finally:
        stopped.set()
        if sys.exc_info()[0] is not None:
            # These are isolated synthetic containers; never inspect env or production logs.
            for name in names[:-1]:
                subprocess.run(['docker','logs','--tail','15',name], check=False)
        for name in names:
            subprocess.run(['docker','rm','-f',name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(['docker','network','rm','evn-marketing'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(['docker','volume','rm','evn-marketing-data'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
