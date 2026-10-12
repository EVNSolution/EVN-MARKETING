"""Publish once in main CI; deploy only a successful main run's exact receipt."""
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('release', ROOT / 'deploy/aws/release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


def validate(receipt, run, revision, run_id, bundle):
    if (run.get('id') != int(run_id) or run.get('event') != 'push' or run.get('head_branch') != 'main'
            or run.get('head_sha') != revision or run.get('status') != 'completed'
            or run.get('conclusion') != 'success' or run.get('path') != '.github/workflows/ci.yml'
            or run.get('repository', {}).get('full_name') != release.REPOSITORY):
        raise ValueError('successful current-main CI run required')
    if (receipt.get('format') != 1 or receipt.get('sourceSha') != revision
            or receipt.get('runId') != int(run_id) or receipt.get('repository') != release.REPOSITORY
            or receipt.get('bundleSha256') != bundle):
        raise ValueError('release receipt identity mismatch')
    return release.checked(receipt.get('digest'), r'sha256:[0-9a-f]{64}', 'receipt digest')


def publish(receipt_path=None):
    env = os.environ
    revision = release.checked(env.get('GITHUB_SHA'), r'[0-9a-f]{40}', 'source SHA')
    if env.get('GITHUB_EVENT_NAME') != 'push' or env.get('GITHUB_REF') != 'refs/heads/main' or env.get('GITHUB_REPOSITORY') != release.REPOSITORY:
        raise ValueError('only main push CI can publish')
    account = release.checked(env.get('MARKETING_AWS_ACCOUNT_ID'), r'[0-9]{12}', 'account')
    registry = f'{account}.dkr.ecr.{release.REGION}.amazonaws.com'
    image = f'{registry}/evn-marketing:{revision}'
    repositories = release.aws('ecr', 'describe-repositories', '--repository-names', 'evn-marketing')['repositories']
    if len(repositories) != 1 or repositories[0].get('imageTagMutability') != 'IMMUTABLE':
        raise ValueError('immutable repository required')
    probe = subprocess.run(['aws', 'ecr', 'describe-images', '--repository-name', 'evn-marketing',
                            '--image-ids', 'imageTag=' + revision, '--output', 'json'], capture_output=True, text=True)
    if probe.returncode:
        if 'ImageNotFoundException' not in probe.stderr:
            raise RuntimeError('image lookup failed')
        password = release.output(['aws', 'ecr', 'get-login-password', '--region', release.REGION])
        subprocess.run(['docker', 'login', '--username', 'AWS', '--password-stdin', registry],
                       input=password, text=True, check=True, capture_output=True)
        try:
            subprocess.run(['docker', 'tag', 'evn-marketing:ci', image], check=True)
            subprocess.run(['docker', 'push', image], check=True)
        finally:
            subprocess.run(['docker', 'logout', registry], check=True, capture_output=True)
    images = release.aws('ecr', 'describe-images', '--repository-name', 'evn-marketing',
                         '--image-ids', 'imageTag=' + revision)['imageDetails']
    if len(images) != 1:
        raise ValueError('image identity missing')
    digest = release.checked(images[0]['imageDigest'], r'sha256:[0-9a-f]{64}', 'image digest')
    # A rerun may reuse only the immutable image already published for this exact source.
    release.scan(digest)
    receipt = {'format': 1, 'repository': release.REPOSITORY, 'sourceSha': revision,
               'runId': int(env['GITHUB_RUN_ID']), 'digest': digest, 'bundleSha256': release.bundle_hash(ROOT)}
    (receipt_path or ROOT / 'release-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')


if __name__ == '__main__':
    if sys.argv[1] == 'publish':
        publish()
    elif sys.argv[1] == 'verify':
        run_id = release.checked(os.environ.get('CI_RUN_ID'), r'[1-9][0-9]*', 'CI run ID')
        run = json.loads(release.output(['gh', 'api', f'repos/{release.REPOSITORY}/actions/runs/{run_id}']))
        digest = validate(json.loads(Path('release-receipt.json').read_text()), run,
                          release.check_source(), run_id, release.bundle_hash(ROOT))
        with open(os.environ['GITHUB_OUTPUT'], 'a') as out:
            out.write('digest=' + digest + '\n')
    else:
        raise ValueError('unknown operation')
