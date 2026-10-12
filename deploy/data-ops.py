#!/usr/bin/env python3
"""Maintenance-window backup and isolated restore. Never replaces the live volume."""
import argparse
from datetime import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import uuid

spec = importlib.util.spec_from_file_location('marketing_controller', Path(__file__).with_name('controller.py'))
controller = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controller)
Controller, ROOT, DIGEST = controller.Controller, controller.ROOT, controller.DIGEST
atomic, host_lock, require, Blocked = controller.atomic, controller.host_lock, controller.require, controller.Blocked


class DataOps(Controller):
    def aws(self, *args):
        return json.loads(self.command(['aws', 'ec2', *args, '--region', 'ap-northeast-2', '--output', 'json'], timeout=120))

    def volume(self):
        volume = json.loads(self.docker('volume', 'inspect', self.config['volume']))[0]
        require(volume['Driver'] == 'local' and not volume.get('Options'), 'volume_identity')
        return Path(volume['Mountpoint'])

    def encrypted_storage(self, directory, expected_volume=None, expected_snapshot=None):
        directory = Path(directory)
        require(directory.is_absolute() and directory.resolve() == directory and directory.is_dir(), 'storage_path')
        source = json.loads(self.command(['findmnt', '--json', '--target', str(directory), '--output', 'SOURCE']))['filesystems'][0]['source']
        require(re.fullmatch(r'/dev/[A-Za-z0-9/_-]+', source), 'storage_device')
        devices = json.loads(self.command(['lsblk', '--json', '--inverse', '--output', 'TYPE,SERIAL', source]))['blockdevices']
        def serials(items):
            result = []
            for item in items:
                if item.get('type') == 'disk':
                    result.append(str(item.get('serial', '')).replace('-', '').strip())
                result.extend(serials(item.get('children', [])))
            return result
        found = set(serials(devices))
        require(len(found) == 1, 'storage_device')
        serial = found.pop()
        require(re.fullmatch(r'vol[0-9a-f]+', serial), 'storage_device')
        volume_id = 'vol-' + serial[3:]
        require(expected_volume is None or volume_id == expected_volume, 'storage_volume')
        volumes = self.aws('describe-volumes', '--volume-ids', volume_id)['Volumes']
        require(len(volumes) == 1 and volumes[0]['Encrypted'] is True
                and (expected_snapshot is None or volumes[0].get('SnapshotId') == expected_snapshot), 'encrypted_storage_required')
        return volume_id

    def no_writers(self, allowed=()):
        ids = self.docker('ps', '-q').split()
        for identity in ids:
            item = self.inspect(identity)
            require(item['Name'].lstrip('/') in allowed or not any(m.get('Name') == self.config['volume'] and m.get('RW') for m in item['Mounts']), 'volume_writer_running')

    def quiesce(self, backup_id, operation='backup', keep_web=False):
        require(self.state['phase'] == 'stable' and not self.state.get('origin') and not self.state.get('candidate'), 'recovery_required')
        previous = self.state.get('previous')
        require(not previous or previous.get('drained'), 'compatibility_window')
        self.save(phase='maintenance', maintenance={'operation': operation, 'id': backup_id})
        self.stop_worker(self.state['active'])
        allowed = []
        for release in [self.state['active'], previous]:
            if release:
                if keep_web and self.running(self.web_name(release)):
                    self.identity(self.web_name(release), release)
                    allowed.append(self.web_name(release))
                elif not keep_web:
                    self.stop_web(release)
        self.no_writers(allowed)
        self.lease_clear(self.state['active'])

    def resume(self):
        require(self.state['phase'] == 'maintenance' and self.state.get('maintenance', {}).get('operation') in ('backup', 'receipt-recovery'), 'maintenance_required')
        allowed = []
        for release in [self.state['active'], self.state.get('previous')]:
            if release and self.running(self.web_name(release)):
                self.identity(self.web_name(release), release)
                allowed.append(self.web_name(release))
        if self.running('evn-marketing-worker'):
            self.identity('evn-marketing-worker', self.state['active'])
            allowed.append('evn-marketing-worker')
        else:
            self.lease_clear(self.state['active'], allow_expired=True)
        self.no_writers(allowed)
        self.check_schema(self.state['active'], self.state['active'])
        maintenance = self.state['maintenance']
        self.save(phase='stable', maintenance=None)
        try:
            self.recover()
        except BaseException:
            self.save(phase='maintenance', maintenance=maintenance)
            raise

    def data_command(self, arguments, mounts):
        result = self.docker('run', '--rm', '--network', 'none', '--user', '0', *mounts,
                            self.image(self.state['active']), 'node', 'data-backup.mjs', *arguments, timeout=900)
        value = json.loads(result)
        require(value.get('ok') is True, 'data_verification')
        return value

    def record_path(self, backup_id):
        require(str(uuid.UUID(backup_id)) == backup_id, 'backup_id')
        directory = self.root / 'state' / 'backups'
        directory.mkdir(mode=0o700, exist_ok=True)
        return directory / (backup_id + '.json')

    def backup(self, keep_web=False):
        self.encrypted_storage(self.volume(), self.config['ebsVolumeId'])
        backup_id = str(uuid.uuid4())
        record = self.record_path(backup_id)
        self.quiesce(backup_id, keep_web=keep_web)
        # Errors/crashes leave maintenance recorded. An explicit resume is required.
        self.docker('run', '--rm', '--network', 'none', '--user', '0', '-v', self.config['volume'] + ':/data',
                    self.image(self.state['active']), 'node', '-e',
                    "const f=require('fs');f.mkdirSync('/data/backups',{recursive:true,mode:0o700});if(!f.lstatSync('/data/backups').isDirectory()||f.realpathSync('/data/backups')!=='/data/backups')process.exit(1);f.chownSync('/data/backups',0,0);f.chmodSync('/data/backups',0o700)")
        bundle = '/data/backups/' + backup_id
        try:
            # SQLite backup plus before/copied/after row and upload hashes must agree.
            # Concurrent web writes reject the backup; they never alter live data.
            result = self.data_command(['snapshot', '/data', bundle], ['-v', self.config['volume'] + ':/data'])
        except BaseException:
            if keep_web:
                self.resume()
            raise
        pending = {'backupId': backup_id, 'revision': self.state['active']['revision'],
                   'digest': self.state['active']['digest'], 'manifestSha256': result['summarySha256'],
                   'volumeId': self.config['volumeId'], 'ebsVolumeId': self.config['ebsVolumeId']}
        atomic(record, json.dumps(pending))
        self.resume()  # Staging is now immutable; live writers may resume before snapshotting.
        snapshot = self.aws('create-snapshot', '--volume-id', self.config['ebsVolumeId'],
            '--description', 'EVN Marketing consistent staging backup', '--tag-specifications',
            json.dumps([{'ResourceType': 'snapshot', 'Tags': [{'Key': 'Service', 'Value': 'evn-marketing'},
                         {'Key': 'BackupId', 'Value': backup_id}]}]))
        require(re.fullmatch(r'snap-[0-9a-f]+', snapshot['SnapshotId']), 'snapshot_identity')
        pending.update(snapshotId=snapshot['SnapshotId'], createdAt=datetime.fromisoformat(snapshot['StartTime'].replace('Z', '+00:00')).timestamp())
        atomic(record, json.dumps(pending))
        return {'ok': True, 'backupId': backup_id, 'snapshotId': pending['snapshotId'], 'restoreVerified': False}

    def restore(self, bundle, summary_hash):
        bundle = Path(bundle)
        require(re.fullmatch(r'[0-9a-f]{64}', summary_hash), 'manifest_hash')
        require(bundle.is_absolute() and bundle.resolve() == bundle and ',' not in str(bundle) and ':' not in str(bundle), 'backup_path')
        self.encrypted_storage(self.volume(), self.config['ebsVolumeId'])
        mounts = ['-v', str(bundle) + ':/backup:ro']
        self.data_command(['verify', '/backup', summary_hash], mounts)
        target = 'evn-marketing-restore-' + str(uuid.uuid4())
        require(target not in self.docker('volume', 'ls', '--format', '{{.Name}}').splitlines(), 'restore_volume_exists')
        self.docker('volume', 'create', '--label', 'evn.marketing.restore=true', target)
        self.docker('run', '--rm', '--network', 'none', '--user', '0', '-v', target + ':/restore',
                    self.image(self.state['active']), 'node', '-e',
                    "const f=require('fs');if(f.readdirSync('/restore').length)process.exit(1);f.chmodSync('/restore',0o700)")
        result = self.data_command(['restore', '/backup', '/restore', summary_hash], mounts + ['-v', target + ':/restore'])
        owner = json.loads(self.docker('run', '--rm', '--network', 'none', self.image(self.state['active']),
                                      'node', '-e', 'console.log(JSON.stringify([process.getuid(),process.getgid()]))'))
        require(len(owner) == 2 and all(type(n) is int and n > 0 for n in owner), 'runtime_owner')
        self.docker('run', '--rm', '--network', 'none', '--user', '0', '-v', target + ':/restore',
                    self.image(self.state['active']), 'chown', '-R', f'{owner[0]}:{owner[1]}', '/restore')
        return {**result, 'restoreVolume': target, 'activated': False}

    def verify_snapshot_restore(self, backup_id, bundle):
        pending = json.loads(self.record_path(backup_id).read_text())
        require(pending['revision'] == self.state['active']['revision'] and pending['digest'] == self.state['active']['digest']
                and pending['ebsVolumeId'] == self.config['ebsVolumeId'] and pending['volumeId'] == self.config['volumeId'], 'backup_identity')
        snapshot = self.aws('describe-snapshots', '--snapshot-ids', pending['snapshotId'], '--owner-ids', 'self')['Snapshots']
        require(len(snapshot) == 1 and snapshot[0]['State'] == 'completed' and snapshot[0]['Encrypted'] is True
                and snapshot[0]['VolumeId'] == pending['ebsVolumeId'], 'snapshot_unavailable')
        start = datetime.fromisoformat(snapshot[0]['StartTime'].replace('Z', '+00:00')).timestamp()
        require(start == pending['createdAt'] and 0 <= self.now() - start <= 86400, 'backup_age')
        restored_ebs = self.encrypted_storage(Path(bundle), expected_snapshot=pending['snapshotId'])
        require(restored_ebs != self.config['ebsVolumeId'], 'separate_restore_required')
        result = self.restore(bundle, pending['manifestSha256'])
        evidence = {**pending, 'consistent': True, 'restoreVerifiedAt': self.now(),
                    'restoredEbsVolumeId': restored_ebs, 'restoreVolume': result['restoreVolume'],
                    'restoreSeconds': result['restoreSeconds']}
        atomic(self.root / 'state' / 'backup.json', json.dumps(evidence))
        return {**result, 'backupId': backup_id, 'restoreVerified': True}

    def migrate_check(self, target, ops_digest):
        require(re.fullmatch(r'evn-marketing-restore-[0-9a-f-]{36}', target) and DIGEST.fullmatch(ops_digest), 'ops_identity')
        volume = json.loads(self.docker('volume', 'inspect', target))[0]
        require(volume.get('Labels', {}).get('evn.marketing.restore') == 'true'
                and volume['Driver'] == 'local' and not volume.get('Options'), 'restore_volume_required')
        for identity in self.docker('ps', '-q').split():
            require(not any(m.get('Name') == target for m in self.inspect(identity)['Mounts']), 'restore_volume_busy')
        image = self.config['repository'] + '@' + ops_digest
        self.docker('pull', image, timeout=300)
        manifest = json.loads(self.docker('run', '--rm', '--network', 'none', '--entrypoint', 'cat', image, '/app/schema-manifest.json'))
        current = json.loads(self.docker('run', '--rm', '--network', 'none', '--entrypoint', 'cat', self.image(self.state['active']), '/app/schema-manifest.json'))
        require(manifest == current, 'ops_source_mismatch')
        mounts = ['-v', target + ':/data']
        before = self.data_command(['audit', '/data'], mounts)
        self.docker('run', '--rm', '--network', 'none', *mounts, '-e', 'DATABASE_URL=file:/data/marketing.db',
                    image, 'npx', '--no-install', 'prisma', 'migrate', 'deploy', timeout=900)
        after = self.data_command(['audit', '/data'], mounts)
        require(before == after, 'migration_changed_current_schema')
        return {'ok': True, 'opsDigest': ops_digest, 'restoreVolume': target, 'unchangedSchema': True, 'activated': False}

    def receipt_recovery(self, input_file, output=None, approval=None):
        source = Path(input_file)
        directory = source.parent
        require(source.is_absolute() and source.resolve() == source and source.is_file()
                and ',' not in str(directory) and ':' not in str(directory), 'recovery_path')
        self.encrypted_storage(directory, self.config['ebsVolumeId'])
        owner = int(self.docker('run', '--rm', '--network', 'none', self.image(self.state['active']), 'id', '-u'))
        require(owner > 0, 'runtime_owner')
        for item, mode in ((directory, 0o700), (source, 0o600)):
            info = item.lstat()
            require(info.st_uid == owner and info.st_mode & 0o7777 == mode
                    and (item == directory or info.st_nlink == 1), 'recovery_permissions')
        environment = {**os.environ, 'DATABASE_URL': 'file:/data/marketing.db'}
        args = ['run', '--rm', '--init', '--network', 'none' if output else self.config['network'],
                '-v', self.config['volume'] + ':/data', '-v', str(directory) + ':/recovery', '-e', 'DATABASE_URL']
        if output:
            destination = Path(output)
            require(destination.is_absolute() and destination.parent == directory and not destination.exists()
                    and destination.name not in ('.', '..') and not destination.is_symlink(), 'recovery_output')
            operation = ['plan', '/recovery/' + source.name, '/recovery/' + destination.name]
        else:
            require(approval and re.fullmatch(r'[0-9a-f]{64}', approval), 'recovery_approval')
            require(source.stat().st_size <= 32768 and hashlib.sha256(source.read_bytes()).hexdigest() == approval, 'recovery_approval')
            name = self.config['parameters']['WARP_MARKETING_API_KEY']
            require(name == '/evn-marketing/production/warp-api-key', 'secret_path')
            value = json.loads(self.command(['aws', 'ssm', 'get-parameter', '--region', 'ap-northeast-2',
                                            '--name', name, '--with-decryption', '--output', 'json']))['Parameter']
            require(value['Type'] == 'SecureString' and value['Name'] == name and value.get('Value'), 'secret_missing')
            environment['WARP_MARKETING_API_KEY'] = value['Value']
            args += ['-e', 'WARP_MARKETING_API_KEY']
            operation = ['apply', '/recovery/' + source.name, '--approve-sha256', approval]
            self.quiesce(str(uuid.uuid4()), 'receipt-recovery')
        result = json.loads(self.docker(*args, self.image(self.state['active']), 'node', 'warp-recovery.mjs',
                                       *operation, env=environment, timeout=900))
        require(result.get('status') == 'ok', 'receipt_recovery_failed')
        if not output:
            self.resume()
        return result


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='operation', required=True)
    backup_parser = sub.add_parser('backup')
    backup_parser.add_argument('--keep-web', action='store_true', help='Keep web serving; reject backup if data changes during copy')
    sub.add_parser('resume')
    restore_parser = sub.add_parser('restore')
    restore_parser.add_argument('--bundle', required=True)
    restore_parser.add_argument('--sha256', required=True)
    verify_parser = sub.add_parser('verify-snapshot-restore')
    verify_parser.add_argument('--backup-id', required=True)
    verify_parser.add_argument('--bundle', required=True)
    migrate_parser = sub.add_parser('migrate-check')
    migrate_parser.add_argument('--restore-volume', required=True)
    migrate_parser.add_argument('--ops-digest', required=True)
    plan_parser = sub.add_parser('recovery-plan')
    plan_parser.add_argument('--input', required=True)
    plan_parser.add_argument('--output', required=True)
    apply_parser = sub.add_parser('recovery-apply')
    apply_parser.add_argument('--plan', required=True)
    apply_parser.add_argument('--approve-sha256', required=True)
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    try:
        require(os.geteuid() == 0, 'host_administrator_required')
        for entry in (ROOT, ROOT / 'state', ROOT / 'config.json', ROOT / 'state' / 'release.json'):
            info = entry.lstat()
            require(not entry.is_symlink() and info.st_uid == 0 and not info.st_mode & 0o022, 'unsafe_host_permissions')
        with host_lock(ROOT):
            ops = DataOps()
            if args.operation == 'backup':
                result = ops.backup(keep_web=args.keep_web)
            elif args.operation == 'resume':
                ops.resume(); result = {'ok': True, 'resumed': True}
            elif args.operation == 'restore':
                result = ops.restore(args.bundle, args.sha256)
            elif args.operation == 'migrate-check':
                result = ops.migrate_check(args.restore_volume, args.ops_digest)
            elif args.operation == 'recovery-plan':
                result = ops.receipt_recovery(args.input, output=args.output)
            elif args.operation == 'recovery-apply':
                result = ops.receipt_recovery(args.plan, approval=args.approve_sha256)
            else:
                result = ops.verify_snapshot_restore(args.backup_id, args.bundle)
        print(json.dumps(result))
        return 0
    except BaseException as error:
        print(json.dumps({'ok': False, 'reason': str(error) if isinstance(error, Blocked) else 'data_operation_failed'}))
        return 75 if isinstance(error, Blocked) and str(error) == 'host_busy' else 1


if __name__ == '__main__':
    raise SystemExit(main())
