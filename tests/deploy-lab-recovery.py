"""Bounded recovery acceptance for the already provisioned, synthetic Docker lab.

Call run_recovery(Lab, root, releases) with the continuous availability observer
stopped: these scenarios deliberately interrupt service. No host reboot, Docker
daemon restart, SSM disconnect, real source login, or real delivery is tested.
"""
import json
import multiprocessing
import os
from pathlib import Path
import signal
import time
import uuid


PHASES = ('preparing', 'draining', 'switching', 'starting', 'observing')
CRASH_EXIT = 86
CTX = multiprocessing.get_context('fork')


def _check(condition, reason):
    if not condition:
        raise AssertionError(reason)


def _entry(action):
    # A timeout must also stop any outstanding Docker CLI subprocesses.
    os.setsid()
    signal.signal(signal.SIGTERM, signal.SIG_DFL)
    try:
        action()
    except BaseException as error:
        # Never print exception arguments, subprocess output, environment or rows.
        print(json.dumps({'ok': False, 'recoveryChildError': type(error).__name__}), flush=True)
        os._exit(1)


def _reap(child):
    try:
        # The group may outlive its leader if a command was still in flight.
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    if child.is_alive():
        child.kill()
    child.join(timeout=5)
    _check(not child.is_alive(), 'recovery_child_did_not_exit')
    child.close()


def _run(action, label, timeout=300, expected=0):
    child = CTX.Process(target=_entry, args=(action,))
    child.start()
    try:
        child.join(timeout=timeout)
        _check(child.exitcode == expected, label + ': unexpected child exit or timeout')
    finally:
        _reap(child)


DATA_SCRIPT = r"""
const fs = require('fs'), crypto = require('crypto'), D = require('better-sqlite3');
const input = JSON.parse(process.argv[1]);
const db = new D('/data/marketing.db', {fileMustExist:true, readonly:!input.write});
db.pragma('busy_timeout = 5000');
const path = id => '/data/uploads/customers/' + id + '/recovery.txt';
if (input.write) {
  const id = input.write, at = new Date().toISOString();
  fs.mkdirSync('/data/uploads/customers/' + id, {recursive:true});
  const content = Buffer.from('synthetic recovery write ' + id);
  const fd = fs.openSync(path(id), 'wx');
  try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  db.transaction(() => {
    db.prepare('INSERT INTO Customer (id,name,memo,documentsJson,updatedAt) VALUES (?,?,?,?,?)')
      .run(id,'Synthetic recovery customer',id,JSON.stringify([{path:'customers/'+id+'/recovery.txt',size:content.length}]),at);
    db.prepare('INSERT INTO Inquiry (id,source,companyScopeId,homepageScopeId,sourceId,inquiryDate,inquiryTime,phone,lastSeenAt,warpCustomerId,warpActivityId,warpDeliveredAt,warpAttemptedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id,'synthetic-recovery','synthetic-company','synthetic-homepage',id,at.slice(0,10),'00:00','synthetic',at,id,'synthetic-activity-'+id,at,at);
  })();
}
if (db.pragma('integrity_check', {simple:true}) !== 'ok') process.exit(2);
const customers = db.prepare('SELECT * FROM Customer ORDER BY id').all();
const inquiries = db.prepare('SELECT * FROM Inquiry ORDER BY id').all();
const activities = db.prepare('SELECT * FROM CustomerActivity ORDER BY id').all();
const users = db.prepare('SELECT count(*) n FROM User').get().n;
for (const id of input.ids) {
  const customer = customers.find(row=>row.id===id);
  const receipt = inquiries.find(row=>row.id===id);
  if (!customer || !receipt || !receipt.warpDeliveredAt || !receipt.warpActivityId) process.exit(3);
  if (!fs.existsSync(path(id))) process.exit(4);
}
if (customers.find(row=>row.id==='synthetic-parallel')?.memo !== 'synthetic worker committed after activation') process.exit(5);
for (const id of ['synthetic-load-0','synthetic-load-1','synthetic-held']) {
  const docs = JSON.parse(customers.find(row=>row.id===id)?.documentsJson || '[]');
  if (!docs.length || docs.some(doc=>!doc.path.startsWith('/api/uploads/') ||
      !fs.existsSync('/data/uploads/' + doc.path.slice('/api/uploads/'.length)))) process.exit(6);
}
const uploads = [];
function walk(directory) {
  for (const name of fs.readdirSync(directory).sort()) {
    const file = directory + '/' + name, stat = fs.lstatSync(file);
    if (stat.isDirectory()) walk(file);
    else if (stat.isFile()) uploads.push([file.slice('/data/uploads/'.length),
      crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]);
    else process.exit(7);
  }
}
walk('/data/uploads');
db.close();
console.log(JSON.stringify({sha256:crypto.createHash('sha256')
  .update(JSON.stringify({customers,inquiries,activities,uploads,users})).digest('hex'),
  customers:customers.length,uploads:uploads.length,receipts:inquiries.filter(row=>row.warpDeliveredAt).length}));
"""

LEASE_SCRIPT = r"""
const D = require('better-sqlite3');
const db = new D('/data/marketing.db', {readonly:true,fileMustExist:true});
const rows = db.prepare('SELECT id,workerOwner,workerHeartbeatAt,workerLeaseExpiresAt,lockOwner,lockExpiresAt FROM InquirySyncState ORDER BY id').all();
db.close();
console.log(JSON.stringify({rows,remainingMs:Math.max(0,...rows.filter(r=>r.workerOwner).map(r=>Date.parse(r.workerLeaseExpiresAt)-Date.now()))}));
"""


def _node(controller, script, *args):
    return json.loads(controller.docker('exec', controller.web_name(controller.state['active']),
                                        'node', '-e', script, *args))


def _runtime(controller):
    # Compare process identities without exposing Config.Env (which contains secrets).
    names = ('evn-marketing-worker', 'evn-marketing-web-blue',
             'evn-marketing-web-green', 'evn-marketing-proxy')
    present = controller.docker('ps', '-a', '--format', '{{.Names}}').splitlines()
    result = {}
    for name in names:
        if name in present:
            item = controller.inspect(name)
            result[name] = (item['Id'], item['State']['Running'],
                            item['State']['StartedAt'], item['State']['FinishedAt'])
    return result


def run_recovery(controller_class, root, releases):
    """Return/print only scenario counts; leave a fresh, stable known release.

    Lab keeps its accelerated observation clock, but startup/drain/lease waiting
    must use real delays. Call outside host_lock: each coordinator takes its own
    lock, and the parent never forks while holding that lock.
    """
    root = Path(root).resolve()
    _check(os.environ.get('GITHUB_ACTIONS') == 'true'
           and root.name.startswith('marketing-controller-lab-'), 'synthetic_ci_lab_required')
    _check(len(releases) == 2 and {r['revision'] for r in releases} == {'a' * 40, 'b' * 40},
           'synthetic_releases_required')
    # importlib's lab loader need not register its module in sys.modules.
    namespace = controller_class.recover.__globals__
    host_lock, Blocked = namespace['host_lock'], namespace['Blocked']
    initial = controller_class(root)
    _check(initial.config['repository'] == '127.0.0.1:5000/evn-marketing'
           and initial.config['volumeId'] == 'synthetic-compat-volume'
           and initial.config['publicUrl'] == 'https://localhost:3443'
           and initial.config['collectorEnabled'] and not initial.config['warpDeliveryEnabled']
           and (root / 'fixture' / 'worker.mjs').is_file(), 'synthetic_runtime_required')
    network = json.loads(initial.docker('network', 'inspect', initial.config['network']))[0]
    _check(network['Internal'], 'isolated_network_required')
    origin = initial.state['active'].copy()
    _check(any(all(origin[k] == r[k] for k in ('revision', 'digest', 'slot')) for r in releases),
           'known_active_required')
    target = next(r for r in releases if r['revision'] != origin['revision'])
    records, completed = [], []
    prefix = 'synthetic-recovery-' + uuid.uuid4().hex + '-'
    expected_data = None

    def data(controller, write=None):
        return _node(controller, DATA_SCRIPT, json.dumps({'ids': records, 'write': write}))

    def latest(controller, label):
        nonlocal expected_data
        if expected_data is not None:
            _check(data(controller) == expected_data, label + ': earlier data changed')
        records.append(prefix + label)
        expected_data = data(controller, write=records[-1])

    def stable():
        controller = controller_class(root)  # Always reload the durable journal.
        state = controller.state
        _check(state['phase'] == 'stable' and state['active'] == origin
               and not state.get('origin') and not state.get('candidate'), 'origin_not_restored')
        controller.healthy_web(origin, public=True)
        controller.worker_ready(origin)
        _check(controller.gate(origin).read_text() == 'active\n', 'worker_not_activated')
        leases = _node(controller, LEASE_SCRIPT)
        _check([r['workerOwner'] for r in leases['rows'] if r['workerOwner']] == [origin['owner']],
               'worker_owner_not_restored')
        if expected_data is not None:
            _check(data(controller) == expected_data, 'latest_data_not_preserved')
        return controller

    def recover():
        with host_lock(root):
            controller_class(root).recover()

    def done(label):
        stable()
        completed.append(label)
        print(json.dumps({'recoveryScenario': label, 'ok': True}), flush=True)

    try:
        expected_data = data(stable())
        for phase in PHASES:
            class Crash(controller_class):
                def save(self, **changes):
                    super().save(**changes)
                    if changes.get('phase') == phase:
                        # os._exit skips exception rollback, finally and atexit.
                        os._exit(CRASH_EXIT)

            def crash():
                with host_lock(root):
                    Crash(root).release(target['revision'], target['digest'])

            _run(crash, 'death_' + phase, expected=CRASH_EXIT)
            interrupted = controller_class(root)
            state = interrupted.state
            _check(state['phase'] == phase and state['active'] == origin
                   and state['origin'] == origin and state['candidate']['digest'] == target['digest'],
                   'durable_crash_phase_not_observed')
            switched = phase in ('starting', 'observing')
            interrupted.probe(state['candidate'] if switched else origin, public=True)
            if phase in ('preparing', 'draining', 'observing'):
                interrupted.worker_ready(state['candidate'] if phase == 'observing' else origin)
            else:
                _check(not interrupted.running('evn-marketing-worker'), 'drained_worker_still_running')
            # Write AFTER the controller died; replaying an old volume cannot pass.
            latest(interrupted, phase)
            _run(recover, 'recover_' + phase, timeout=420)
            _check(not controller_class(root).running('evn-marketing-web-' + state['candidate']['slot']),
                   'candidate_not_discarded')
            done('death_' + phase)

        controller = stable()
        latest(controller, 'flock')
        before = (controller.state_file.read_bytes(), (root / 'nginx/nginx.conf').read_bytes(),
                  _runtime(controller))
        locked, release_lock = CTX.Event(), CTX.Event()

        def holder():
            with host_lock(root):
                locked.set()
                _check(release_lock.wait(180), 'lock_holder_timeout')

        def contender():
            try:
                with host_lock(root):
                    # A broken lock would run a real competing coordinator.
                    controller_class(root).release(target['revision'], target['digest'])
            except Blocked as error:
                if str(error) == 'host_busy':
                    os._exit(75)
                raise

        child = CTX.Process(target=_entry, args=(holder,))
        child.start()
        try:
            _check(locked.wait(10), 'lock_holder_not_ready')
            _run(contender, 'competing_coordinator', timeout=30, expected=75)
            _check(before == (controller.state_file.read_bytes(), (root / 'nginx/nginx.conf').read_bytes(),
                              _runtime(controller)), 'competing_coordinator_mutated_runtime')
        finally:
            release_lock.set()
            try:
                child.join(timeout=10)
                _check(child.exitcode == 0, 'lock_holder_failed')
            finally:
                _reap(child)
        _run(recover, 'lock_released_recovery', timeout=420)
        done('host_flock')

        controller = stable()
        latest(controller, 'stopped')
        proxy_id = controller.inspect('evn-marketing-proxy')['Id']
        with host_lock(root):
            controller.stop_worker(origin)
            for release in releases:
                controller.stop_web(release)
            controller.docker('stop', '--time', '10', 'evn-marketing-proxy', timeout=30)
        _check(not any(controller.running(name) for name in (
            'evn-marketing-worker', 'evn-marketing-web-blue', 'evn-marketing-web-green',
            'evn-marketing-proxy')), 'runtime_not_stopped')
        _run(recover, 'stopped_runtime_recovery', timeout=420)
        _check(controller_class(root).inspect('evn-marketing-proxy')['Id'] == proxy_id,
               'proxy_unexpectedly_replaced')
        _check(not controller_class(root).running('evn-marketing-web-' + target['slot']),
               'inactive_release_started')
        done('stopped_containers_and_proxy')

        controller = stable()
        latest(controller, 'stale')
        with host_lock(root):
            controller.identity('evn-marketing-worker', origin)
            controller.docker('kill', '--signal=KILL', 'evn-marketing-worker')
            controller.docker('wait', 'evn-marketing-worker', timeout=10)
        dead = controller.inspect('evn-marketing-worker')['State']
        _check(not dead['Running'] and dead['ExitCode'] != 0 and not dead['OOMKilled'],
               'worker_process_death_not_observed')
        stale = _node(controller, LEASE_SCRIPT)
        _check(0 < stale['remainingMs'] <= 180000
               and [r['workerOwner'] for r in stale['rows'] if r['workerOwner']] == [origin['owner']],
               'real_unexpired_lease_required')
        started = CTX.Event()

        class LeaseChecked(controller_class):
            def start(self, release, worker=False):
                if worker:
                    actual = _node(self, LEASE_SCRIPT)
                    _check(actual['rows'] == stale['rows'] and actual['remainingMs'] == 0,
                           'lease_was_cleared_or_worker_started_before_expiry')
                    _check(not self.running('evn-marketing-worker'), 'old_worker_still_running')
                    started.set()
                return super().start(release, worker)

        def recover_stale():
            with host_lock(root):
                LeaseChecked(root).recover()

        began = time.monotonic()
        _run(recover_stale, 'natural_lease_expiry', timeout=420)
        lease_seconds = time.monotonic() - began
        _check(started.is_set(), 'lease_start_guard_not_exercised')
        done('killed_worker_natural_lease_expiry')
    except BaseException:
        # Recovery is bounded even on failure; the caller owns container/volume teardown.
        try:
            _run(recover, 'failure_cleanup', timeout=420)
            stable()
        except BaseException:
            print(json.dumps({'ok': False, 'recoveryCleanup': 'unverified'}), flush=True)
        raise

    summary = {'ok': True, 'recoveryScenarios': len(completed), 'phases': list(PHASES),
               'scenarios': completed, 'controllerProcessDeaths': len(PHASES),
               'hostLockContentions': 1, 'stoppedRuntimeRecoveries': 1, 'naturalLeaseExpiryRecoveries': 1,
               'leaseRecoverySeconds': round(lease_seconds, 1),
               'preserved': {key: expected_data[key] for key in ('customers', 'uploads', 'receipts')},
               'recoveryRecordsAdded': len(records), 'finalPhase': 'stable',
               'hostReboot': False, 'ssmDisconnect': False,
               'unverified': ['host_os_reboot', 'ssm_disconnect']}
    print(json.dumps(summary, sort_keys=True), flush=True)
    return summary


def _self_check():
    """Local process/timeout/real-flock check; deliberately no Docker claim."""
    import importlib.util
    import tempfile

    spec = importlib.util.spec_from_file_location('recovery_controller', Path(__file__).resolve().parents[1] / 'deploy/controller.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with tempfile.TemporaryDirectory(prefix='marketing-recovery-self-check-') as directory:
        root = Path(directory)
        (root / 'state').mkdir()

        def crash():
            with module.host_lock(root):
                module.atomic(root / 'state/release.json', '{"phase":"switching"}\n')
                os._exit(CRASH_EXIT)

        _run(crash, 'local_durable_death', timeout=5, expected=CRASH_EXIT)
        _check(json.loads((root / 'state/release.json').read_text())['phase'] == 'switching', 'journal_not_saved')
        with module.host_lock(root):
            pass  # The dead child released its real flock.
        before = {p.pid for p in multiprocessing.active_children()}
        try:
            _run(lambda: time.sleep(10), 'local_timeout', timeout=0.1)
        except AssertionError:
            pass
        else:
            raise AssertionError('timeout_not_enforced')
        _check({p.pid for p in multiprocessing.active_children()} == before, 'unjoined_children')
    print(json.dumps({'ok': True, 'localProcessChecks': 3, 'dockerRun': False}))


if __name__ == '__main__':
    import sys
    _check(sys.argv[1:] == ['--self-test'], 'use --self-test locally; Docker lab imports run_recovery')
    _self_check()
