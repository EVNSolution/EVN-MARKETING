"""One pinned, rehearsed expansion. Never restores or edits a migration ledger."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import uuid

spec = importlib.util.spec_from_file_location('landing_data_ops', Path(__file__).with_name('data-ops.py'))
data_ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(data_ops)
DataOps = data_ops.DataOps
require, Blocked = data_ops.require, data_ops.Blocked
ROOT, atomic, host_lock = data_ops.ROOT, data_ops.atomic, data_ops.host_lock
BASELINE = 'be0bbaab3f91511d72fca7dd533179bbf9e54d25bd9ce8c215ce128db9e23ae6'
EXPANDED = 'ce708b8e46cf000c4058ca7163ab54a2bde00b3fa675d950961463ee514bca26'


def digest(value):
    return hashlib.sha256(value).hexdigest()


def contract(manifest):
    fields = {key: manifest[key] for key in ('prismaSchemaSha256', 'migrations', 'schema')}
    return digest(json.dumps(fields, ensure_ascii=False, separators=(',', ':')).encode())


def preserved(before, after):
    require(before.get('format') == after.get('format') == 1
            and before.get('ok') is True and after.get('ok') is True
            and before.get('contractSha256') == BASELINE and after.get('contractSha256') == EXPANDED
            and after.get('addedRows') == [0, 0], 'expansion_contract')
    for key in ('rows', 'hashes', 'files', 'uploadBytes', 'filesSha256'):
        require(key in before and key in after and before[key] == after[key], 'existing_data_changed')


class LandingExpand(DataOps):
    def manifest(self, release):
        require(re.fullmatch(r'[0-9a-f]{40}', release['revision'])
                and data_ops.DIGEST.fullmatch(release['digest']), 'image_identity')
        self.docker('pull', self.image(release), timeout=300)
        self.image_identity(release)
        result = json.loads(self.docker('run', '--rm', '--network', 'none', '--entrypoint', 'cat',
                                       self.image(release), '/app/schema-manifest.json'))
        require(result.get('revision') == release['revision'], 'manifest_identity')
        return result

    def targets(self, candidate, operations):
        require(candidate['revision'] == operations['revision'], 'ops_source_mismatch')
        active = self.manifest(self.state['active'])
        current = self.manifest(candidate)
        ops = self.manifest(operations)
        require(current == ops and contract(active) == BASELINE and contract(current) == EXPANDED,
                'pinned_expansion_required')
        require(all(m.get('schemaCompatibility', {}).get('landingExpansion') == EXPANDED
                    for m in (active, current, ops)), 'bridge_required')
        require(self.config.get('landingIntakeEnabled', False) is False, 'intake_must_be_disabled')

    def config_hash(self):
        return digest((self.root / 'config.json').read_bytes())

    def backup_evidence(self):
        self.preflight(self.state['active'], self.state['active'])
        self.encrypted_storage(self.volume(), self.config['ebsVolumeId'])
        evidence = json.loads((self.root / 'state' / 'backup.json').read_text())
        require(evidence.get('revision') == self.state['active']['revision']
                and evidence.get('digest') == self.state['active']['digest'], 'backup_source_mismatch')
        return evidence

    def unused_restore(self, volume, evidence):
        require(volume == evidence.get('restoreVolume')
                and re.fullmatch(r'evn-marketing-restore-[0-9a-f-]{36}', volume), 'restore_volume_required')
        info = json.loads(self.docker('volume', 'inspect', volume))[0]
        require(info.get('Labels', {}).get('evn.marketing.restore') == 'true'
                and info['Driver'] == 'local' and not info.get('Options'), 'restore_volume_required')
        for identity in self.docker('ps', '-q').split():
            require(not any(m.get('Name') == volume for m in self.inspect(identity)['Mounts']), 'restore_volume_busy')

    def audit(self, candidate, volume, expected):
        result = json.loads(self.docker('run', '--rm', '--network', 'none', '-v', volume + ':/data',
            self.image(candidate), 'node', 'landing-expansion-audit.mjs', expected, '/data', timeout=900))
        require(result.get('ok') is True and result.get('format') == 1
                and result.get('contractSha256') == {'baseline': BASELINE, 'expanded': EXPANDED}[expected],
                'expansion_audit')
        return result

    def migrate(self, operations, volume):
        self.docker('run', '--rm', '--network', 'none', '-v', volume + ':/data',
                    '-e', 'DATABASE_URL=file:/data/marketing.db', self.image(operations),
                    'npx', '--no-install', 'prisma', 'migrate', 'deploy', timeout=900)

    def plan_path(self):
        return self.root / 'state' / 'landing-expand-plan.json'

    def rehearse(self, revision, runtime_digest, ops_digest):
        require(self.state['phase'] == 'stable' and not self.state.get('origin')
                and not self.state.get('candidate'), 'recovery_required')
        candidate = {'revision': revision, 'digest': runtime_digest}
        operations = {'revision': revision, 'digest': ops_digest}
        self.targets(candidate, operations)
        evidence = self.backup_evidence()
        volume = evidence['restoreVolume']
        self.unused_restore(volume, evidence)
        before = self.audit(candidate, volume, 'baseline')
        self.migrate(operations, volume)
        after = self.audit(candidate, volume, 'expanded')
        preserved(before, after)
        plan = {'format': 1, 'active': self.state['active'], 'candidate': candidate, 'operations': operations,
                'configSha256': self.config_hash(), 'verifiedAt': self.now(), 'restoreVolume': volume,
                'backupId': evidence['backupId'], 'snapshotId': evidence['snapshotId'],
                'backupManifestSha256': evidence['manifestSha256'], 'existingDataPreserved': True}
        text = json.dumps(plan, sort_keys=True) + '\n'
        atomic(self.plan_path(), text)
        return {'ok': True, 'rehearsed': True, 'liveChanged': False, 'planSha256': digest(text.encode())}

    def approved_plan(self, approval):
        file = self.plan_path()
        info = file.lstat()
        require(not file.is_symlink() and info.st_nlink == 1 and info.st_uid == 0
                and info.st_mode & 0o7777 == 0o600 and info.st_size <= 32768, 'plan_permissions')
        text = file.read_bytes()
        require(re.fullmatch(r'[0-9a-f]{64}', approval) and digest(text) == approval, 'plan_approval')
        plan = json.loads(text)
        require(plan.get('format') == 1 and plan.get('existingDataPreserved') is True
                and plan['active'] == self.state['active'] and plan['configSha256'] == self.config_hash()
                and 0 <= self.now() - plan['verifiedAt'] <= 86400, 'stale_plan')
        self.targets(plan['candidate'], plan['operations'])
        evidence = self.backup_evidence()
        for key, other in (('backupId', 'backupId'), ('snapshotId', 'snapshotId'),
                           ('backupManifestSha256', 'manifestSha256'), ('restoreVolume', 'restoreVolume')):
            require(plan[key] == evidence[other], 'backup_changed')
        return plan

    def storage_contract(self):
        result = json.loads(self.docker('run', '--rm', '--network', 'none',
            '-v', self.config['volume'] + ':/data', '-e', 'DATABASE_URL=file:/data/marketing.db',
            self.image(self.state['active']), 'node', 'schema-check.mjs', 'check',
            'schema-manifest.json', 'schema-manifest.json'))
        require(result.get('ok') is True, 'schema')
        return result.get('storageContractSha256')

    def apply(self, approval):
        require(self.state['phase'] == 'stable', 'recovery_required')
        plan = self.approved_plan(approval)  # Approval/source/backup checks precede every stop or write.
        operation_id = str(uuid.uuid4())
        self.quiesce(operation_id, 'landing-expand')
        maintenance = {'operation': 'landing-expand', 'id': operation_id, 'stage': 'stopped',
                       'planSha256': approval, 'plan': plan}
        self.save(maintenance=maintenance)
        before = self.audit(plan['candidate'], self.config['volume'], 'baseline')
        # Final coherent copy includes writes made since the verified EBS backup.
        # Existing data-ops backup evidence guarantees this directory already exists.
        bundle = '/data/backups/landing-' + operation_id
        snapshot = self.data_command(['snapshot', '/data', bundle], ['-v', self.config['volume'] + ':/data'])
        maintenance = {**maintenance, 'stage': 'migrating', 'before': before,
                       'offlineBackup': bundle, 'offlineBackupSha256': snapshot['summarySha256']}
        self.save(maintenance=maintenance)
        self.migrate(plan['operations'], self.config['volume'])
        after = self.audit(plan['candidate'], self.config['volume'], 'expanded')
        preserved(before, after)
        self.save(maintenance={**maintenance, 'stage': 'expanded-verified'})
        self.resume_landing()
        return {'ok': True, 'expanded': True, 'existingDataPreserved': True,
                'bridgeResumed': True, 'intakeEnabled': False}

    def resume_landing(self):
        maintenance = self.state.get('maintenance') or {}
        require(self.state['phase'] == 'maintenance' and maintenance.get('operation') == 'landing-expand',
                'landing_maintenance_required')
        if maintenance.get('plan'):
            require(maintenance['plan']['configSha256'] == self.config_hash(), 'configuration_changed')
        require(self.config.get('landingIntakeEnabled', False) is False, 'intake_must_be_disabled')
        stage = maintenance.get('stage')
        storage = self.storage_contract()  # Partial DDL/ledger states fail here; no repair/restore is attempted.
        if stage in (None, 'stopped'):
            require(storage == BASELINE, 'unexpected_expansion')
        elif stage == 'migrating':
            self.no_writers()
            plan = maintenance['plan']
            require(plan['active'] == self.state['active'], 'active_changed')
            if storage == EXPANDED:
                preserved(maintenance['before'], self.audit(plan['candidate'], self.config['volume'], 'expanded'))
                maintenance = {**maintenance, 'stage': 'expanded-verified'}
                self.save(maintenance=maintenance)
            else:
                require(storage == BASELINE and self.audit(plan['candidate'], self.config['volume'], 'baseline')
                        == maintenance['before'], 'existing_data_changed')
        else:
            require(stage == 'expanded-verified' and storage == EXPANDED
                    and maintenance['plan']['active'] == self.state['active'], 'unverified_expansion')
        allowed = []
        for release in (self.state['active'], self.state.get('previous')):
            if release and self.running(self.web_name(release)):
                self.identity(self.web_name(release), release)
                allowed.append(self.web_name(release))
        if self.running('evn-marketing-worker'):
            self.identity('evn-marketing-worker', self.state['active'])
            allowed.append('evn-marketing-worker')
        else:
            self.lease_clear(self.state['active'], allow_expired=True)
        self.no_writers(allowed)
        self.save(phase='stable', maintenance=None)
        try:
            self.recover()
        except BaseException:
            self.save(phase='maintenance', maintenance=maintenance)
            raise


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest='operation', required=True)
    rehearsal = commands.add_parser('rehearse')
    rehearsal.add_argument('--revision', required=True)
    rehearsal.add_argument('--runtime-digest', required=True)
    rehearsal.add_argument('--ops-digest', required=True)
    apply = commands.add_parser('apply')
    apply.add_argument('--approve-sha256', required=True)
    commands.add_parser('resume')
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    try:
        require(os.geteuid() == 0, 'host_administrator_required')
        entries = [ROOT, ROOT / 'state', ROOT / 'deploy', ROOT / 'config.json', ROOT / 'state/release.json',
                   ROOT / 'deploy/controller.py', ROOT / 'deploy/data-ops.py', ROOT / 'deploy/landing-expand.py']
        paths = set(entries)
        for entry in entries:
            paths.update(entry.parents)
        for entry in paths:
            info = entry.lstat()
            require(not entry.is_symlink() and info.st_uid == 0 and not info.st_mode & 0o022, 'unsafe_host_permissions')
        with host_lock(ROOT):
            ops = LandingExpand()
            if args.operation == 'rehearse':
                result = ops.rehearse(args.revision, args.runtime_digest, args.ops_digest)
            elif args.operation == 'apply':
                result = ops.apply(args.approve_sha256)
            else:
                ops.resume_landing()
                result = {'ok': True, 'resumed': True}
        print(json.dumps(result))
        return 0
    except BaseException as error:
        print(json.dumps({'ok': False, 'reason': str(error) if isinstance(error, Blocked) else 'landing_expansion_failed'}))
        return 75 if isinstance(error, Blocked) and str(error) == 'host_busy' else 1


if __name__ == '__main__':
    raise SystemExit(main())
