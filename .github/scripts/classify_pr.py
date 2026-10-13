"""Select Docker labs from Git changes; operators cannot opt out of checks."""
import html
import json
import os
from pathlib import Path
import re
import subprocess


COMPAT_TESTS = {
    'tests/release-browser.mjs',
    'tests/release-compat.sh',
    'tests/release-routing.test.mjs',
}
CONTROLLER_TESTS = {
    'tests/deploy-controller-lab.py',
    'tests/deploy-controller.test.py',
    'tests/deploy-lab-preflight.py',
    'tests/deploy-lab-recovery.py',
    'tests/deploy-lab-traffic.mjs',
    'tests/deploy-lab-worker.mjs',
    'tests/inquiry-sync.test.ts',
    'tests/mleverage-source.test.ts',
    'tests/server-foundation.test.py',
    'tests/warp-delivery-cli.test.ts',
    'tests/warp-delivery.test.ts',
    'tests/worker-activation.test.ts',
    'tests/worker-health.test.ts',
    'tests/worker-process-child.ts',
    'tests/worker-processes.test.ts',
    'tests/worker-runtime-helper.ts',
    'tests/worker-runtime.test.ts',
}
# These helpers run in Actions/the operator CLI, not in either Docker lab.
# Their tests still run unconditionally in the verify job. Do not exempt a folder.
CLOUD_HELPERS = {
    'deploy/aws/release.py', 'deploy/aws/operator-release.py',
    'tests/cloud-release.test.py', 'tests/manual-release.test.py',
    'tests/operator-release.test.py',
}
CONTROLLER_FILES = {
    'deploy/controller.py', 'deploy/start-release.py', 'deploy/config.example.json',
    'deploy/marketing-recover.service', 'deploy/marketing-release.service',
    'deploy/marketing-release.timer', 'deploy/aws/cloudformation.json',
    'deploy/aws/foundation.json', 'deploy/aws/migration-inbox.json',
}
CONTROLLER_LIB = {
    'lib/inquiry-sync.ts',
    'lib/warp-delivery.ts',
    'lib/worker-health.ts',
}
COMPAT_LIB = {'lib/format.ts', 'lib/release-client.ts', 'lib/ui.ts'}
SHARED_FILES = {
    '.dockerignore', 'Dockerfile', 'auth.ts', 'next.config.ts',
    'package-lock.json', 'package.json', 'postcss.config.mjs',
    'prisma.config.ts', 'proxy.ts', 'tsconfig.json',
    'deploy/data-ops.py', 'deploy/nginx-config.mjs', 'deploy/landing-expand.py',
    'tests/selective-ci.test.py',
}


def path_rule(path):
    if path in SHARED_FILES or path.startswith(('.github/', 'prisma/', 'types/')):
        return True, True, 'shared runtime, schema or CI policy'
    if path.startswith(('app/api/', 'app/actions/')):
        return True, True, 'server API or action'
    if path in CLOUD_HELPERS:
        return False, False, 'cloud helper; unconditional verify tests cover this code'
    if path.endswith('.md'):
        return False, False, 'documentation'
    if path.startswith(('app/', 'components/')) and path.endswith('.css'):
        return False, False, 'stylesheet; runtime build and smoke still run'
    if path.startswith('app/fonts/') and path.endswith(('.woff', '.woff2', '.ttf', '.otf')):
        return False, False, 'font asset'
    if path.startswith('app/fonts/licenses/') and path.endswith('.txt'):
        return False, False, 'font license'
    if path.startswith(('app/', 'components/')) and path.endswith(('.ts', '.tsx', '.js', '.mjs')):
        return True, False, 'web UI compatibility'
    if path in COMPAT_LIB or path in COMPAT_TESTS:
        return True, False, 'release compatibility'
    if path in CONTROLLER_LIB or (path.startswith('workers/') and path.endswith(('.ts', '.js', '.mjs'))):
        return False, True, 'worker lifecycle'
    if path.startswith('lib/'):
        return True, True, 'shared application library'
    if path in {'scripts/warp-delivery.ts'}:
        return False, True, 'worker delivery'
    if path.startswith('scripts/'):
        return True, True, 'shared build or data script'
    if path in CONTROLLER_FILES or path in CONTROLLER_TESTS:
        return False, True, 'host controller or recovery'
    return True, True, 'unknown path; run all labs'


def classify_path(path):
    return path_rule(path)[:2]


def classify_paths(paths):
    if not paths:
        return True, True
    compat = controller = False
    for path in paths:
        web, lab = classify_path(path)
        compat |= web
        controller |= lab
    return compat, controller


def changed_paths(repo, base, head, event='pull_request'):
    if not all(re.fullmatch(r'[0-9a-f]{40}', sha or '') for sha in (base, head)):
        raise ValueError('invalid commit SHA')
    command = ['git', '-C', str(repo)]
    for sha in (base, head):
        kind = subprocess.check_output([*command, 'cat-file', '-t', sha], stderr=subprocess.DEVNULL, timeout=15)
        if kind != b'commit\n':
            raise ValueError('non-commit SHA')
    if event == 'push':
        # Rewritten history cannot use a merge-base diff: it can hide removals.
        subprocess.run([*command, 'merge-base', '--is-ancestor', base, head],
                       check=True, capture_output=True, timeout=15)
    comparison = [base, head] if event == 'push' else [f'{base}...{head}']
    raw = subprocess.check_output(
        [*command, 'diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', *comparison, '--'],
        stderr=subprocess.DEVNULL, timeout=15,
    )
    if raw and not raw.endswith(b'\0'):
        raise ValueError('incomplete git diff')
    return [os.fsdecode(part) for part in raw.split(b'\0') if part]


def plan_checks(event, base, head, repo):
    plan = {'event': event, 'base': base, 'head': head, 'compat': True,
            'controller': True, 'fallback': None, 'changes': []}
    if event not in ('pull_request', 'push'):
        plan['fallback'] = 'manual or unsupported event; run all labs'
        return plan
    try:
        paths = changed_paths(repo, base, head, event)
    except (OSError, subprocess.SubprocessError, ValueError):
        plan['fallback'] = 'invalid or unavailable Git comparison; run all labs'
        return plan
    if not paths:
        plan['fallback'] = 'empty change set; run all labs'
        return plan
    plan['compat'], plan['controller'] = classify_paths(paths)
    for path in paths:
        compat, controller, reason = path_rule(path)
        plan['changes'].append({'path': path, 'compat': compat, 'controller': controller, 'reason': reason})
    return plan


def decide(event, base, head, repo):
    plan = plan_checks(event, base, head, repo)
    return plan['compat'], plan['controller']


if __name__ == '__main__':
    plan = plan_checks(
        os.environ.get('GITHUB_EVENT_NAME'),
        os.environ.get('BASE_SHA'), os.environ.get('HEAD_SHA'), Path.cwd(),
    )
    lines = f"compat={str(plan['compat']).lower()}\ncontroller={str(plan['controller']).lower()}\n"
    with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as output:
        output.write(lines)
    # Escape repository-controlled filenames before rendering the audit record.
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as summary:
            summary.write('## Automatic CI check selection\n\n'
                          'Verify tests, runtime build and smoke always run. '
                          'Only additional Docker labs are selected below.\n\n<pre>'
                          + html.escape(json.dumps(plan, indent=2, ensure_ascii=True)) + '</pre>\n')
    print(json.dumps(plan, ensure_ascii=True))
