#!/usr/bin/env python3
"""Marketing-only host release coordinator. No DB restore or migration."""
import argparse
import contextlib
from datetime import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import signal
import ssl
import subprocess
import tempfile
import time
import urllib.request
import uuid

ROOT = Path('/opt/evn-marketing-runtime')
ACTIVATION_CHECKS = 5
ACTIVATION_INTERVAL = 2
ACTIVATION_TIMEOUT = 90
SHA = re.compile(r'[0-9a-f]{40}')
DIGEST = re.compile(r'sha256:[0-9a-f]{64}')


class Blocked(Exception):
    pass


def require(condition, reason):
    if not condition:
        raise Blocked(reason)


def atomic(path, data):
    """Crash-safe journal/config replacement on the same filesystem."""
    temp = path.with_name(path.name + '.tmp-' + str(uuid.uuid4()))
    try:
        with temp.open('x') as stream:
            os.chmod(temp, 0o600)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
        fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        temp.unlink(missing_ok=True)


def bootstrap_journal(root, revision, digest):
    require(SHA.fullmatch(revision) and DIGEST.fullmatch(digest), 'release_identity')
    path = root / 'state' / 'release.json'
    require(not path.is_symlink(), 'unsafe_host_permissions')
    if path.exists():
        state = json.loads(path.read_text())
        active = state.get('active', {})
        require(state.get('phase') == 'bootstrapping' and state.get('format') == 1
                and active.get('revision') == revision and active.get('digest') == digest
                and active.get('slot') == 'blue' and not any(
                    state.get(key) for key in ('previous', 'origin', 'candidate')), 'bootstrap_state')
        return
    state = {'format': 1, 'phase': 'bootstrapping', 'active': {
        'revision': revision, 'digest': digest, 'slot': 'blue', 'owner': str(uuid.uuid4())}, 'previous': None}
    atomic(path, json.dumps(state, sort_keys=True) + '\n')


@contextlib.contextmanager
def host_lock(root):
    # The same inode is shared by release/rollback/recovery and future backup/migration.
    with (root / 'state' / 'host.lock').open('a') as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Blocked('host_busy') from None
        yield


class Controller:
    def __init__(self, root=ROOT):
        self.root = root
        self.config = json.loads((root / 'config.json').read_text())
        self.state_file = root / 'state' / 'release.json'
        self.state = json.loads(self.state_file.read_text())
        c = self.config
        require(re.fullmatch(r'[a-z0-9.-]+(?::[0-9]+)?/evn-marketing', c['repository']), 'configuration')
        require(re.fullmatch(r'https://[a-z0-9.-]+(?::[0-9]+)?', c['publicUrl']), 'configuration')
        require(re.fullmatch(r'[a-z0-9./:_-]+@sha256:[0-9a-f]{64}', c['proxyImage']), 'configuration')
        require(re.fullmatch(r'[A-Za-z0-9_-]{1,64}', c['volumeId']), 'configuration')
        require(c['volume'] == 'evn-marketing-data' and c['network'] == 'evn-marketing', 'configuration')
        require(re.fullmatch(r'vol-[0-9a-f]+', c['ebsVolumeId']), 'configuration')
        require(type(c['collectorEnabled']) is bool and type(c['warpDeliveryEnabled']) is bool, 'configuration')
        require(type(c.get('landingIntakeEnabled', False)) is bool, 'configuration')
        require(type(c.get('naverAdSpendEnabled', False)) is bool, 'configuration')
        if c.get('naverAdSpendEnabled'):
            require(c['collectorEnabled'], 'configuration')
            require(all(key in c['parameters'] for key in ('NAVER_AD_API_KEY', 'NAVER_AD_SECRET_KEY')), 'configuration')
        require(type(c['minFreeMemoryMiB']) is int and c['minFreeMemoryMiB'] >= 256, 'configuration')
        require(type(c['minFreeDiskMiB']) is int and c['minFreeDiskMiB'] >= 1024, 'configuration')
        require(self.state.get('format') == 1, 'journal')
        self.validate_release(self.state['active'])
        for key in ('previous', 'candidate', 'origin'):
            if self.state.get(key):
                self.validate_release(self.state[key])
        for left, right in (('active', 'previous'), ('origin', 'candidate')):
            if self.state.get(left) and self.state.get(right):
                require(self.state[left]['slot'] != self.state[right]['slot']
                        and self.state[left]['revision'] != self.state[right]['revision'], 'journal')

    @staticmethod
    def validate_release(release):
        require(SHA.fullmatch(release['revision']) and DIGEST.fullmatch(release['digest'])
                and release['slot'] in ('blue', 'green')
                and str(uuid.UUID(release['owner'], version=4)) == release['owner'], 'journal')

    def now(self):
        return time.time()

    def wait(self, seconds):
        time.sleep(seconds)

    def monotonic(self):
        return time.monotonic()

    def save(self, **changes):
        self.state.update(changes)
        atomic(self.state_file, json.dumps(self.state, sort_keys=True) + '\n')

    def command(self, args, timeout=60, env=None, stdin=None):
        try:
            result = subprocess.run(args, input=stdin, text=True, capture_output=True,
                                    timeout=timeout, env=env, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise Blocked('command_failed') from None
        require(result.returncode == 0, 'command_failed')
        return result.stdout

    def docker(self, *args, **kwargs):
        return self.command(['docker', *args], **kwargs)

    def image(self, release):
        return self.config['repository'] + '@' + release['digest']

    def web_name(self, release):
        return 'evn-marketing-web-' + release['slot']

    def inspect(self, name):
        return json.loads(self.docker('inspect', name))[0]

    def running(self, name):
        # A Docker error is not proof of process absence.
        names = self.docker('ps', '--format', '{{.Names}}').splitlines()
        return name in names

    def identity(self, name, release):
        container = self.inspect(name)
        image = self.image_identity(release)
        require(container['Image'] == image['Id'], 'image_identity')
        mounts = [m for m in container['Mounts'] if m['Destination'] == '/data']
        require(len(mounts) == 1 and mounts[0].get('Name') == self.config['volume'], 'volume_identity')
        require(not container['State'].get('OOMKilled'), 'container_oom')

    def image_identity(self, release):
        image = json.loads(self.docker('image', 'inspect', self.image(release)))[0]
        labels = image.get('Config', {}).get('Labels') or {}
        require(self.image(release) in image['RepoDigests'] and image['Architecture'] == 'amd64'
                and labels.get('org.opencontainers.image.revision') == release['revision'], 'image_identity')
        return image

    def probe(self, release, public=False):
        if public:
            request = urllib.request.Request(self.config['publicUrl'] + '/api/readyz')
            context = ssl.create_default_context(cafile=self.config.get('caFile'))
            with urllib.request.urlopen(request, context=context, timeout=5) as response:
                require(response.status == 200 and response.url == request.full_url, 'readiness')
                value = json.load(response)
        else:
            value = json.loads(self.docker('exec', self.web_name(release), 'node', '-e',
                "fetch('http://127.0.0.1:3000/api/readyz').then(async r=>{if(!r.ok)process.exit(1);console.log(JSON.stringify(await r.json()))}).catch(()=>process.exit(1))"))
        require(value == {'ok': True, 'revision': release['revision'], 'imageDigest': release['digest']}, 'readiness')

    def healthy_web(self, release, public=False):
        self.identity(self.web_name(release), release)
        deadline, consecutive = self.now() + 90, 0
        while consecutive < 3:
            try:
                self.probe(release, public)
                consecutive += 1
            except Exception:
                consecutive = 0
                require(self.now() < deadline, 'readiness')
            if consecutive < 3:
                self.wait(1)

    def check_schema(self, release, other):
        manifests = []
        verified = {}
        for item in (release, other):
            # Read both immutable files in one container. Reuse only within this call,
            # keyed by digest and revision; the live database is still checked each time.
            key = (item['digest'], item['revision'])
            if key not in verified:
                value = json.loads(self.docker('run', '--rm', '--network', 'none', self.image(item), 'node', '-e',
                    "const f=require('fs');console.log(JSON.stringify({capability:f.readFileSync('/app/worker-activation.version','utf8'),manifest:f.readFileSync('/app/schema-manifest.json','utf8')}))"))
                require(value['capability'].strip() == '1', 'worker_gate_unsupported')
                require(json.loads(value['manifest'])['revision'] == item['revision'], 'manifest_identity')
                verified[key] = value['manifest']
            directory = self.root / 'releases' / item['revision']
            directory.mkdir(exist_ok=True)
            atomic(directory / 'schema.json', verified[key])
            os.chmod(directory / 'schema.json', 0o644)
            manifests.append(directory / 'schema.json')
        result = self.docker('run', '--rm', '--network', 'none',
            '-v', self.config['volume'] + ':/data',
            '-v', str(manifests[0]) + ':/current.json:ro', '-v', str(manifests[1]) + ':/previous.json:ro',
            '-e', 'DATABASE_URL=file:/data/marketing.db', self.image(release),
            'node', 'schema-check.mjs', 'check', '/current.json', '/previous.json')
        require(json.loads(result)['ok'] is True, 'schema')

    def preflight(self, release, other):
        c = self.config
        backup = json.loads((self.root / 'state' / 'backup.json').read_text())
        require(re.fullmatch(r'snap-[0-9a-f]+', backup['snapshotId'])
                and backup['volumeId'] == c['volumeId'] and backup['consistent'] is True
                and 0 <= self.now() - backup['createdAt'] <= 86400
                and backup['createdAt'] <= backup['restoreVerifiedAt'] <= self.now()
                and re.fullmatch(r'[0-9a-f]{64}', backup['manifestSha256']), 'backup_evidence')
        snapshot = json.loads(self.command(['aws', 'ec2', 'describe-snapshots', '--region', 'ap-northeast-2',
            '--snapshot-ids', backup['snapshotId'], '--owner-ids', 'self', '--output', 'json']))['Snapshots']
        require(len(snapshot) == 1 and snapshot[0]['State'] == 'completed' and snapshot[0]['Encrypted'] is True
                and snapshot[0]['VolumeId'] == c['ebsVolumeId'], 'backup_unavailable')
        snapshot_time = datetime.fromisoformat(snapshot[0]['StartTime'].replace('Z', '+00:00')).timestamp()
        require(0 <= self.now() - snapshot_time <= 86400 and abs(snapshot_time - backup['createdAt']) <= 300, 'backup_age')
        volume = json.loads(self.docker('volume', 'inspect', c['volume']))[0]
        require(volume['Driver'] == 'local' and not volume.get('Options'), 'volume_identity')
        require(shutil.disk_usage(volume['Mountpoint']).free >= c['minFreeDiskMiB'] * 1024**2, 'disk_capacity')
        memory = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
        require(int(memory['MemAvailable'].split()[0]) >= c['minFreeMemoryMiB'] * 1024, 'memory_capacity')
        self.docker('pull', self.image(release), timeout=300)
        self.check_schema(release, other)

    def secrets(self, worker):
        keys = ['AUTH_SECRET'] + (['MLEVERAGE_USERNAME', 'MLEVERAGE_PASSWORD', 'WARP_MARKETING_API_KEY'] if worker else [])
        if worker and self.config.get('naverAdSpendEnabled'):
            keys += ['NAVER_AD_API_KEY', 'NAVER_AD_SECRET_KEY']
        names = [self.config['parameters'][key] for key in keys]
        require(all(re.fullmatch(r'/evn-marketing/production/[a-z-]+', name) for name in names), 'secret_path')
        values = json.loads(self.command(['aws', 'ssm', 'get-parameters', '--region', 'ap-northeast-2',
            '--names', *names, '--with-decryption', '--output', 'json']))
        require(not values.get('InvalidParameters'), 'secrets_missing')
        by_name = {item['Name']: item['Value'] for item in values['Parameters'] if item['Type'] == 'SecureString'}
        require(all(by_name.get(name) for name in names), 'secrets_missing')
        return {key: by_name[name] for key, name in zip(keys, names)}

    def gate(self, release):
        return self.root / 'state' / 'workers' / release['owner'] / 'active'

    def start(self, release, worker=False):
        if worker and not self.config['collectorEnabled']:
            return
        name = 'evn-marketing-worker' if worker else self.web_name(release)
        require(not self.running(name), 'container_still_running')
        all_names = self.docker('ps', '-a', '--format', '{{.Names}}').splitlines()
        if name in all_names:
            self.docker('rm', name)
        environment = self.secrets(worker)
        environment.update(DATABASE_URL='file:/data/marketing.db', UPLOADS_DIR='/data/uploads',
            MARKETING_REVISION=release['revision'], MARKETING_IMAGE_DIGEST=release['digest'],
            MARKETING_VOLUME_ID=self.config['volumeId'], AUTH_URL=self.config['publicUrl'],
            NEXTAUTH_URL=self.config['publicUrl'], AUTH_TRUST_HOST='true',
            LANDING_INTAKE_ENABLED='true' if self.config.get('landingIntakeEnabled') is True and not worker else 'false',
            WARP_DELIVERY_ENABLED='true' if self.config['warpDeliveryEnabled'] else 'false',
            INQUIRY_COLLECTOR_ENABLED='true' if worker else 'false')
        if worker:
            environment['NAVER_AD_SPEND_ENABLED'] = 'true' if self.config.get('naverAdSpendEnabled') else 'false'
        args = ['run', '-d', '--name', name, '--init', '--restart=no', '--network', self.config['network'],
                '--label', 'evn.marketing.managed=true', '--label', 'evn.marketing.revision=' + release['revision'], '--memory', '768m' if worker else '384m',
                '--cpus', '1', '--pids-limit', '256', '--log-driver', 'local',
                '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3', '-v', self.config['volume'] + ':/data']
        if worker:
            gate = self.gate(release)
            gate.parent.mkdir(exist_ok=True, parents=True)
            os.chmod(gate.parent, 0o755)
            gate.unlink(missing_ok=True)
            args += ['-v', str(gate.parent) + ':/run/marketing-gate:ro']
            environment.update(MARKETING_WORKER_OWNER=release['owner'], MARKETING_WORKER_GATE='/run/marketing-gate/active')
        else:
            port = '3100' if release['slot'] == 'blue' else '3101'
            args += ['--network-alias', release['slot'], '-p', '127.0.0.1:' + port + ':3000']
        for key in environment:
            args += ['-e', key]  # Values stay out of argv and output, and are never written to env files.
        args += [self.image(release), 'node', 'worker.mjs' if worker else 'server.js']
        self.docker(*args, env={**os.environ, **environment})
        self.identity(name, release)

    def lease_clear(self, release, allow_expired=False):
        predicate = "rows.every(r=>['worker','lock'].every(k=>!r[k+'Owner']))"
        if allow_expired:
            predicate = "rows.every(r=>['worker','lock'].every(k=>!r[k+'Owner'] || (r[k+'LeaseExpiresAt'] || r[k+'ExpiresAt']) && new Date(r[k+'LeaseExpiresAt'] || r[k+'ExpiresAt']).getTime() <= Date.now()))"
        deadline = self.now() + 180
        while True:
            try:
                self.docker('run', '--rm', '--network', 'none', '-v', self.config['volume'] + ':/data',
                    self.image(release), 'node', '-e',
                    "const D=require('better-sqlite3');const d=new D('/data/marketing.db',{readonly:true,fileMustExist:true});"
                    "const rows=d.prepare('SELECT workerOwner,workerLeaseExpiresAt,lockOwner,lockExpiresAt FROM InquirySyncState').all();d.close();process.exit((" + predicate + ")?0:1)")
                return
            except Blocked:
                require(allow_expired and self.now() < deadline, 'lease_not_released')
                self.wait(1)

    def stop_worker(self, release):
        self.gate(release).unlink(missing_ok=True)
        name = 'evn-marketing-worker'
        if self.running(name):
            self.identity(name, release)
            self.docker('kill', '--signal=TERM', name)
            deadline = self.now() + 180
            while self.running(name) and self.now() < deadline:
                self.wait(1)
            require(not self.running(name), 'worker_drain_timeout')
            state = self.inspect(name)['State']
            require(state['ExitCode'] == 0 and not state['OOMKilled'], 'worker_unclean_exit')
        self.lease_clear(release)

    def worker_ready(self, release, retry=True):
        if not self.config['collectorEnabled']:
            self.lease_clear(release)
            return
        deadline = self.now() + 90
        while True:
            self.identity('evn-marketing-worker', release)
            require(self.running('evn-marketing-worker'), 'worker_exited')
            try:
                value = json.loads(self.docker('exec', 'evn-marketing-worker', 'node', 'worker-health.mjs'))
                require(value.get('ok') and value['revision'] == release['revision']
                        and value['imageDigest'] == release['digest'], 'worker_health')
                return value
            except Blocked:
                require(retry and self.now() < deadline, 'worker_health')
                self.wait(1)

    def activate_worker(self, release):
        if self.config['collectorEnabled']:
            atomic(self.gate(release), 'active\n')
            os.chmod(self.gate(release), 0o644)

    def validate_activation(self, release, prepared_health):
        # Complete on evidence, not elapsed retention time. A stalled heartbeat
        # must not pass merely because the worker's old lease is still valid.
        deadline = self.monotonic() + ACTIVATION_TIMEOUT
        initial = prepared_health.get('heartbeatAt') if prepared_health else None
        require(not self.config['collectorEnabled'] or initial, 'worker_heartbeat_missing')
        renewed = not self.config['collectorEnabled']
        checks = 0
        while True:
            self.probe(release, public=True)
            health = self.worker_ready(release, retry=False)
            if health:
                heartbeat = health.get('heartbeatAt')
                renewed = renewed or bool(heartbeat and heartbeat > initial)
            checks += 1
            require(self.monotonic() < deadline, 'activation_validation_timeout')
            if checks >= ACTIVATION_CHECKS and renewed:
                return {'publicChecks': checks, 'workerHeartbeatAdvanced': renewed}
            self.wait(ACTIVATION_INTERVAL)

    def bootstrap(self):
        require(self.state['phase'] == 'bootstrapping' and not any(
            self.state.get(key) for key in ('previous', 'origin', 'candidate')), 'bootstrap_state')
        require(not self.config['collectorEnabled'] and not self.config['warpDeliveryEnabled'], 'bootstrap_workers_enabled')
        active = self.state['active']
        require(active['slot'] == 'blue', 'bootstrap_state')
        network = json.loads(self.docker('network', 'inspect', self.config['network']))
        volume = json.loads(self.docker('volume', 'inspect', self.config['volume']))
        require(len(network) == len(volume) == 1 and network[0]['Name'] == self.config['network']
                and volume[0]['Name'] == self.config['volume'] and volume[0]['Driver'] == 'local'
                and not volume[0].get('Options'), 'bootstrap_storage')
        self.docker('pull', self.image(active), timeout=300)
        self.docker('pull', self.config['proxyImage'], timeout=300)
        self.image_identity(active)
        proxy_image = json.loads(self.docker('image', 'inspect', self.config['proxyImage']))[0]
        require(self.config['proxyImage'] in proxy_image['RepoDigests']
                and proxy_image['Architecture'] == 'amd64', 'proxy_identity')
        names = set(self.docker('ps', '-a', '--format', '{{.Names}}').splitlines())
        running = set(self.docker('ps', '--format', '{{.Names}}').splitlines())
        web = self.web_name(active)
        for name in running:
            mounts = self.inspect(name).get('Mounts', [])
            if any(mount.get('Name') == self.config['volume']
                    or mount.get('Source') == volume[0].get('Mountpoint') for mount in mounts):
                require(name == web, 'bootstrap_volume_busy')
        require('evn-marketing-worker' not in names and 'evn-marketing-web-green' not in names,
                'bootstrap_unknown_container')
        if web in names:
            item = self.inspect(web)
            labels = item['Config'].get('Labels') or {}
            ports = item['HostConfig'].get('PortBindings') or {}
            require(labels.get('evn.marketing.managed') == 'true'
                    and labels.get('evn.marketing.revision') == active['revision']
                    and ports == {'3000/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '3100'}]}
                    and self.config['network'] in item['NetworkSettings']['Networks'], 'bootstrap_unknown_container')
            self.identity(web, active)
        proxy_name = 'evn-marketing-proxy'
        if proxy_name in names:
            item = self.inspect(proxy_name)
            mounts = [mount for mount in item['Mounts'] if mount['Destination'] == '/etc/nginx']
            require(item['Image'] == proxy_image['Id'] and self.config['proxyImage'] in proxy_image['RepoDigests']
                    and (item['Config'].get('Labels') or {}).get('evn.marketing.managed') == 'true'
                    and item['HostConfig'].get('PortBindings') == {'8080/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '3080'}]}
                    and self.config['network'] in item['NetworkSettings']['Networks']
                    and len(mounts) == 1 and mounts[0].get('Source') == str(self.root / 'nginx')
                    and mounts[0].get('RW') is False, 'bootstrap_unknown_container')

        self.check_schema(active, active)
        self.lease_clear(active)
        if web in names:
            if not self.running(web):
                self.docker('start', web)
        else:
            self.start(active)
        self.healthy_web(active)
        if proxy_name not in names:
            self.docker('create', '--name', proxy_name, '--restart=no', '--network', self.config['network'],
                        '--label', 'evn.marketing.managed=true', '-p', '127.0.0.1:3080:8080',
                        '-v', str(self.root / 'nginx') + ':/etc/nginx:ro', self.config['proxyImage'])
        self.proxy(active)
        self.healthy_web(active, public=True)
        self.save(phase='stable')

    def proxy_workers(self):
        return self.docker('exec', 'evn-marketing-proxy', 'sh', '-c',
            "for p in /proc/[0-9]*/cmdline; do case $(tr '\\0' ' ' < \"$p\") in 'nginx: worker process'*) echo \"$p\";; esac; done").splitlines()

    def render_proxy(self, active, previous=None):
        previous = {'id': previous['revision'], 'slot': previous['slot']} if previous else None
        mapping = {'active': {'id': active['revision'], 'slot': active['slot']}, 'previous': previous,
                   'publicUrl': self.config['publicUrl']}
        return self.docker('run', '--rm', '-i', '--network', 'none',
            '--mount', 'type=bind,source=' + str(self.root / 'deploy' / 'nginx-config.mjs') + ',target=/renderer.mjs,readonly',
            self.image(active), 'node', '/renderer.mjs', '/dev/stdin', stdin=json.dumps(mapping))

    def preflight_proxy(self, candidate, origin):
        # Use each image's real runtime user, not a root-side mode/readability guess.
        # Check both activation and rollback before touching any live process/config.
        try:
            with tempfile.TemporaryDirectory(prefix='preflight-', dir=self.root / 'nginx') as temporary:
                directory = Path(temporary)
                os.chmod(directory, 0o755)
                config = directory / 'nginx.conf'
                for active, previous in ((candidate, origin),
                                         (origin, None)):
                    atomic(config, self.render_proxy(active, previous))
                    os.chmod(config, 0o644)
                    # Candidate DNS need not exist yet. Syntax validation has no app network/data access.
                    self.docker('run', '--rm', '--network', 'none',
                        '--add-host', 'blue:127.0.0.1', '--add-host', 'green:127.0.0.1',
                        '-v', str(directory) + ':/etc/nginx:ro', '--entrypoint', 'nginx',
                        self.config['proxyImage'], '-t', '-c', '/etc/nginx/nginx.conf')
        except (Blocked, OSError):
            raise Blocked('proxy_preflight_failed') from None

    def proxy(self, active, previous=None):
        output = self.render_proxy(active, previous)
        directory = self.root / 'nginx'
        proxy = self.inspect('evn-marketing-proxy')
        proxy_image = json.loads(self.docker('image', 'inspect', self.config['proxyImage']))[0]
        require(proxy['Image'] == proxy_image['Id'] and self.config['proxyImage'] in proxy_image['RepoDigests'], 'proxy_identity')
        old_workers = self.proxy_workers() if self.running('evn-marketing-proxy') else []
        atomic(directory / 'candidate.conf', output)
        os.chmod(directory / 'candidate.conf', 0o644)
        self.docker('run', '--rm', '--network', self.config['network'],
            '-v', str(directory) + ':/etc/nginx:ro', '--entrypoint', 'nginx', self.config['proxyImage'],
            '-t', '-c', '/etc/nginx/candidate.conf')
        atomic(directory / 'nginx.conf', output)
        os.chmod(directory / 'nginx.conf', 0o644)
        if self.running('evn-marketing-proxy'):
            self.docker('exec', 'evn-marketing-proxy', 'nginx', '-t')
            self.docker('exec', 'evn-marketing-proxy', 'nginx', '-s', 'reload')
        else:
            self.docker('start', 'evn-marketing-proxy')
        return old_workers

    def drained_proxy(self, workers):
        deadline = self.now() + 180
        while set(workers) & set(self.proxy_workers()):
            require(self.now() < deadline, 'proxy_drain_timeout')
            self.wait(1)

    def retire(self):
        previous = self.state.get('previous')
        if not previous or previous.get('drained'):
            return
        self.save(phase='retiring')
        workers = self.proxy(self.state['active'])
        self.drained_proxy(workers)
        self.healthy_web(self.state['active'], public=True)
        self.save(phase='stable', previous={**previous, 'drained': True})

    def stop_web(self, release):
        name = self.web_name(release)
        if self.running(name):
            self.identity(name, release)
            self.docker('kill', '--signal=TERM', name)
            deadline = self.now() + 30
            while self.running(name) and self.now() < deadline:
                self.wait(1)
            require(not self.running(name), 'web_drain_timeout')

    def discard_candidate(self, candidate):
        name = self.web_name(candidate)
        if not self.running(name):
            return
        actual = self.inspect(name)['Config']['Labels'].get('evn.marketing.revision')
        previous = self.state.get('previous')
        if actual == candidate['revision']:
            self.stop_web(candidate)
        elif previous and previous['slot'] == candidate['slot'] and actual == previous['revision']:
            self.stop_web(previous)
        else:
            raise Blocked('unknown_candidate')

    def restore_origin(self):
        origin = self.state['origin']
        candidate = self.state['candidate']
        self.save(phase='recovering')
        # Stop whichever known worker actually exists; never infer absence from a timeout.
        if self.running('evn-marketing-worker'):
            actual = self.inspect('evn-marketing-worker')['Config']['Labels'].get('evn.marketing.revision')
            require(actual in (origin['revision'], candidate['revision']), 'unknown_worker')
            self.stop_worker(origin if actual == origin['revision'] else candidate)
        else:
            self.lease_clear(origin, allow_expired=True)
        self.check_schema(origin, candidate)
        if not self.running(self.web_name(origin)):
            self.start(origin)
        self.healthy_web(origin)
        old_proxy_workers = self.proxy(origin)
        self.healthy_web(origin, public=True)
        self.start(origin, worker=True)
        self.worker_ready(origin)
        self.activate_worker(origin)
        self.drained_proxy(old_proxy_workers)
        self.discard_candidate(candidate)
        self.save(phase='stable', active=origin, previous=None, origin=None, candidate=None)

    def release(self, revision, digest, rollback=False):
        require(self.state['phase'] == 'stable', 'recovery_required')
        origin = self.state['active']
        if rollback:
            candidate = self.state.get('previous')
            require(candidate is not None, 'no_previous_release')
            candidate = {key: candidate[key] for key in ('slot', 'revision', 'digest', 'owner')}
            candidate['owner'] = str(uuid.uuid4())
        else:
            require(SHA.fullmatch(revision) and DIGEST.fullmatch(digest), 'release_identity')
            require(revision != origin['revision'], 'already_active')
            candidate = {'revision': revision, 'digest': digest, 'slot': 'green' if origin['slot'] == 'blue' else 'blue', 'owner': str(uuid.uuid4())}
        self.healthy_web(origin, public=True)
        self.worker_ready(origin)
        self.preflight(candidate, origin)
        self.preflight_proxy(candidate, origin)
        if not rollback:
            self.retire()
        self.save(phase='preparing', origin=origin, candidate=candidate)
        try:
            # The previous mapping has drained before its slot may be reused.
            if not rollback:
                if self.state.get('previous'):
                    self.stop_web(self.state['previous'])
                self.start(candidate)
            elif not self.running(self.web_name(candidate)):
                self.start(candidate)
            self.healthy_web(candidate)
            self.save(phase='draining')
            self.stop_worker(origin)
            self.save(phase='switching')
            previous = {**origin, 'drained': False}
            self.proxy(candidate, previous)
            self.healthy_web(candidate, public=True)
            self.save(phase='starting')
            self.start(candidate, worker=True)
            prepared_health = self.worker_ready(candidate)
            self.activate_worker(candidate)
            self.save(phase='observing')
            self.validate_activation(candidate, prepared_health)
            self.save(phase='stable', active=candidate, previous=previous, origin=None, candidate=None)
        except (Exception, KeyboardInterrupt):
            try:
                if self.state['phase'] == 'preparing':
                    workers = self.proxy(origin)
                    self.drained_proxy(workers)
                    self.discard_candidate(candidate)
                    self.healthy_web(origin, public=True)
                    self.save(phase='stable', active=origin, previous=None, origin=None, candidate=None)
                else:
                    self.restore_origin()
            except Exception:
                self.save(phase='blocked')
                raise Blocked('recovery_required') from None
            raise Blocked('release_reverted') from None
        # Keep the previous web usable until its slot is needed by a later release.
        # That release removes its mapping and drains existing requests before reuse.

    def recover(self):
        if self.state.get('origin') and self.state.get('candidate'):
            self.restore_origin()
            return
        require(self.state['phase'] in ('stable', 'retiring'), 'manual_reconciliation_required')
        active = self.state['active']
        self.check_schema(active, active)
        if not self.running(self.web_name(active)):
            self.start(active)
        self.healthy_web(active)
        previous = self.state.get('previous')
        if previous and not previous.get('drained') and self.state['phase'] != 'retiring':
            if not self.running(self.web_name(previous)):
                self.start(previous)
            self.healthy_web(previous)
        else:
            previous = None
        workers = self.proxy(active, previous)
        self.healthy_web(active, public=True)
        if not self.running('evn-marketing-worker'):
            self.lease_clear(active, allow_expired=True)
            self.start(active, worker=True)
        self.worker_ready(active)
        self.activate_worker(active)
        if self.state.get('previous') and previous is None:
            self.drained_proxy(workers)
            self.save(previous={**self.state['previous'], 'drained': True})
        self.save(phase='stable')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=['bootstrap', 'release', 'rollback', 'recover'])
    parser.add_argument('--revision', default='')
    parser.add_argument('--digest', default='')
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    try:
        require(args.operation in ('bootstrap', 'release') or not (args.revision or args.digest), 'arguments')
        require(ROOT.is_dir() and (ROOT / 'state').is_dir(), 'bootstrap_required')
        require(os.geteuid() == 0, 'host_administrator_required')
        release_file = ROOT / 'state' / 'release.json'
        require(not release_file.is_symlink(), 'unsafe_host_permissions')
        entries = [ROOT, ROOT / 'state', ROOT / 'config.json']
        if args.operation == 'bootstrap':
            entries += [ROOT / 'deploy', ROOT / 'deploy' / 'controller.py', ROOT / 'deploy' / 'nginx-config.mjs',
                        ROOT / 'releases', ROOT / 'nginx']
        if release_file.exists() or args.operation != 'bootstrap':
            entries.append(release_file)
        paths = set(entries)
        for entry in entries:
            paths.update(entry.parents)
        for entry in paths:
            metadata = entry.lstat()
            require(not entry.is_symlink() and metadata.st_uid == 0 and not metadata.st_mode & 0o022, 'unsafe_host_permissions')
        with host_lock(ROOT):
            if args.operation == 'bootstrap':
                config = json.loads((ROOT / 'config.json').read_text())
                require(config.get('collectorEnabled') is False and config.get('warpDeliveryEnabled') is False,
                        'bootstrap_workers_enabled')
                bootstrap_journal(ROOT, args.revision, args.digest)
            controller = Controller()
            if args.operation == 'bootstrap':
                controller.bootstrap()
            elif args.operation == 'release':
                controller.release(args.revision, args.digest)
            elif args.operation == 'rollback':
                controller.release('', '', rollback=True)
            else:
                controller.recover()
        print(json.dumps({'ok': True, 'operation': args.operation}))
    except Exception as error:
        print(json.dumps({'ok': False, 'reason': str(error) if isinstance(error, Blocked) else 'operation_failed'}))
        return 75 if isinstance(error, Blocked) and str(error) == 'host_busy' else 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
