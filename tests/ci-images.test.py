"""Exercise concurrent failure handling and receipt promotion without Docker/AWS."""
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest

spec = importlib.util.spec_from_file_location('checks', Path(__file__).resolve().parents[1] / '.github/scripts/check_images.py')
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)


class Tests(unittest.TestCase):
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
