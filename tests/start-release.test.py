"""Exercise handoff, disconnect, wrong identity and failure without systemd."""
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('start_release',Path(__file__).resolve().parents[1]/'deploy/start-release.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
a={'revision':'a'*40,'digest':'sha256:'+'a'*64}
b={'revision':'b'*40,'digest':'sha256:'+'b'*64}
assert not m.activated({'phase':'starting','candidate':b},b)
assert not m.activated({'phase':'stable','active':a},b)
assert m.activated({'phase':'observing','candidate':b},b)
assert m.activated({'phase':'stable','active':b},b)
for args in [('release','main',b['digest']),('recover','',''),('release',b['revision'],'latest')]:
    try:m.command(*args)
    except ValueError:pass
    else:raise AssertionError('unsafe command accepted')
cmd=m.command('release',b['revision'],b['digest'])
assert '--property=RuntimeMaxSec=3600' in cmd and '--unit=marketing-deploy.service' in cmd
assert '--property=TimeoutStopSec=900' in cmd and cmd[-5:] == ['release','--revision',b['revision'],'--digest',b['digest']]
with tempfile.TemporaryDirectory() as directory:
    root=Path(directory);(root/'state').mkdir();state=root/'state/release.json'
    def save(value):state.write_text(json.dumps(value))
    def spawn(args,**kwargs):
        assert args[0]=='systemd-run'
        save({'phase':'observing','active':a,'candidate':b})
        return SimpleNamespace(returncode=0)
    with patch.object(m,'ROOT',root),patch.object(m.subprocess,'run',side_effect=spawn) as run:
        save({'phase':'stable','active':a})
        assert m.start('release',b['revision'],b['digest'])['phase']=='observing'
        assert run.call_count==1 # SSM exits; controller remains owned by systemd.
        run.reset_mock()
        try:m.start('release',b['revision'],b['digest'])
        except ValueError:pass
        else:raise AssertionError('duplicate transaction accepted')
        run.assert_not_called()
    save({'phase':'stable','active':a})
    with patch.object(m,'ROOT',root),patch.object(m.subprocess,'run',return_value=SimpleNamespace(returncode=1)),patch.object(m.time,'sleep'):
        try:m.start('release',b['revision'],b['digest'])
        except RuntimeError:pass
        else:raise AssertionError('failed activation accepted')
print('host observation handoff checks passed')
