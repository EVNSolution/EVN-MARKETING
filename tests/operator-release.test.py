"""The local CLI cannot rebuild or bypass the deployment workflow."""
import importlib.util
from pathlib import Path
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('operator', Path(__file__).resolve().parents[1] / 'deploy/aws/operator-release.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
with patch.object(m.subprocess, 'run') as run:
    for action, sha, run_id in [('publish', 'a'*40, '1'), ('release', 'main', '1'), ('release', 'a'*40, ''), ('release', 'a'*40, '1;id')]:
        try: m.dispatch(action, sha, run_id)
        except ValueError: pass
        else: raise AssertionError('unsafe input accepted')
    run.assert_not_called()
    m.dispatch('release', 'a'*40, '123')
    assert run.call_args.args[0][-2:] == ['-f', 'ci_run_id=123']
    m.dispatch('rollback', 'a'*40)
    assert 'ci_run_id=' not in ' '.join(run.call_args.args[0])
print('workflow-only operator checks passed')
