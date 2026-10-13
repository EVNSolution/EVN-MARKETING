"""Durable GitHub deployment results. Never changes application data or routing.

The host transaction owns the existing controller lock. A separate timer retries
delivery, including after reboot; no Actions token or waiting runner is required.
"""
import argparse
import base64
import contextlib
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path('/opt/evn-marketing-runtime')
REPO = 'EVNSolution/EVN-MARKETING'
PARAMETER = '/evn-marketing/production/github-deployment-app'
TASK = 'marketing:release'
KEY = re.compile(r'(?:run-[1-9][0-9]*-[1-9][0-9]*|manual-[0-9a-f-]{36})')
ACTIVITY_URL = f'https://github.com/{REPO}/deployments'
spec = importlib.util.spec_from_file_location('marketing_controller', Path(__file__).with_name('controller.py'))
controller = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controller)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def api(method, path, token, body=None):
    if not path.startswith(('/app/installations/', f'/repos/{REPO}/deployments')):
        raise ValueError('unsupported GitHub endpoint')
    request = urllib.request.Request('https://api.github.com' + path,
        data=None if body is None else json.dumps(body).encode(), method=method,
        headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
                 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2026-03-10',
                 'User-Agent': 'evn-marketing-deployment-result'})
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=15) as response:
            return json.load(response)
    except Exception:
        # API bodies, keys and tokens must never enter journal or SSM output.
        raise RuntimeError('GitHub deployment API unavailable') from None


def encode(value):
    return base64.urlsafe_b64encode(value).rstrip(b'=')


def installation_token():
    result = subprocess.run(['aws', 'ssm', 'get-parameters', '--names', PARAMETER,
        '--with-decryption', '--region', 'ap-northeast-2', '--output', 'json'],
        capture_output=True, timeout=30, check=True)
    parameters = json.loads(result.stdout)['Parameters']
    if len(parameters) != 1 or parameters[0]['Name'] != PARAMETER:
        raise ValueError('deployment App configuration missing')
    config = json.loads(parameters[0]['Value'])
    app_id, installation_id = str(config['appId']), str(config['installationId'])
    if not all(re.fullmatch(r'[1-9][0-9]*', value) for value in (app_id, installation_id)):
        raise ValueError('invalid deployment App identity')
    now = int(time.time())
    message = encode(b'{"alg":"RS256","typ":"JWT"}') + b'.' + encode(json.dumps(
        {'iat': now - 60, 'exp': now + 540, 'iss': app_id}).encode())
    # Anonymous, private file descriptor; PEM is neither an argument nor a log.
    with tempfile.TemporaryFile() as key:
        key.write(config['privateKey'].encode()); key.flush(); key.seek(0)
        signature = subprocess.run(['openssl', 'dgst', '-sha256', '-sign', f'/dev/fd/{key.fileno()}'],
            input=message, capture_output=True, pass_fds=(key.fileno(),), timeout=10, check=True).stdout
    jwt = (message + b'.' + encode(signature)).decode()
    grant = api('POST', f'/app/installations/{installation_id}/access_tokens', jwt,
        {'repositories': ['EVN-MARKETING'], 'permissions': {'deployments': 'write'}})
    if (grant.get('permissions', {}).get('deployments') != 'write'
            or grant.get('permissions', {}).get('metadata', 'read') != 'read'
            or any(k not in ('deployments', 'metadata') for k in grant.get('permissions', {}))
            or [r.get('full_name') for r in grant.get('repositories', [])] != [REPO]):
        raise ValueError('deployment App token scope mismatch')
    return grant['token']


def same(left, right):
    return bool(left and right) and all(left.get(k) == right.get(k) for k in ('revision', 'digest'))


def outcome(record, state, *, completed=False):
    if state.get('phase') == 'stable' and not state.get('candidate') and not state.get('origin'):
        if same(state.get('active'), record['target']):
            return {'state': 'success', 'description': 'Rollback completed; previous version stable' if
                    record['action'] == 'rollback' else 'Deployment stable; host validation completed'}
        if same(state.get('active'), record['origin']):
            return {'state': 'failure', 'description': 'Deployment failed; rollback succeeded' if completed
                    else 'Deployment interrupted or refused; original version restored/retained'}
    return {'state': 'error', 'description': 'Deployment failed; rollback or recovery is unconfirmed'}


def save(path, record):
    controller.atomic(path, json.dumps(record, sort_keys=True) + '\n')


def payload(record):
    return {k: record[k] for k in ('key', 'action', 'sourceSha', 'target')}


def log_url(record):
    if record['key'].startswith('run-'):
        return f"https://github.com/{REPO}/actions/runs/{record['key'].split('-')[1]}"
    return ACTIVITY_URL


def ensure_deployment(record, token):
    expected = payload(record)
    base = f'/repos/{REPO}/deployments'
    if record.get('deploymentId'):
        item = api('GET', base + '/' + str(record['deploymentId']), token)
        if (item.get('payload') != expected or item.get('sha') != record['target']['revision']
                or item.get('environment') != 'production' or item.get('task') != TASK):
            raise ValueError('GitHub deployment identity mismatch')
        return item['id']
    # A lost create response must not create a second deployment on retry.
    query = urllib.parse.urlencode({'sha': record['target']['revision'], 'environment': 'production',
                                   'task': TASK, 'per_page': 100})
    for page in range(1, 101):
        items = api('GET', base + '?' + query + '&page=' + str(page), token)
        matches = [item for item in items if item.get('payload') == expected]
        if matches:
            return matches[0]['id']
        if len(items) < 100:
            break
    else:
        raise RuntimeError('deployment history lookup exceeded limit')
    item = api('POST', base, token, {'ref': record['target']['revision'], 'task': TASK,
        'auto_merge': False, 'required_contexts': [], 'environment': 'production',
        'production_environment': True, 'description': 'Marketing host deployment: ' + record['action'],
        'payload': expected})
    if type(item.get('id')) is not int:
        raise ValueError('GitHub deployment was not created')
    return item['id']


def deliver(path, record, token):
    desired = record.get('outcome') or {'state': 'in_progress',
        'description': 'Host owns deployment validation; Actions only activates'}
    if record.get('delivered') == desired:
        return
    record['deploymentId'] = ensure_deployment(record, token)
    save(path, record)
    endpoint = f"/repos/{REPO}/deployments/{record['deploymentId']}/statuses"
    current = api('GET', endpoint + '?per_page=1', token)
    # Lost status response is harmless and does not duplicate a delivered state.
    if not current or any(current[0].get(k) != v for k, v in desired.items()):
        api('POST', endpoint, token, {**desired, 'log_url': log_url(record),
            'environment_url': 'https://marketing.cleversystem.ai', 'auto_inactive': False})
    record['delivered'] = desired
    save(path, record)


@contextlib.contextmanager
def report_lock(root):
    with (root / 'state/github-report.lock').open('a') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def unit_running():
    return any(subprocess.run(['systemctl', 'is-active', '--quiet', unit],
        capture_output=True, timeout=10).returncode == 0 for unit in
        ('marketing-deploy.service', 'marketing-recover.service'))


def seal_interrupted(root, state):
    """Called under the host lock, before another transaction can replace the journal."""
    for path in sorted((root / 'state/deployment-results').glob('*.json')):
        record = json.loads(path.read_text())
        if not record.get('outcome'):
            record['outcome'] = outcome(record, state)
            save(path, record)


def flush(root=ROOT):
    directory = root / 'state/deployment-results'
    if not directory.exists():
        return
    token = None
    with report_lock(root):
        for path in sorted(directory.glob('*.json')):
            record = json.loads(path.read_text())
            if record.get('outcome') and record.get('delivered') == record['outcome']:
                continue
            if not record.get('outcome'):
                if unit_running():
                    continue
                # Reconcile an interrupted wrapper only after controller/recovery releases its lock.
                with controller.host_lock(root):
                    if unit_running():
                        continue
                    state = json.loads((root / 'state/release.json').read_text())
                    record['outcome'] = outcome(record, state)
                    save(path, record)
            token = token or installation_token()
            deliver(path, record, token)


def run(action, revision, digest, key, root=ROOT):
    if action not in ('release', 'rollback') or not KEY.fullmatch(key):
        raise ValueError('invalid deployment request')
    if not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise ValueError('invalid source SHA')
    if subprocess.run(['systemctl', 'is-active', '--quiet', 'marketing-result.timer'],
                      capture_output=True, timeout=10).returncode:
        raise ValueError('deployment result retry timer is not active')
    directory = root / 'state/deployment-results'
    directory.mkdir(mode=0o700, exist_ok=True)
    path = directory / (key + '.json')
    code = 1
    with controller.host_lock(root):
        ctl = controller.Controller(root)
        controller.require(ctl.state['phase'] == 'stable', 'recovery_required')
        seal_interrupted(root, ctl.state)
        origin = ctl.state['active']
        target = ctl.state.get('previous') if action == 'rollback' else {'revision': revision, 'digest': digest}
        controller.require(target and target['revision'] != origin['revision'], 'no_different_release')
        controller.require(controller.SHA.fullmatch(target['revision']) and controller.DIGEST.fullmatch(target['digest']), 'release_identity')
        if path.exists():
            raise ValueError('deployment request already accepted; never redispatch')
        record = {'format': 1, 'key': key, 'action': action, 'sourceSha': revision,
                  'origin': {k: origin[k] for k in ('revision', 'digest')},
                  'target': {k: target[k] for k in ('revision', 'digest')}, 'createdAt': int(time.time())}
        save(path, record)
        try:
            # Refuse activation without a working result channel. Later API failures only retry reporting.
            with report_lock(root):
                deliver(path, record, installation_token())
            ctl.release(revision, digest, rollback=action == 'rollback')
            record['outcome'] = outcome(record, ctl.state)
            code = 0 if record['outcome']['state'] == 'success' else 1
        except (Exception, KeyboardInterrupt) as error:
            record['outcome'] = outcome(record, ctl.state,
                completed=isinstance(error, controller.Blocked) and str(error) == 'release_reverted')
        save(path, record)
    # The existing controller has finished. Reporting cannot invoke rollback or change its result.
    try:
        with report_lock(root):
            deliver(path, record, installation_token())
    except Exception:
        print('GitHub result queued; host timer will retry')
    return code


def check_paths(root):
    entries = [root, root / 'state', root / 'deploy', root / 'deploy/controller.py',
               root / 'deploy/deployment-result.py', root / 'config.json', root / 'state/release.json']
    directory = root / 'state/deployment-results'
    if directory.exists():
        entries += [directory, *directory.glob('*.json')]
    if os.geteuid() != 0:
        raise ValueError('host administrator required')
    for entry in set(entries + [p for e in entries for p in e.parents]):
        info = entry.lstat()
        if entry.is_symlink() or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('unsafe host result installation')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=('run', 'flush'))
    parser.add_argument('--action', choices=('release', 'rollback'))
    parser.add_argument('--revision', default='')
    parser.add_argument('--digest', default='')
    parser.add_argument('--key', default='')
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    try:
        check_paths(ROOT)
        if args.operation == 'run':
            raise SystemExit(run(args.action, args.revision, args.digest, args.key))
        flush()
    except (Exception, KeyboardInterrupt):
        raise SystemExit('Deployment result pending or refused; inspect the host journal') from None
