"""Exercise concurrent failure handling and receipt promotion without Docker/AWS."""
import importlib.util
import copy
import json
from pathlib import Path
import tempfile
import threading
import unittest

spec = importlib.util.spec_from_file_location('checks', Path(__file__).resolve().parents[1] / '.github/scripts/check_images.py')
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)
spec = importlib.util.spec_from_file_location('gate', Path(__file__).resolve().parents[1] / '.github/scripts/require_checks.py')
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class Tests(unittest.TestCase):
    def test_missing_suite_or_partial_recovery_evidence_is_rejected(self):
        a = {'sourceSha':'a'*40, 'suite':'transitions', 'ok':True, 'traffic':{'errors':0,'reads':2},
             'publicErrors':0, 'heldUploadDrains':2, 'controllerPublicProbes':20, 'mode':'real-clock', 'releaseSequence':['a','b','c','b','a'],
             'activationChecks':[{'revision':c*40,'publicChecks':5,'workerHeartbeatAdvanced':True,'seconds':8.5} for c in ('b','c','b','a')],
             'preflightRejections':['release:'+name for name in ('unreadable_renderer','missing_renderer','invalid_renderer','invalid_nginx')]
                                   + ['rollback:unreadable_renderer']}
        b = {'sourceSha':'a'*40, 'suite':'recovery', 'ok':True, 'traffic':{'errors':0,'reads':2},
             'recovery':{'ok':True, 'recoveryScenarios':8, 'recoveryRecordsAdded':8, 'finalPhase':'stable',
                         'scenarios':['death_'+p for p in ('preparing','draining','switching','starting','observing')]
                         + ['host_flock','stopped_containers_and_proxy','killed_worker_natural_lease_expiry']}}
        gate.validate_reports(a,b,'a'*40)
        for field, value in [('sourceSha','b'*40),('suite','full'),('ok',False),('publicErrors',1),
                             ('heldUploadDrains',1),('controllerPublicProbes',19),('traffic',{'errors':1,'reads':2}),
                             ('mode','accelerated'),('releaseSequence',['a','b','a']),('activationChecks',[]),
                             ('preflightRejections',[]),('preflightRejections',a['preflightRejections'][:-1])]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                gate.validate_reports({**a,field:value},b,'a'*40)
        for field, value in [('revision','a'*40),('publicChecks',4),('workerHeartbeatAdvanced',False),('seconds',7.9),('seconds',90)]:
            changed = copy.deepcopy(a); changed['activationChecks'][0][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                gate.validate_reports(changed,b,'a'*40)
        for field, value in [('recoveryScenarios',7),('recoveryRecordsAdded',7),('finalPhase','blocked'),('scenarios',[])]:
            changed = copy.deepcopy(b); changed['recovery'][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                gate.validate_reports(a,changed,'a'*40)

    def test_global_gate_requires_all_jobs_and_only_expected_skips(self):
        for required, status in [('true', 'success'), ('false', 'skipped')]:
            args = ['success', 'success', 'success', required, status]
            gate.require_checks(*args)
            for index in range(3):
                for result in ['failure', 'cancelled', 'skipped', None]:
                    with self.subTest(index=index, result=result), self.assertRaises(ValueError):
                        bad = args.copy(); bad[index] = result
                        gate.require_checks(*bad)
        for required, status in [('true', 'skipped'), ('true', 'failure'), ('true', 'cancelled'),
                                 ('false', 'success'), ('false', 'failure'), ('', 'skipped'), (None, None)]:
            with self.subTest(required=required, status=status), self.assertRaises(ValueError):
                gate.require_checks('success', 'success', 'success', required, status)

    def test_only_complete_boolean_selection_is_accepted(self):
        self.assertTrue(checks.selected('true'))
        self.assertFalse(checks.selected('false'))
        for value in (None, '', 'False', 'skip', True):
            with self.subTest(value=value), self.assertRaises(ValueError):
                checks.selected(value)

    def test_publish_waits_for_every_check_and_failure_removes_stale_receipt(self):
        for failed in (False, True):
            with self.subTest(failed=failed), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                pending, receipt, report = (root / x for x in ('pending', 'receipt', 'report'))
                receipt.write_text('stale receipt')
                pending.write_text('stale pending')
                ready = threading.Event()

                def registry():
                    self.assertFalse(receipt.exists())
                    self.assertFalse(pending.exists())
                    pending.write_text('new exact image receipt')
                    ready.set()

                def test():
                    self.assertTrue(ready.wait(2), 'tasks must run concurrently')
                    self.assertTrue(pending.exists())
                    self.assertFalse(receipt.exists(), 'test still running; receipt cannot be promoted')
                    if failed:
                        raise RuntimeError('synthetic required check failure')

                tasks = {'smoke': test, 'registry': registry}
                if failed:
                    with self.assertRaises(RuntimeError):
                        checks.run_checks(tasks, pending, receipt, report)
                    self.assertFalse(receipt.exists())
                else:
                    checks.run_checks(tasks, pending, receipt, report)
                    self.assertEqual(receipt.read_text(), 'new exact image receipt')
                self.assertFalse(pending.exists())
                result = json.loads(report.read_text())
                self.assertEqual(result['ok'], not failed)
                self.assertEqual({item['stage'] for item in result['stages']}, set(tasks))


if __name__ == '__main__':
    unittest.main()
