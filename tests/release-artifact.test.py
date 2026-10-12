"""Reject successful receipts from the wrong run, repository, source or workflow."""
import copy
import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location('artifact', Path(__file__).resolve().parents[1] / '.github/scripts/release_artifact.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
sha, digest, bundle = 'a'*40, 'sha256:'+'b'*64, 'c'*64
run = {'id':123,'event':'push','head_branch':'main','head_sha':sha,'status':'completed','conclusion':'success','path':'.github/workflows/ci.yml','repository':{'full_name':m.release.REPOSITORY}}
receipt = {'format':1,'sourceSha':sha,'runId':123,'repository':m.release.REPOSITORY,'bundleSha256':bundle,'digest':digest}
assert m.validate(receipt,run,sha,'123',bundle) == digest
for target, changes in [('run', {'id':124,'event':'pull_request','head_branch':'other','head_sha':'d'*40,'status':'in_progress','conclusion':'failure','path':'.github/workflows/other.yml','repository':{'full_name':'EVNSolution/EVN-WARP'}}),('receipt',{'format':2,'sourceSha':'d'*40,'runId':124,'repository':'other','bundleSha256':'e'*64,'digest':'latest'})]:
    for key,value in changes.items():
        a,b=copy.deepcopy(receipt),copy.deepcopy(run)
        (b if target=='run' else a)[key]=value
        try: m.validate(a,b,sha,'123',bundle)
        except ValueError: pass
        else: raise AssertionError((target,key))
print('release receipt provenance checks passed')
