"""Regression checks for the conservative PR heavy-lane classifier."""
import importlib.util
from itertools import takewhile
import json
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / '.github/scripts/classify_pr.py'
spec = importlib.util.spec_from_file_location('classify_pr', SCRIPT)
classifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(classifier)


class ClassificationTests(unittest.TestCase):
    def test_path_boundaries(self):
        cases = [
            (['package-lock.json'], (True, True)),
            (['app/(app)/customers/page.tsx'], (True, False)),
            (['deploy/controller.py'], (False, True)),
            (['deploy/start-release.py'], (False, True)),
            (['deploy/data-ops.py'], (True, True)),
            (['deploy/landing-expand.py'], (True, True)),
            (['deploy/aws/cloudformation.json'], (False, True)),
            (['deploy/aws/release.py', 'tests/cloud-release.test.py', 'tests/manual-release.test.py'], (False, False)),
            (['deploy/aws/operator-release.py', 'tests/operator-release.test.py'], (False, False)),
            (['deploy/aws/release.py', 'workers/inquiry-sync.ts'], (False, True)),
            (['deploy/aws/release.py', 'app/page.tsx'], (True, False)),
            (['deploy/aws/release.py', 'prisma/schema.prisma'], (True, True)),
            (['deploy/aws/new-helper.py'], (True, True)),
            (['tests/new-cloud-release.test.py'], (True, True)),
            (['.github/scripts/classify_pr.py'], (True, True)),
            (['tests/selective-ci.test.py'], (True, True)),
            (['.github/scripts/release_artifact.py'], (True, True)),
            (['lib/db.ts'], (True, True)),
            (['app/api/customers/[id]/documents/route.ts'], (True, True)),
            (['tests/release-browser.mjs'], (True, False)),
            (['tests/deploy-controller-lab.py'], (False, True)),
            (['app/globals.css', 'app/fonts/Jost-variable.woff2', 'README.md'], (False, False)),
            (['docs/integrations/WARP_MARKETING_INQUIRIES.json'], (True, True)),
            (['.github/workflows/unknown.css'], (True, True)),
            (['app/api/unknown.css'], (True, True)),
            (['unknown/new.css'], (True, True)),
            (['unknown/new-file.bin'], (True, True)),
            ([], (True, True)),
        ]
        for paths, expected in cases:
            with self.subTest(paths=paths):
                self.assertEqual(classifier.classify_paths(paths), expected)

    def test_manual_or_invalid_diff_runs_both(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            self.assertEqual(classifier.decide('workflow_dispatch', '', '', repo), (True, True))
            self.assertEqual(classifier.decide('pull_request', 'HEAD', 'a' * 40, repo), (True, True))
            self.assertEqual(classifier.decide('pull_request', 'a' * 40, 'b' * 40, repo), (True, True))

    def test_cloud_helpers_keep_mandatory_tests_and_no_operator_skip_input(self):
        workflow = (SCRIPT.parents[1] / 'workflows/ci.yml').read_text()
        verify = workflow.split('  verify:\n', 1)[1].split('  plan:\n', 1)[0]
        self.assertNotRegex(verify, r'(?m)^\s*if:')
        for name in ('cloud-release', 'manual-release', 'operator-release', 'selective-ci'):
            self.assertIn(f'python3 tests/{name}.test.py', verify)
        self.assertNotIn('inputs.', workflow)
        self.assertIn('  workflow_dispatch:\npermissions:', workflow)

    def test_workflow_rejects_missing_or_invalid_classifier_outputs(self):
        workflow = (SCRIPT.parents[1] / 'workflows/ci.yml').read_text()
        step = workflow.split('      - name: Require a complete automated check selection\n', 1)[1]
        lines = step.split('        run: |\n', 1)[1].splitlines()
        script = textwrap.dedent('\n'.join(takewhile(lambda line: line.startswith('          '), lines)))
        for compat, controller in [('true', 'true'), ('false', 'false'), ('true', 'false'), ('false', 'true'),
                                   ('', 'false'), ('false', ''), ('False', 'true'), ('true', 'skipped')]:
            with self.subTest(compat=compat, controller=controller):
                result = subprocess.run(['bash', '-e', '-c', script],
                                        env={**os.environ, 'CHECK_COMPAT': compat, 'CHECK_CONTROLLER': controller})
                valid = compat in ('true', 'false') and controller in ('true', 'false')
                self.assertEqual(result.returncode == 0, valid)

    def test_comparison_failures_cannot_skip_labs(self):
        for error in (OSError(), subprocess.TimeoutExpired('git', 15), ValueError()):
            with self.subTest(error=type(error).__name__), patch.object(classifier, 'changed_paths', side_effect=error):
                plan = classifier.plan_checks('push', 'a' * 40, 'b' * 40, Path('.'))
                self.assertTrue(plan['compat'] and plan['controller'])
                self.assertIn('invalid or unavailable', plan['fallback'])

    def test_incomplete_git_output_cannot_skip_labs(self):
        with patch.object(classifier.subprocess, 'check_output', side_effect=[b'commit\n', b'commit\n', b'README.md']):
            self.assertEqual(classifier.decide('pull_request', 'a' * 40, 'b' * 40, Path('.')), (True, True))

    def test_all_commits_and_deleted_paths_are_classified(self):
        repo = self.new_repo()
        base = self.commit_file(repo, 'deploy/controller.py', 'old controller')
        (repo / 'deploy/controller.py').unlink()
        self.commit_file(repo, 'deploy/aws/release.py', 'cloud helper')
        head = self.commit_file(repo, 'README.md', 'latest commit only changes docs')
        for event in ('pull_request', 'push'):
            with self.subTest(event=event):
                plan = classifier.plan_checks(event, base, head, repo)
                self.assertFalse(plan['compat'])
                self.assertTrue(plan['controller'])
                self.assertEqual(len(plan['changes']), 3)

    def test_rewritten_push_runs_all_even_when_merge_base_diff_looks_safe(self):
        repo = self.new_repo()
        ancestor = self.commit_file(repo, 'README.md', 'base')
        base = self.commit_file(repo, 'deploy/controller.py', 'important controller')
        self.git(repo, 'checkout', '-q', '--detach', ancestor)
        head = self.commit_file(repo, 'README.md', 'docs on another history')
        self.assertEqual(classifier.decide('pull_request', base, head, repo), (False, False))
        plan = classifier.plan_checks('push', base, head, repo)
        self.assertTrue(plan['compat'] and plan['controller'])
        self.assertIn('invalid or unavailable', plan['fallback'])

    def test_first_push_and_missing_commit_run_all(self):
        repo = self.new_repo()
        head = self.commit_file(repo, 'README.md', 'docs')
        for base in ('0' * 40, 'f' * 40):
            self.assertEqual(classifier.decide('push', base, head, repo), (True, True))

    def test_rename_classifies_old_and_new_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            self.git(repo, 'init', '-q')
            self.git(repo, 'config', 'user.name', 'Synthetic CI')
            self.git(repo, 'config', 'user.email', 'synthetic@example.invalid')
            old = repo / 'app/page.tsx'
            old.parent.mkdir()
            old.write_text('export default function Page() { return null }\n')
            self.git(repo, 'add', '.')
            self.git(repo, 'commit', '-qm', 'old')
            base = self.git(repo, 'rev-parse', 'HEAD').strip()
            new = repo / 'deploy/controller.py'
            new.parent.mkdir()
            old.rename(new)
            self.git(repo, 'add', '-A')
            self.git(repo, 'commit', '-qm', 'new')
            head = self.git(repo, 'rev-parse', 'HEAD').strip()
            self.assertEqual(set(classifier.changed_paths(repo, base, head)),
                             {'app/page.tsx', 'deploy/controller.py'})
            self.assertEqual(classifier.decide('pull_request', base, head, repo), (True, True))
            self.assertEqual(classifier.decide('pull_request', base, base, repo), (True, True))

    def test_fast_change_writes_explicit_false_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            self.git(repo, 'init', '-q')
            self.git(repo, 'config', 'user.name', 'Synthetic CI')
            self.git(repo, 'config', 'user.email', 'synthetic@example.invalid')
            css = repo / 'app/globals.css'
            css.parent.mkdir()
            css.write_text('body { color: black }\n')
            self.git(repo, 'add', '.')
            self.git(repo, 'commit', '-qm', 'base')
            base = self.git(repo, 'rev-parse', 'HEAD').strip()
            css.write_text('body { color: navy }\n')
            self.git(repo, 'commit', '-qam', 'css')
            head = self.git(repo, 'rev-parse', 'HEAD').strip()
            output = repo / 'actions-output'
            summary = repo / 'actions-summary'
            env = {**os.environ, 'GITHUB_EVENT_NAME': 'pull_request',
                   'BASE_SHA': base, 'HEAD_SHA': head, 'GITHUB_OUTPUT': str(output),
                   'GITHUB_STEP_SUMMARY': str(summary)}
            result = subprocess.run(['python3', str(SCRIPT)], cwd=repo, env=env, check=True, capture_output=True)
            self.assertEqual(output.read_text(), 'compat=false\ncontroller=false\n')
            plan = json.loads(result.stdout)
            self.assertEqual((plan['base'], plan['head']), (base, head))
            self.assertEqual(plan['changes'][0]['path'], 'app/globals.css')
            self.assertIn('stylesheet', plan['changes'][0]['reason'])
            self.assertIn('runtime build and smoke always run', summary.read_text())

    def test_cli_uses_git_changes_and_escapes_report_paths(self):
        repo = self.new_repo()
        base = self.commit_file(repo, 'README.md', 'base')
        head = self.commit_file(repo, 'deploy/aws/release.py', 'changed cloud helper')
        output, summary = repo / 'actions-output', repo / 'actions-summary'
        env = {**os.environ, 'GITHUB_EVENT_NAME': 'push', 'BASE_SHA': base, 'HEAD_SHA': head,
               'GITHUB_OUTPUT': str(output), 'GITHUB_STEP_SUMMARY': str(summary),
               'CHECK_COMPAT': 'true', 'CHECK_CONTROLLER': 'true'}
        result = subprocess.run(['python3', str(SCRIPT)], cwd=repo, env=env, check=True, capture_output=True)
        plan = json.loads(result.stdout)
        self.assertFalse(plan['compat'] or plan['controller'])
        self.assertIn('cloud helper', plan['changes'][0]['reason'])
        head = self.commit_file(repo, 'unknown/</pre><script>.py', 'unknown change')
        env.update(HEAD_SHA=head, CHECK_COMPAT='false', CHECK_CONTROLLER='false')
        result = subprocess.run(['python3', str(SCRIPT)], cwd=repo, env=env, check=True, capture_output=True)
        plan = json.loads(result.stdout)
        self.assertTrue(plan['compat'] and plan['controller'])
        self.assertNotIn('<script>', summary.read_text())
        self.assertIn('&lt;script&gt;', summary.read_text())

    def new_repo(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        repo = Path(directory.name)
        self.git(repo, 'init', '-q')
        self.git(repo, 'config', 'user.name', 'Synthetic CI')
        self.git(repo, 'config', 'user.email', 'synthetic@example.invalid')
        return repo

    def commit_file(self, repo, path, contents):
        file = repo / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(contents)
        self.git(repo, 'add', '-A')
        self.git(repo, 'commit', '-qm', 'synthetic fixture')
        return self.git(repo, 'rev-parse', 'HEAD').strip()

    @staticmethod
    def git(repo, *args):
        return subprocess.check_output(['git', '-C', str(repo), *args], text=True)


if __name__ == '__main__':
    unittest.main()
