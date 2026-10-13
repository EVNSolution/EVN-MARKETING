"""Hand the unchanged release transaction to systemd; return only after activation.

The controller retains its host lock, 1800-second probes, worker lease and rollback.
An SSM/GitHub disconnect cannot terminate the host transaction. Boot recovery still
rolls an interrupted transaction back. Success here means observing, not stable.
"""
import argparse
import json
import uuid
import re
import subprocess
import time
from pathlib import Path

ROOT = Path('/opt/evn-marketing-runtime')
UNIT = 'marketing-deploy.service'
ENV = {
    'AWS_REGION': 'ap-northeast-2', 'AWS_DEFAULT_REGION': 'ap-northeast-2',
    'AWS_ECR_DISABLE_CACHE': 'true', 'AWS_SHARED_CREDENTIALS_FILE': '/dev/null',
    'AWS_CONFIG_FILE': '/dev/null', 'DOCKER_CONFIG': '/root/.docker',
    'AWS_ECR_CACHE_DIR': '/run/evn-marketing-ecr',
}


def command(action, revision='', digest='', key=''):
    if (action not in ('release', 'rollback') or not re.fullmatch(r'[0-9a-f]{40}', revision)
            or not re.fullmatch(r'(?:run-[1-9][0-9]*-[1-9][0-9]*|manual-[0-9a-f-]{36})', key)
            or (action == 'release' and not re.fullmatch(r'sha256:[0-9a-f]{64}', digest))):
        raise ValueError('invalid release identity')
    args = ['systemd-run', '--quiet', '--collect', '--unit=' + UNIT,
            '--property=Type=exec', '--property=RuntimeMaxSec=3600',
            '--property=TimeoutStopSec=900', '--property=KillMode=mixed',
            '--property=WorkingDirectory=' + str(ROOT), '--property=UMask=0077',
            '--property=StandardOutput=journal', '--property=StandardError=journal']
    args += ['--setenv=' + key + '=' + value for key, value in ENV.items()]
    args += ['/usr/bin/python3', '-I', str(ROOT / 'deploy/deployment-result.py'), 'run',
             '--action', action, '--key', key, '--revision', revision]
    if action == 'release':
        args += ['--digest', digest]
    return args


def activated(state, target):
    release = state.get('candidate') if state.get('phase') == 'observing' else state.get('active')
    return state.get('phase') in ('observing', 'stable') and release and all(
        release.get(key) == target[key] for key in ('revision', 'digest'))


def start(action, revision='', digest='', key=''):
    key = key or 'manual-' + str(uuid.uuid4())
    args = command(action, revision, digest, key)
    state_file = ROOT / 'state/release.json'
    before = json.loads(state_file.read_text())
    if before.get('phase') != 'stable':
        raise ValueError('another transaction requires observation or recovery')
    target = before.get('previous') if action == 'rollback' else {'revision': revision, 'digest': digest}
    if not target or target['revision'] == before['active']['revision']:
        raise ValueError('no different release selected')
    # Fixed unit name rejects a concurrent dispatch before a second process starts.
    subprocess.run(args, check=True, capture_output=True, timeout=30)
    deadline = time.monotonic() + 900
    while time.monotonic() < deadline:
        state = json.loads(state_file.read_text())
        if activated(state, target):
            return {'ok': True, 'phase': state['phase'], 'revision': target['revision'], 'digest': target['digest']}
        running = subprocess.run(['systemctl', 'is-active', '--quiet', UNIT], timeout=10).returncode == 0
        if not running or state.get('phase') == 'blocked':
            raise RuntimeError('host release failed; inspect journal before retry')
        time.sleep(2)
    raise RuntimeError('activation unconfirmed; host transaction continues, do not redispatch')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('release', 'rollback'))
    parser.add_argument('--revision', default='')
    parser.add_argument('--digest', default='')
    parser.add_argument('--key', default='')
    args = parser.parse_args()
    print(json.dumps(start(args.action, args.revision, args.digest, args.key)))
