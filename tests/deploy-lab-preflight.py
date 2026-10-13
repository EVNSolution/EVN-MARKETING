"""Real container permission faults in the isolated CI lab, never on a production host."""
import json
import os


def run_preflight(controller, root, candidate, *, rollback=False):
    assert os.environ.get('GITHUB_ACTIONS') == 'true'
    renderer = root / 'deploy/nginx-config.mjs'
    original, metadata = renderer.read_text(), renderer.stat()
    active = controller.state['active']
    assert controller.docker('run', '--rm', '--network', 'none', controller.image(candidate), 'id', '-u').strip() != '0'

    def fixture(content, mode=metadata.st_mode & 0o777, uid=metadata.st_uid, gid=metadata.st_gid):
        # Root only creates the synthetic fault. The real controller uses the image's runtime user.
        script = "const f=require('fs'),p='/fixture/nginx-config.mjs';"
        if content is None:
            script += 'f.unlinkSync(p)'
        else:
            script += f'f.writeFileSync(p,{json.dumps(content)});f.chownSync(p,{uid},{gid});f.chmodSync(p,{mode})'
        controller.docker('run', '--rm', '--network', 'none', '--user', '0',
            '-v', str(renderer.parent) + ':/fixture', controller.image(candidate), 'node', '-e', script)

    def snapshot():
        names = controller.docker('ps', '-a', '--format', '{{.Names}}').splitlines()
        containers = {}
        for name in ('evn-marketing-worker', 'evn-marketing-web-blue', 'evn-marketing-web-green', 'evn-marketing-proxy'):
            if name in names:
                item = controller.inspect(name)
                containers[name] = {k: item[k] for k in ('Id', 'RestartCount')}
                containers[name].update({k: item['State'][k] for k in ('Pid', 'StartedAt', 'Running')})
        return {'containers': containers, 'journal': controller.state_file.read_bytes(),
                'proxyConfig': (root / 'nginx/nginx.conf').read_bytes(),
                'proxyWorkers': sorted(controller.proxy_workers()),
                'workerGate': controller.gate(active).read_bytes()}

    faults = [('unreadable_renderer', original, 0o600, 0, 0)]
    if not rollback:
        faults += [('missing_renderer', None, 0o644, metadata.st_uid, metadata.st_gid),
                   ('invalid_renderer', 'this is not JavaScript', 0o644, metadata.st_uid, metadata.st_gid),
                   ('invalid_nginx', "process.stdout.write('invalid_nginx_directive;')", 0o644, metadata.st_uid, metadata.st_gid)]
    passed = []
    for name, content, mode, uid, gid in faults:
        before = snapshot()
        try:
            fixture(content, mode, uid, gid)
            try:
                controller.release(candidate['revision'], candidate['digest'], rollback=rollback)
            except Exception as error:
                assert str(error) == 'proxy_preflight_failed', (name, type(error).__name__, str(error))
            else:
                raise AssertionError('unsafe proxy configuration was accepted: ' + name)
            assert snapshot() == before, 'preflight rejection changed a live process, config, gate or journal'
            controller.probe(active, public=True)
            controller.worker_ready(active)
            assert not list((root / 'nginx').glob('preflight-*')), 'preflight staging was not removed'
            passed.append(('rollback:' if rollback else 'release:') + name)
        finally:
            fixture(original)
    return passed
