"""Synthetic local operator checks; no AWS, GitHub, Docker or network calls."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "deploy/aws"))
spec = importlib.util.spec_from_file_location("operator_release", ROOT / "deploy/aws/operator-release.py")
operator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(operator)
SHA, DIGEST = "a" * 40, "sha256:" + "b" * 64
CONFIG = {key: "value" for key in operator.CONFIG_KEYS} | {
    "MARKETING_AWS_ACCOUNT_ID": "000000000000", "MARKETING_INSTANCE_ID": "i-" + "0" * 17,
    "MARKETING_DEPLOYER_ARN": "arn:aws:sts::000000000000:assumed-role/MarketingAdmin/session",
    "MARKETING_SSM_DOCUMENT_VERSION": "1", "MARKETING_SSM_DOCUMENT_SHA256": "c" * 64,
}


def result(code=0, stdout="", stderr=""):
    return SimpleNamespace(returncode=code, stdout=stdout, stderr=stderr)


with tempfile.TemporaryDirectory() as directory:
    path = Path(directory, "operator.json")
    for data in ({}, CONFIG | {"SECRET": "no"}, CONFIG | {"AWS_PROFILE": ""}):
        path.write_text(json.dumps(data))
        try:
            operator.load_config(path)
        except ValueError:
            pass
        else:
            raise AssertionError("invalid config accepted")
    try:
        operator.load_config(Path(directory, "missing.json"))
    except FileNotFoundError:
        pass
    else:
        raise AssertionError("missing config accepted")

missing = result(254, stderr="An error occurred (ImageNotFoundException) when calling DescribeImages")
denied = result(254, stderr="An error occurred (AccessDeniedException) when calling DescribeImages")
with patch.object(operator.subprocess, "run", return_value=missing):
    assert operator.image_digest(SHA, missing_ok=True) is None
    try:
        operator.image_digest(SHA)
    except operator.MissingImageError:
        pass
    else:
        raise AssertionError("missing image was not distinguished")
with patch.object(operator.subprocess, "run", return_value=denied):
    try:
        operator.image_digest(SHA, missing_ok=True)
    except RuntimeError as error:
        assert "determine" in str(error)
    else:
        raise AssertionError("permission error was treated as an absent image")

commands = []
with patch.dict(os.environ, {"MARKETING_AWS_ACCOUNT_ID": "000000000000",
                             "DOCKER_HOST": "unix:///Users/test/.colima/evn-marketing/docker.sock"}, clear=True), \
        patch.object(operator, "validate_publish_target"), \
        patch.object(operator, "image_digest", side_effect=[None, DIGEST]), \
        patch.object(operator.shutil, "which", return_value="/opt/homebrew/bin/docker-credential-ecr-login"), \
        patch.object(operator.subprocess, "run", side_effect=[result(stdout=b"source archive"), result()]) as process, \
        patch.object(operator.release, "check_source", return_value=SHA) as source, \
        patch.object(operator.release, "check_manual_target") as target, \
        patch.object(operator, "run", side_effect=lambda args, **kwargs: commands.append((args, kwargs)) or ""):
    assert operator.publish_image(SHA) == DIGEST
archive, build = process.call_args_list
assert archive.args[0] == ["git", "archive", "--format=tar", SHA]
assert build.args[0][0:4] == ["docker", "build", "--platform", "linux/amd64"]
assert build.args[0][4] == "--provenance=false"
assert build.args[0][-1] == "-" and build.kwargs["input"] == b"source archive"
source.assert_called_once_with(manual=True)
target.assert_called_once_with()
push, = commands
assert push[0][0:2] == ["docker", "push"]
assert push[1]["env"]["DOCKER_HOST"].endswith("/.colima/evn-marketing/docker.sock")
assert push[1]["env"]["AWS_ECR_DISABLE_CACHE"] == "true"
assert "DOCKER_CONFIG" in push[1]["env"]

with patch.dict(os.environ, {"MARKETING_AWS_ACCOUNT_ID": "000000000000"}), \
        patch.object(operator, "validate_publish_target"), \
        patch.object(operator, "image_digest", side_effect=[None, DIGEST]) as lookup, \
        patch.object(operator.shutil, "which", return_value="synthetic-helper"), \
        patch.object(operator.subprocess, "run", side_effect=[result(stdout=b"source archive"), result()]) as process, \
        patch.object(operator.release, "check_source", return_value=SHA), \
        patch.object(operator.release, "check_manual_target"), \
        patch.object(operator, "run", return_value="") as upload:
    assert operator.publish_image(SHA, target="operations") == DIGEST
    assert lookup.call_args_list[0].args[0] == SHA + "-ops"
    args = process.call_args_list[1].args[0]
    assert args[args.index("--target")+1] == "operations"
    assert args[args.index("-t")+1].endswith(":"+SHA+"-ops")
    assert "org.opencontainers.image.revision="+SHA in args
    assert upload.call_args.args[0][0:2] == ["docker","push"]

with patch.object(operator, "configure", return_value=SHA) as configure, \
        patch.object(operator, "publish_image", return_value=DIGEST) as publish, \
        patch.object(operator, "run", return_value=""), \
        patch.object(operator.release, "prepare_request", side_effect=AssertionError("operations images are not releases")), \
        patch.object(operator.release, "dispatch", side_effect=AssertionError("must not deploy")):
    operator.execute("publish-ops", "synthetic.json")
    configure.assert_called_once_with("synthetic.json", "release")
    publish.assert_called_once_with(SHA, target="operations")

request = {"Parameters": {"Action": ["release"], "Revision": [SHA], "Digest": [DIGEST]}}
for command in ("check", "publish"):
    with patch.object(operator, "configure", return_value=SHA), \
            patch.object(operator, "image_digest", return_value=DIGEST), \
            patch.object(operator, "publish_image", return_value=DIGEST), \
            patch.object(operator.release, "prepare_request", return_value=request) as prepare, \
            patch.object(operator.release, "dispatch", side_effect=AssertionError("must not dispatch")), \
            patch.object(operator, "run", return_value="") as audit:
        operator.execute(command, "synthetic.json")
        audit.assert_called_once_with(["npm", "audit", "--omit=dev", "--audit-level=high"])
        prepare.assert_called_once_with(DIGEST, manual=True)

with patch.object(operator, "run", return_value=SHA), \
        patch.object(operator, "load_config", return_value=CONFIG), \
        patch.object(operator.release, "check_source", return_value=SHA) as source, \
        patch.object(operator, "require_pr_checks") as checks:
    assert operator.configure("synthetic.json", "release") == SHA
    source.assert_called_once_with(manual=True)
    checks.assert_called_once_with(SHA)

with patch.object(operator, "configure", return_value=SHA), \
        patch.object(operator, "image_digest", return_value=DIGEST), \
        patch.object(operator.release, "dispatch") as dispatch, \
        patch.object(operator, "run", return_value="") as audit:
    operator.execute("release", "synthetic.json")
    audit.assert_called_once_with(["npm", "audit", "--omit=dev", "--audit-level=high"])
    dispatch.assert_called_once_with(DIGEST, manual=True)
    dispatch.reset_mock()
    audit.reset_mock()
    operator.execute("rollback", "synthetic.json")
    audit.assert_not_called()
    dispatch.assert_called_once_with("previous", manual=True)

for command in ("publish", "publish-ops", "release"):
    with patch.object(operator, "configure", return_value=SHA), \
            patch.object(operator, "run", side_effect=RuntimeError("audit failed")), \
            patch.object(operator, "publish_image") as publish, \
            patch.object(operator.release, "dispatch") as dispatch:
        try:
            operator.execute(command, "synthetic.json")
        except RuntimeError:
            pass
        else:
            raise AssertionError("audit failure was accepted")
        publish.assert_not_called()
        dispatch.assert_not_called()

HEAD = "d" * 40
pulls = [{"number": 7, "merged_at": "2026-09-30T00:00:00Z", "merge_commit_sha": SHA,
          "base": {"ref": "main"}, "head": {"sha": HEAD}}]
passed = [{"workflow": "PR checks", "name": "verify", "bucket": "skipping"},
          {"workflow": "GitGuardian Security Checks", "name": "GitGuardian scan", "bucket": "pass"}]
runs = [{"databaseId": 22, "headSha": HEAD, "status": "completed", "conclusion": "skipped"},
        {"databaseId": 21, "headSha": HEAD, "status": "completed", "conclusion": "success"}]
jobs = {"jobs": [{"name": "verify", "status": "completed", "conclusion": "success"}]}
with patch.object(operator, "run", side_effect=[json.dumps(pulls), json.dumps(passed),
                                                 json.dumps(runs), json.dumps(jobs)]) as call:
    operator.require_pr_checks(SHA)
    assert call.call_args_list[1].args[0] == ["gh", "pr", "checks", "7", "--repo",
                                                operator.release.REPOSITORY, "--json", "name,bucket,workflow"]
    assert call.call_args_list[2].args[0] == ["gh", "run", "list", "--repo", operator.release.REPOSITORY,
        "--workflow", "pr.yml", "--commit", HEAD, "--event", "pull_request", "--json",
        "databaseId,headSha,status,conclusion", "--limit", "100"]

failures = [
    ([json.dumps(pulls), "[]"], "empty checks"),
    ([json.dumps(pulls), json.dumps([{"workflow": "GitGuardian", "name": "scan", "bucket": "pending"}])],
     "pending current check"),
    ([json.dumps(pulls), json.dumps([{"workflow": "GitGuardian", "name": "scan", "bucket": "fail"}])],
     "failed current check"),
    ([json.dumps(pulls), json.dumps(passed), "[]"], "missing verification"),
    ([json.dumps(pulls), json.dumps(passed), json.dumps([
        {"databaseId": 23, "headSha": HEAD, "status": "in_progress", "conclusion": ""}, runs[1]])],
     "pending newest verification"),
    ([json.dumps(pulls), json.dumps(passed), json.dumps([
        {"databaseId": 23, "headSha": HEAD, "status": "completed", "conclusion": "failure"}, runs[1]])],
     "failed newest verification"),
    ([json.dumps(pulls), json.dumps(passed), json.dumps(runs), json.dumps({"jobs": []})],
     "missing verify job"),
]
for outputs, label in failures:
    with patch.object(operator, "run", side_effect=outputs):
        try:
            operator.require_pr_checks(SHA)
        except ValueError:
            pass
        else:
            raise AssertionError(label + " was accepted")

wrong_base = [{**pulls[0], "base": {"ref": "release"}}]
with patch.object(operator, "run", return_value=json.dumps(wrong_base)):
    try:
        operator.require_pr_checks(SHA)
    except ValueError:
        pass
    else:
        raise AssertionError("non-main merged PR was accepted")

print("operator release checks passed (synthetic only; no external operations)")
