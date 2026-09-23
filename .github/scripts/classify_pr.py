"""Select the expensive PR checks; uncertain changes run both lanes."""
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
    'tests/cloud-release.test.py',
    'tests/deploy-controller-lab.py',
    'tests/deploy-controller.test.py',
    'tests/deploy-lab-recovery.py',
    'tests/deploy-lab-traffic.mjs',
    'tests/deploy-lab-worker.mjs',
    'tests/inquiry-sync.test.ts',
    'tests/manual-release.test.py',
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
    'deploy/data-ops.py', 'deploy/nginx-config.mjs',
}


def classify_path(path):
    if path in SHARED_FILES or path.startswith(('.github/', 'prisma/', 'types/')):
        return True, True
    if path.startswith(('app/api/', 'app/actions/')):
        return True, True
    if path.endswith('.md'):
        return False, False
    if path.startswith(('app/', 'components/')) and path.endswith('.css'):
        return False, False
    if path.startswith('app/fonts/') and path.endswith(('.woff', '.woff2', '.ttf', '.otf')):
        return False, False
    if path.startswith('app/fonts/licenses/') and path.endswith('.txt'):
        return False, False
    if path.startswith(('app/', 'components/')) and path.endswith(('.ts', '.tsx', '.js', '.mjs')):
        return True, False
    if path in COMPAT_LIB:
        return True, False
    if path in CONTROLLER_LIB or (path.startswith('workers/') and path.endswith(('.ts', '.js', '.mjs'))):
        return False, True
    if path.startswith('lib/'):
        return True, True
    if path in {'scripts/warp-delivery.ts'}:
        return False, True
    if path.startswith('scripts/'):
        return True, True
    if path.startswith('deploy/') and path.endswith(('.py', '.mjs', '.json', '.service', '.timer')):
        return False, True
    if path in COMPAT_TESTS:
        return True, False
    if path in CONTROLLER_TESTS:
        return False, True
    return True, True


def classify_paths(paths):
    if not paths:
        return True, True
    compat = controller = False
    for path in paths:
        web, lab = classify_path(path)
        compat |= web
        controller |= lab
    return compat, controller


def changed_paths(repo, base, head):
    if not all(re.fullmatch(r'[0-9a-f]{40}', sha or '') for sha in (base, head)):
        raise ValueError('invalid commit SHA')
    command = ['git', '-C', str(repo)]
    for sha in (base, head):
        kind = subprocess.check_output([*command, 'cat-file', '-t', sha], stderr=subprocess.DEVNULL, timeout=15)
        if kind != b'commit\n':
            raise ValueError('non-commit SHA')
    raw = subprocess.check_output(
        [*command, 'diff', '--no-renames', '--name-only', '-z', f'{base}...{head}'],
        stderr=subprocess.DEVNULL, timeout=15,
    )
    if raw and not raw.endswith(b'\0'):
        raise ValueError('incomplete git diff')
    return [os.fsdecode(part) for part in raw.split(b'\0') if part]


def decide(event, base, head, repo):
    if event != 'pull_request':
        return True, True
    try:
        return classify_paths(changed_paths(repo, base, head))
    except (OSError, subprocess.SubprocessError, ValueError):
        return True, True


if __name__ == '__main__':
    compat, controller = decide(
        os.environ.get('GITHUB_EVENT_NAME'),
        os.environ.get('BASE_SHA'), os.environ.get('HEAD_SHA'), Path.cwd(),
    )
    lines = f'compat={str(compat).lower()}\ncontroller={str(controller).lower()}\n'
    with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as output:
        output.write(lines)
    print(lines, end='')
