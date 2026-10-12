"""Run with python3; stdlib only, synthetic data, no AWS/network/Docker calls."""
import copy
from datetime import datetime, timedelta, timezone
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import types
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("cloud_release", ROOT / "deploy/aws/release.py")
cloud = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cloud)
template = json.loads((ROOT / "deploy/aws/cloudformation.json").read_text())
resources = template["Resources"]
document = resources["ReleaseDocument"]["Properties"]["Content"]
script = document["mainSteps"][0]["inputs"]["runCommand"]
host = types.ModuleType("ssm_document_check")
exec(compile("\n".join(script[2:-1]), "ssm-document", "exec"), host.__dict__)

SHA = "a" * 40
DIGEST = "sha256:" + "b" * 64
ENV = {
    "GITHUB_REPOSITORY": "EVNSolution/EVN-MARKETING", "GITHUB_EVENT_NAME": "workflow_dispatch",
    "GITHUB_REF": "refs/heads/main", "GITHUB_SHA": SHA, "SOURCE_SHA": SHA, "RELEASE_ACTION": "release",
    "MARKETING_AWS_ACCOUNT_ID": "000000000000", "MARKETING_INSTANCE_ID": "i-" + "0" * 17,
    "MARKETING_SSM_DOCUMENT_VERSION": "1", "MARKETING_SSM_DOCUMENT_SHA256": "c" * 64,
}


def refuses(call):
    try:
        call()
    except (ValueError, KeyError, FileNotFoundError):
        return
    raise AssertionError("unsafe input was accepted")


assert cloud.source(ENV, SHA, SHA) == SHA
for key, value in [("GITHUB_REPOSITORY", "EVNSolution/EVN-WARP"), ("GITHUB_EVENT_NAME", "push"),
                   ("GITHUB_REF", "refs/heads/feature"), ("SOURCE_SHA", SHA + "\n"),
                   ("SOURCE_SHA", "$(id)"), ("GITHUB_SHA", "b" * 40), ("RELEASE_ACTION", "recover")]:
    refuses(lambda: cloud.source({**ENV, key: value}, SHA, SHA))
refuses(lambda: cloud.source(ENV, "b" * 40, SHA))
refuses(lambda: cloud.source(ENV, SHA, "b" * 40))
for key, value in [("MARKETING_AWS_ACCOUNT_ID", ""), ("MARKETING_INSTANCE_ID", "i-0,other"),
                   ("MARKETING_SSM_DOCUMENT_VERSION", "$LATEST"), ("MARKETING_SSM_DOCUMENT_SHA256", "x" * 64)]:
    refuses(lambda: cloud.config({**ENV, key: value}))

now = datetime.now(timezone.utc)
report = {"imageId": {"imageDigest": DIGEST}, "imageScanStatus": {"status": "COMPLETE"},
          "imageScanFindings": {"imageScanCompletedAt": now.isoformat(),
                                "vulnerabilitySourceUpdatedAt": now.isoformat(), "findingSeverityCounts": {}}}
assert cloud.scan_clean(report, DIGEST, now)
pending = {**report, "imageScanStatus": {"status": "IN_PROGRESS"}}
assert cloud.scan_clean(pending, DIGEST, now) is False
for status in ("FAILED", "UNSUPPORTED_IMAGE", "ACTIVE", "FINDINGS_UNAVAILABLE", "SCAN_ELIGIBILITY_EXPIRED", None):
    refuses(lambda: cloud.scan_clean({**report, "imageScanStatus": {"status": status}}, DIGEST, now))
refuses(lambda: cloud.scan_clean(report, "sha256:" + "c" * 64, now))
for key, value in [("findingSeverityCounts", {"HIGH": 1}), ("findingSeverityCounts", {"CRITICAL": 1}),
                   ("findingSeverityCounts", {"UNDEFINED": 1}), ("findingSeverityCounts", {"LOW": -1}),
                   ("findingSeverityCounts", {"HIGH": "0"}), ("findingSeverityCounts", None),
                   ("imageScanCompletedAt", (now - timedelta(days=2)).isoformat()),
                   ("vulnerabilitySourceUpdatedAt", (now + timedelta(minutes=1)).isoformat()),
                   ("imageScanCompletedAt", None), ("imageScanCompletedAt", "2026-09-22T12:00:00")]:
    bad = copy.deepcopy(report)
    bad["imageScanFindings"][key] = value
    refuses(lambda: cloud.scan_clean(bad, DIGEST, now))

# ECR can publish the image before scan-on-push creates its findings record.
missing_scan = types.SimpleNamespace(returncode=254, stdout="", stderr="An error occurred (ScanNotFoundException)")
with patch.object(cloud.subprocess, "run", side_effect=[missing_scan,
        types.SimpleNamespace(returncode=0, stdout=json.dumps(pending)),
        types.SimpleNamespace(returncode=0, stdout=json.dumps(report))]) as lookup, \
        patch.object(cloud.time, "sleep") as sleep:
    cloud.scan(DIGEST)
    assert lookup.call_count == 3 and sleep.call_count == 2
for error in ("AccessDeniedException", "ImageNotFoundException", "connection timed out"):
    with patch.object(cloud.subprocess, "run", return_value=types.SimpleNamespace(
            returncode=254, stdout="", stderr=error)) as lookup, patch.object(cloud.time, "sleep") as sleep:
        try:
            cloud.scan(DIGEST)
        except RuntimeError as failure:
            assert str(failure) == "image scan lookup failed"
        else:
            raise AssertionError("unexpected scan failure retried")
        assert lookup.call_count == 1 and sleep.call_count == 0
with patch.object(cloud.subprocess, "run", return_value=missing_scan) as lookup, \
        patch.object(cloud.time, "sleep"):
    try:
        cloud.scan(DIGEST)
    except RuntimeError as failure:
        assert "timed out" in str(failure)
    else:
        raise AssertionError("missing scan accepted")
    assert lookup.call_count == 60

request = cloud.command_request(ENV, "d" * 64, DIGEST)
assert request["InstanceIds"] == [ENV["MARKETING_INSTANCE_ID"]]
assert request["DocumentName"].endswith(":document/EVN-Marketing-Release")
assert request["DocumentVersion"] == "1" and request["DocumentHashType"] == "Sha256"
assert set(request["Parameters"]) == {"Action", "Revision", "Digest", "BundleSha256"}
rollback = cloud.command_request({**ENV, "RELEASE_ACTION": "rollback"}, "d" * 64, "previous")
assert rollback["Parameters"]["Digest"] == ["previous"]
refuses(lambda: cloud.command_request(ENV, "d" * 64, "previous"))
refuses(lambda: cloud.command_request({**ENV, "RELEASE_ACTION": "rollback"}, "d" * 64, DIGEST))

# Exercise the actual inline SSM program, with synthetic installation and no controller execution.
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory).resolve()
    (root / "deploy").mkdir()
    for name in cloud.BUNDLE:
        (root / name).write_text("reviewed synthetic file: " + name)
    (root / "config.json").write_text("{}")
    expected = cloud.bundle_hash(root)
    env = {"SSM_Action": "release", "SSM_Revision": SHA, "SSM_Digest": DIGEST, "SSM_BundleSha256": expected}
    original_lstat = Path.lstat

    def root_owned(path):
        info = original_lstat(path)
        # Simulate administrator ownership on macOS without privilege changes; retain file type/mode.
        mode = info.st_mode if root in path.parents or path == root else (info.st_mode & ~0o022)
        return types.SimpleNamespace(st_uid=0, st_mode=mode)

    with patch.dict(os.environ, env, clear=True), patch.object(host.os, "geteuid", return_value=0), \
            patch.object(host, "Path", return_value=root), patch.object(Path, "lstat", root_owned), \
            patch.object(host.subprocess, "run", return_value=types.SimpleNamespace(returncode=0)) as run:
        host.run()
        assert run.call_args.args[0] == ["/usr/bin/python3", "-I", str(root / "deploy/start-release.py"),
                                         "release", "--revision", SHA, "--digest", DIGEST]
        assert run.call_args.kwargs["stdout"] == subprocess.DEVNULL
        assert run.call_args.kwargs["stderr"] == subprocess.DEVNULL
        assert run.call_args.kwargs["env"]["DOCKER_CONFIG"] == "/root/.docker"
        assert run.call_args.kwargs["env"]["AWS_ECR_DISABLE_CACHE"] == "true"
        assert not any(key.startswith("SSM_") for key in run.call_args.kwargs["env"])
        os.environ.update(SSM_Action="rollback", SSM_Digest="previous")
        host.run()
        assert run.call_args.args[0][-1] == "rollback" and len(run.call_args.args[0]) == 4
        for key, value in [("SSM_Action", "expire"), ("SSM_Action", "recover"), ("SSM_Digest", DIGEST),
                           ("SSM_BundleSha256", "e" * 64), ("SSM_Revision", SHA + ";id"),
                           ("SSM_BundleSha256", ""), ("SSM_Revision", "")]:
            saved = os.environ[key]
            os.environ[key] = value
            run.reset_mock()
            refuses(host.run)
            run.assert_not_called()
            os.environ[key] = saved
        (root / cloud.BUNDLE[0]).write_text("tampered")
        run.reset_mock()
        refuses(host.run)
        run.assert_not_called()
        (root / cloud.BUNDLE[0]).write_text("reviewed synthetic file: " + cloud.BUNDLE[0])
        (root / "config.json").chmod(0o666)
        refuses(host.run)
        (root / "config.json").chmod(0o600)
        (root / "config.json").unlink()
        (root / "config.json").symlink_to(root / cloud.BUNDLE[0])
        refuses(host.run)
        run.assert_not_called()

# Dispatch orchestration: the final main check follows the scan; rollback never resolves/picks an image.
events = []


def fake_aws(*args):
    events.append(args[:2])
    if args[:2] == ("ecr", "describe-images"):
        return {"imageDetails": [{"imageDigest": DIGEST}]}
    assert args[:2] == ("ssm", "send-command")
    return {"Command": {"CommandId": "00000000-0000-0000-0000-000000000000"}}


with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {**ENV, "GITHUB_STEP_SUMMARY": directory + "/summary"}, clear=True), \
        patch.object(cloud, "bundle_hash", return_value="d" * 64), patch.object(cloud, "aws", side_effect=fake_aws), \
        patch.object(cloud, "scan", side_effect=lambda _: events.append("scan")), \
        patch.object(cloud, "check_source", side_effect=lambda: events.append("main")), \
        patch.object(cloud.subprocess, "run", return_value=types.SimpleNamespace(returncode=0, stdout='{"Status":"Success","ResponseCode":0}')):
    cloud.dispatch(DIGEST)
    assert events == [("ecr", "describe-images"), "scan", "main", ("ssm", "send-command")]
    events.clear()
    os.environ["RELEASE_ACTION"] = "rollback"
    cloud.dispatch("previous")
    assert events == ["main", ("ssm", "send-command")]
    events.clear()
    os.environ["RELEASE_ACTION"] = "release"
    with patch.object(cloud, "scan", side_effect=ValueError("scan blocked")):
        refuses(lambda: cloud.dispatch(DIGEST))
    assert events == [("ecr", "describe-images")]

assert host.BUNDLE == cloud.BUNDLE == ("deploy/controller.py", "deploy/nginx-config.mjs", "deploy/start-release.py")
assert document["schemaVersion"] == "2.2"
assert set(document["parameters"]) == set(request["Parameters"])
assert all(p["interpolationType"] == "ENV_VAR" for p in document["parameters"].values())
assert "{{" not in "\n".join(script)  # No shell interpolation fallback on old agents.
assert int(document["mainSteps"][0]["inputs"]["timeoutSeconds"]) >= 3600
assert resources["Images"]["Properties"]["ImageTagMutability"] == "IMMUTABLE"
assert resources["Images"]["DeletionPolicy"] == "Retain"
assert "LifecyclePolicy" not in resources["Images"]["Properties"]
assert not any(r["Type"] in ("AWS::EC2::Instance", "AWS::SSM::Parameter") for r in resources.values())

release_role = resources["ReleaseRole"]["Properties"]
assert template["Parameters"]["EnableGitHubRelease"]["Default"] == "false"
assert template["Parameters"]["EnableGitHubRelease"]["AllowedValues"] == ["false", "true"]
assert template["Conditions"]["GitHubReleaseEnabled"] == {"Fn::Equals": [{"Ref": "EnableGitHubRelease"}, "true"]}
assert resources["ReleaseRole"]["Condition"] == template["Outputs"]["ReleaseRoleArn"]["Condition"] == "GitHubReleaseEnabled"
assert "Condition" not in resources["HostRole"] and "Condition" not in resources["ReleaseDocument"]
trust = release_role["AssumeRolePolicyDocument"]["Statement"][0]
assert trust["Condition"]["StringEquals"] == {
    "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
    "token.actions.githubusercontent.com:sub": {"Ref": "GitHubOidcSubject"},
}
policies = release_role["Policies"][0]["PolicyDocument"]["Statement"]
send = next(s for s in policies if "ssm:SendCommand" in s["Action"])
assert send["Resource"] == [
    {"Fn::Sub": "arn:${AWS::Partition}:ssm:ap-northeast-2:${AWS::AccountId}:document/EVN-Marketing-Release"},
    {"Fn::Sub": "arn:${AWS::Partition}:ec2:ap-northeast-2:${AWS::AccountId}:instance/${MarketingInstanceId}"},
]
actions = {action for s in policies for action in s["Action"]}
assert not (actions & {"ssm:GetParameters", "ssm:CreateDocument", "ssm:UpdateDocument", "iam:PassRole", "ssm:StartSession"})
assert "AWS-RunShellScript" not in json.dumps(template)
for role in ("ReleaseRole", "HostRole"):
    for statement in resources[role]["Properties"]["Policies"][0]["PolicyDocument"]["Statement"]:
        assert not any("*" in action for action in statement["Action"])
host_policy = resources["HostRole"]["Properties"]["Policies"][0]["PolicyDocument"]["Statement"]
secrets = next(s for s in host_policy if "ssm:GetParameters" in s["Action"])["Resource"]
assert [item["Fn::Sub"].split("production/")[1] for item in secrets] == [
    "auth-secret", "source-username", "source-password", "warp-api-key"]
decrypt = next(s for s in host_policy if "kms:Decrypt" in s["Action"])
assert decrypt["Condition"]["StringEquals"]["kms:EncryptionContext:PARAMETER_ARN"] == secrets
assert any("ec2:DescribeSnapshots" in s["Action"] for s in host_policy)
assert any("ec2:DescribeVolumes" in s["Action"] for s in host_policy)
snapshot_policies = [s for s in host_policy if 'ec2:CreateSnapshot' in s['Action']]
assert len(snapshot_policies) == 2
assert snapshot_policies[0]['Resource']['Fn::Sub'].endswith('volume/${MarketingDataVolumeId}')
assert snapshot_policies[1]['Condition']['StringEquals']['aws:RequestTag/Service'] == 'evn-marketing'
tag_policy = next(s for s in host_policy if 'ec2:CreateTags' in s['Action'])
assert tag_policy['Condition']['StringEquals']['ec2:CreateAction'] == 'CreateSnapshot'
assert not any(action in ('ec2:DeleteSnapshot','ec2:CreateVolume','ec2:AttachVolume') for s in host_policy for action in s['Action'])

workflow = (ROOT / ".github/workflows/deploy.yml").read_text()
assert "workflow_dispatch:" in workflow and "pull_request" not in workflow and "\n  push:" not in workflow
assert "environment: production" in workflow and "cancel-in-progress: false" in workflow
assert "persist-credentials: false" in workflow and "github.ref == 'refs/heads/main'" in workflow
assert "download-artifact" in workflow and "release_artifact.py verify" in workflow
assert "docker build" not in workflow and "npm ci" not in workflow
ci = (ROOT / ".github/workflows/ci.yml").read_text()
assert "npm audit --omit=dev --audit-level=high" in ci
assert "cache-from: type=gha" in ci and "cache-to: type=gha" in ci
unit = (ROOT / "deploy/marketing-release.service").read_text()
assert "controller.py expire" in unit and "recover" not in unit and "SuccessExitStatus=75" in unit
assert "OnUnitInactiveSec=60s" in (ROOT / "deploy/marketing-release.timer").read_text()
print("cloud release boundary checks passed (synthetic only; no AWS operations)")
