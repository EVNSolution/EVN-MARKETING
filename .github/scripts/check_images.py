"""Run independent image checks together; promote a receipt only after all pass."""
from concurrent.futures import ThreadPoolExecutor, as_completed
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
PRINT_LOCK = threading.Lock()


def selected(value):
    if value not in ('true', 'false'):
        raise ValueError('invalid automated CI selection')
    return value == 'true'


def run_checks(tasks, pending, receipt, report):
    # Stale output must never make a failed rerun deployable.
    pending.unlink(missing_ok=True)
    receipt.unlink(missing_ok=True)
    timings = []

    def timed(name, action):
        started = time.monotonic()
        print(f'CI stage started: {name}', flush=True)
        try:
            action()
            ok = True
        except Exception as error:
            # Subprocess output is in the synthetic CI log, not exception/env dumps.
            print(f'CI stage failed: {name} ({type(error).__name__})', flush=True)
            ok = False
        return {'stage': name, 'seconds': round(time.monotonic() - started, 2), 'ok': ok}

    started = time.monotonic()
    with ThreadPoolExecutor(max_workers=len(tasks)) as pool:
        futures = [pool.submit(timed, name, action) for name, action in tasks.items()]
        for future in as_completed(futures):
            result = future.result()
            timings.append(result)
            print(json.dumps(result), flush=True)
    result = {'sourceSha': os.environ.get('GITHUB_SHA'), 'stages': timings,
              'wallSeconds': round(time.monotonic() - started, 2),
              'ok': all(item['ok'] for item in timings)}
    report.write_text(json.dumps(result, indent=2) + '\n')
    if not result['ok']:
        pending.unlink(missing_ok=True)
        raise RuntimeError('required image checks failed')
    if 'registry' in tasks:
        pending.replace(receipt)
    return result


def main():
    compat = selected(os.environ.get('CHECK_COMPAT'))
    controller = selected(os.environ.get('CHECK_CONTROLLER'))
    if os.environ.get('GITHUB_ACTIONS') != 'true':
        raise ValueError('ephemeral CI runner required')
    temporary = Path(os.environ['RUNNER_TEMP'])
    revision = os.environ['GITHUB_SHA']
    pending = temporary / 'marketing-pending-receipt.json'
    receipt = ROOT / 'release-receipt.json'
    report = temporary / 'marketing-ci-timings.json'
    profile = temporary / 'marketing-controller-timings.jsonl'
    profile.unlink(missing_ok=True)

    def command(name, args, timeout=900):
        log = temporary / f'marketing-{name}.log'
        with log.open('w') as output:
            try:
                subprocess.run(args, cwd=ROOT, stdout=output, stderr=subprocess.STDOUT,
                               check=True, timeout=timeout)
            finally:
                output.flush()
                with PRINT_LOCK:
                    print(f'::group::{name}', flush=True)
                    print(log.read_text(), flush=True)
                    print('::endgroup::', flush=True)

    def build(name, context, target, tag, source, scope):
        command(name, ['docker', 'buildx', 'build', '--platform', 'linux/amd64', '--load',
                      '--provenance=false', '--target', target, '--tag', tag,
                      '--build-arg', 'MARKETING_BUILD_REVISION=' + source,
                      '--label', 'org.opencontainers.image.revision=' + source,
                      '--cache-from', 'type=gha,scope=' + scope,
                      '--cache-to', 'type=gha,mode=max,scope=' + scope, str(context)])

    def compatibility():
        build('operations-build', ROOT, 'operations', 'evn-marketing:ops', revision, 'marketing-operations')
        bridge = temporary / 'marketing-bridge'
        bridge.mkdir()
        archive = temporary / 'marketing-bridge.tar'
        source = 'd6d7df889f1a1ca52769a1615e352034f09c3bb8'
        command('bridge-source', ['git', 'archive', '--output', str(archive), source])
        command('bridge-extract', ['tar', '-xf', str(archive), '-C', str(bridge)])
        build('bridge-build', bridge, 'runtime', 'evn-marketing:compat-a', source, 'marketing-bridge-d6d7df8')
        command('compatibility', ['bash', 'tests/release-compat.sh'])

    def registry():
        spec = importlib.util.spec_from_file_location('artifact', ROOT / '.github/scripts/release_artifact.py')
        artifact = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(artifact)
        artifact.publish(pending)

    tasks = {'smoke': lambda: command('smoke', ['bash', 'tests/container-smoke.sh'])}
    if controller:
        tasks['controller'] = lambda: command('controller', ['python3', 'tests/deploy-controller-lab.py'])
    if compat:
        tasks['compatibility'] = compatibility
    if os.environ.get('GITHUB_EVENT_NAME') == 'push' and os.environ.get('GITHUB_REF') == 'refs/heads/main':
        tasks['registry'] = registry
    try:
        run_checks(tasks, pending, receipt, report)
    finally:
        if report.exists():
            result = json.loads(report.read_text())
            if profile.exists():
                totals = {}
                for line in profile.read_text().splitlines():
                    item = json.loads(line)
                    total = totals.setdefault(item['stage'], {'calls': 0, 'seconds': 0})
                    total['calls'] += 1
                    total['seconds'] = round(total['seconds'] + item['seconds'], 4)
                result['controllerProfile'] = totals
                report.write_text(json.dumps(result, indent=2) + '\n')
            with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as output:
                output.write('\n## Image check timings\n\n| Stage | Seconds | Passed |\n| --- | ---: | --- |\n')
                for item in result['stages']:
                    output.write(f"| {item['stage']} | {item['seconds']} | {item['ok']} |\n")
                output.write(f"\nConcurrent wall time: {result['wallSeconds']} seconds.\n")
                if 'controllerProfile' in result:
                    output.write('\n### Controller timings\n\nSections contain commands and waits; do not sum both.\n\n| Operation | Calls | Seconds |\n| --- | ---: | ---: |\n')
                    for name, item in sorted(result['controllerProfile'].items()):
                        output.write(f"| {name} | {item['calls']} | {item['seconds']:.2f} |\n")


if __name__ == '__main__':
    main()
