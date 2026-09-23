"""Regression checks for the conservative PR heavy-lane classifier."""
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


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
            env = {**os.environ, 'GITHUB_EVENT_NAME': 'pull_request',
                   'BASE_SHA': base, 'HEAD_SHA': head, 'GITHUB_OUTPUT': str(output)}
            subprocess.run(['python3', str(SCRIPT)], cwd=repo, env=env, check=True, capture_output=True)
            self.assertEqual(output.read_text(), 'compat=false\ncontroller=false\n')

    @staticmethod
    def git(repo, *args):
        return subprocess.check_output(['git', '-C', str(repo), *args], text=True)


if __name__ == '__main__':
    unittest.main()
