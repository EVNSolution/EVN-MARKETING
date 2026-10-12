"""Thin local entrypoint. GitHub CI owns builds; deploy.yml owns deployment."""
import argparse
import json
import re
import subprocess

REPO = 'EVNSolution/EVN-MARKETING'


def dispatch(action, revision, run_id=''):
    if action not in ('release', 'rollback') or not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise ValueError('exact current main SHA required')
    if action == 'release' and not re.fullmatch(r'[1-9][0-9]*', run_id):
        raise ValueError('successful main CI run ID required')
    command = ['gh', 'workflow', 'run', 'deploy.yml', '--repo', REPO, '--ref', 'main',
               '-f', 'action=' + action, '-f', 'source_sha=' + revision]
    if run_id:
        command += ['-f', 'ci_run_id=' + run_id]
    subprocess.run(command, check=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('release', 'rollback'))
    parser.add_argument('--source-sha', required=True)
    parser.add_argument('--ci-run-id', default='')
    args = parser.parse_args()
    dispatch(args.action, args.source_sha, args.ci_run_id)
