"""Fault tests for host result delivery; synthetic state and GitHub API only."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('deployment_result', ROOT / 'deploy/deployment-result.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
A = {'revision': 'a' * 40, 'digest': 'sha256:' + 'a' * 64}
B = {'revision': 'b' * 40, 'digest': 'sha256:' + 'b' * 64}


class GitHub:
    def __init__(self):
        self.deployments = []; self.statuses = {}; self.calls = []
        self.fail_create_response = False; self.fail_status_response = False

    def __call__(self, method, path, token, body=None):
        assert token == 'synthetic-token'
        self.calls.append((method, path, body))
        base = '/repos/' + m.REPO + '/deployments'
        assert path.startswith(base)
        if '/statuses' in path:
            identity = int(path.split('/deployments/')[1].split('/')[0])
            if method == 'GET':
                return copy.deepcopy(self.statuses.get(identity, []))[:1]
            assert body['auto_inactive'] is False
            self.statuses.setdefault(identity, []).insert(0, copy.deepcopy(body))
            if self.fail_status_response:
                self.fail_status_response = False
                raise RuntimeError('response lost')
            return {'id': 55}
        if method == 'GET':
            if '?' in path:
                return copy.deepcopy(self.deployments)
            return copy.deepcopy(next(d for d in self.deployments if str(d['id']) == path.rsplit('/', 1)[1]))
        assert method == 'POST' and path == base
        assert body['auto_merge'] is False and body['required_contexts'] == []
        item = {**copy.deepcopy(body), 'sha': body['ref'], 'id': len(self.deployments) + 1}
        self.deployments.append(item)
        if self.fail_create_response:
            self.fail_create_response = False
            raise RuntimeError('response lost')
        return copy.deepcopy(item)


class FakeController:
    mode = 'success'
    releases = 0

    def __init__(self, root):
        self.path = root / 'state/release.json'
        self.state = json.loads(self.path.read_text())

    def release(self, revision, digest, rollback=False):
        FakeController.releases += 1
        target = self.state['previous'] if rollback else {'revision': revision, 'digest': digest}
        self.state = {'phase': 'stable', 'active': target}
        if self.mode in ('rollback', 'blocked'):
            self.state = {'phase': 'stable' if self.mode == 'rollback' else 'blocked', 'active': A}
        self.path.write_text(json.dumps(self.state))
        if self.mode != 'success':
            raise m.controller.Blocked('release_reverted' if self.mode == 'rollback' else 'recovery_required')


def fixture(root):
    (root / 'state').mkdir()
    (root / 'state/release.json').write_text(json.dumps({'phase': 'stable', 'active': A, 'previous': B}))
    (root / 'customer-data').write_bytes(b'latest records and uploads must not change')


def record(key='run-123-1'):
    return {'format': 1, 'key': key, 'action': 'release', 'sourceSha': B['revision'], 'origin': A,
            'target': B, 'createdAt': 123}


def read_result(root, key='run-123-1'):
    return json.loads((root / 'state/deployment-results' / (key + '.json')).read_text())


# Actual outcome identity, not merely exit status or a generic stable journal.
assert m.outcome(record(), {'phase': 'observing', 'candidate': B})['state'] == 'error'
assert m.outcome(record(), {'phase': 'stable', 'active': {**B, 'digest': A['digest']}})['state'] == 'error'
assert m.outcome(record(), {'phase': 'stable', 'active': B})['state'] == 'success'
assert m.outcome(record(), {'phase': 'stable', 'active': A}, completed=True)['state'] == 'failure'

for mode, action, expected in [('success', 'release', 'success'), ('rollback', 'release', 'failure'),
                               ('blocked', 'release', 'error'), ('success', 'rollback', 'success')]:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory); fixture(root); github = GitHub()
        FakeController.mode = mode; FakeController.releases = 0
        with patch.object(m, 'api', side_effect=github), patch.object(m, 'installation_token', return_value='synthetic-token'), \
                patch.object(m.controller, 'Controller', FakeController), \
                patch.object(m.subprocess, 'run', return_value=SimpleNamespace(returncode=0)):
            code = m.run(action, B['revision'], B['digest'], 'run-123-1', root)
        result = read_result(root)
        assert result['outcome']['state'] == expected and result['delivered'] == result['outcome']
        assert code == (0 if expected == 'success' else 1)
        assert FakeController.releases == 1
        assert [s['state'] for s in github.statuses[1]] == [expected, 'in_progress']
        assert (root / 'customer-data').read_bytes() == b'latest records and uploads must not change'

# Final API outage does not reverse a successful release. Retry only delivers the saved result.
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory); fixture(root); github = GitHub()
    FakeController.mode = 'success'; FakeController.releases = 0
    with patch.object(m, 'api', side_effect=github), \
            patch.object(m, 'installation_token', side_effect=['synthetic-token', RuntimeError('offline')]), \
            patch.object(m.controller, 'Controller', FakeController), \
            patch.object(m.subprocess, 'run', return_value=SimpleNamespace(returncode=0)):
        assert m.run('release', B['revision'], B['digest'], 'run-123-1', root) == 0
    saved = read_result(root)
    assert saved['outcome']['state'] == 'success' and saved['delivered']['state'] == 'in_progress'
    with patch.object(m, 'api', side_effect=github), patch.object(m, 'installation_token', return_value='synthetic-token'):
        m.flush(root); m.flush(root)
    assert len(github.statuses[1]) == 2 and FakeController.releases == 1
    assert read_result(root)['delivered']['state'] == 'success'

# Credential/timer failure before activation preserves the original service.
for timer_ok in (True, False):
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory); fixture(root); FakeController.releases = 0
        with patch.object(m, 'installation_token', side_effect=RuntimeError('auth unavailable')), \
                patch.object(m.controller, 'Controller', FakeController), \
                patch.object(m.subprocess, 'run', return_value=SimpleNamespace(returncode=0 if timer_ok else 1)):
            try:
                assert m.run('release', B['revision'], B['digest'], 'run-123-1', root) == 1
            except ValueError:
                assert not timer_ok
        assert FakeController.releases == 0
        assert json.loads((root / 'state/release.json').read_text())['active'] == A

# Reboot/SIGKILL after a durable request: never call the controller from the reporting timer.
for active, phase, expected in [(A, 'stable', 'failure'), (B, 'stable', 'success'), (A, 'blocked', 'error')]:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory); fixture(root)
        path = root / 'state/deployment-results/run-123-1.json'; path.parent.mkdir()
        m.save(path, record()); github = GitHub()
        (root / 'state/release.json').write_text(json.dumps({'phase': phase, 'active': active}))
        with patch.object(m, 'unit_running', return_value=True), patch.object(m, 'installation_token') as auth:
            m.flush(root); auth.assert_not_called()
        with patch.object(m, 'unit_running', return_value=False), patch.object(m, 'api', side_effect=github), \
                patch.object(m, 'installation_token', return_value='synthetic-token'), \
                patch.object(m.controller, 'Controller', side_effect=AssertionError('timer must not deploy')):
            m.flush(root)
        assert read_result(root)['delivered']['state'] == expected

# A new deployment seals the interrupted old request before replacing the host journal.
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory); fixture(root); github = GitHub()
    pending = root / 'state/deployment-results/run-122-1.json'; pending.parent.mkdir()
    m.save(pending, record('run-122-1'))
    FakeController.mode = 'success'
    with patch.object(m, 'api', side_effect=github), patch.object(m, 'installation_token', return_value='synthetic-token'), \
            patch.object(m.controller, 'Controller', FakeController), \
            patch.object(m.subprocess, 'run', return_value=SimpleNamespace(returncode=0)):
        assert m.run('release', B['revision'], B['digest'], 'run-123-1', root) == 0
    assert read_result(root, 'run-122-1')['outcome']['state'] == 'failure'
    assert read_result(root, 'run-123-1')['outcome']['state'] == 'success'

# Lost create/status responses and a restarted retry do not create duplicate deployments/statuses.
for lost in ('fail_create_response', 'fail_status_response'):
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / 'result.json'; item = record(); github = GitHub()
        m.save(path, item); setattr(github, lost, True)
        with patch.object(m, 'api', side_effect=github):
            try: m.deliver(path, item, 'synthetic-token')
            except RuntimeError: pass
            else: raise AssertionError('failure was not injected')
            item = json.loads(path.read_text()); m.deliver(path, item, 'synthetic-token')
        assert len(github.deployments) == 1 and len(github.statuses[1]) == 1

# Old results keep their own deployment identity after a later release changes the host journal.
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory); fixture(root); github = GitHub()
    directory = root / 'state/deployment-results'; directory.mkdir()
    for key, state in [('run-123-1', 'failure'), ('run-124-1', 'success')]:
        item = record(key); item['outcome'] = {'state': state, 'description': 'recorded outcome'}
        m.save(directory / (key + '.json'), item)
    with patch.object(m, 'api', side_effect=github), patch.object(m, 'installation_token', return_value='synthetic-token'):
        m.flush(root)
    assert [github.statuses[i][0]['state'] for i in (1, 2)] == ['failure', 'success']
    item = read_result(root); item['delivered'] = None
    github.deployments[0]['payload']['key'] = 'run-999-1'
    with patch.object(m, 'api', side_effect=github):
        try: m.deliver(directory / 'run-123-1.json', item, 'synthetic-token')
        except ValueError: pass
        else: raise AssertionError('wrong deployment identity accepted')

# App JWT is signed with the real OpenSSL implementation; requested token has only this repo and permission.
with tempfile.TemporaryDirectory() as directory:
    private = Path(directory) / 'key.pem'
    subprocess.run(['openssl', 'genrsa', '-out', str(private), '2048'], check=True, capture_output=True)
    config = {'appId': 123, 'installationId': 456, 'privateKey': private.read_text()}
    original_run = subprocess.run
    def local_aws(args, **kwargs):
        if args[0] == 'aws':
            assert args[args.index('--names') + 1] == m.PARAMETER
            return SimpleNamespace(stdout=json.dumps({'Parameters': [{'Name': m.PARAMETER, 'Value': json.dumps(config)}]}))
        return original_run(args, **kwargs)
    def grant(method, path, token, body):
        assert method == 'POST' and path == '/app/installations/456/access_tokens'
        assert body == {'repositories': ['EVN-MARKETING'], 'permissions': {'deployments': 'write'}}
        header, claims, signature = token.split('.')
        decode = lambda value: m.base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))
        assert json.loads(decode(header))['alg'] == 'RS256'
        assert json.loads(decode(claims))['exp'] - json.loads(decode(claims))['iat'] == 600
        public = Path(directory) / 'public.pem'; sig = Path(directory) / 'signature'
        original_run(['openssl', 'rsa', '-in', str(private), '-pubout', '-out', str(public)], check=True, capture_output=True)
        sig.write_bytes(decode(signature))
        original_run(['openssl', 'dgst', '-sha256', '-verify', str(public), '-signature', str(sig)],
                     input=(header + '.' + claims).encode(), check=True, capture_output=True)
        return {'token': 'synthetic-token', 'permissions': {'deployments': 'write', 'metadata': 'read'},
                'repositories': [{'full_name': m.REPO}]}
    with patch.object(m.subprocess, 'run', side_effect=local_aws), patch.object(m, 'api', side_effect=grant):
        assert m.installation_token() == 'synthetic-token'
    with patch.object(m.subprocess, 'run', side_effect=local_aws), patch.object(m, 'api', return_value={
            'token': 'broad-token', 'permissions': {'deployments': 'write', 'contents': 'write'},
            'repositories': [{'full_name': m.REPO}]}):
        try: m.installation_token()
        except ValueError: pass
        else: raise AssertionError('broad token accepted')

workflow = (ROOT / '.github/workflows/deploy.yml').read_text()
assert 'deployment: false' in workflow and 'name: Marketing activate' in workflow
assert 'sleep 1800' not in workflow and 'schedule:' not in workflow
assert 'deployment-result.py flush' in (ROOT / 'deploy/marketing-result.service').read_text()
assert 'OnUnitInactiveSec=60s' in (ROOT / 'deploy/marketing-result.timer').read_text()
assert m.controller.WINDOW == 1800
print('deployment result tests passed: success, rollback, recovery, outages, idempotence, identity and scoped App JWT')
