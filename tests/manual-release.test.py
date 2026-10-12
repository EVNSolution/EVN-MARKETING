"""Run with python3; synthetic manual release checks, no AWS/network calls."""
from contextlib import redirect_stdout
from datetime import datetime, timezone
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("release", ROOT / "deploy/aws/release.py")
cloud = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cloud)
SHA, DIGEST, BUNDLE = "a" * 40, "sha256:" + "b" * 64, "c" * 64
COMMAND = "00000000-0000-0000-0000-000000000000"
ENV = {"SOURCE_SHA": SHA, "RELEASE_ACTION": "release", "AWS_PROFILE": "human-login",
       "MARKETING_AWS_ACCOUNT_ID": "000000000000", "MARKETING_INSTANCE_ID": "i-" + "0" * 17,
       "MARKETING_DEPLOYER_ARN": "arn:aws:sts::000000000000:assumed-role/MarketingAdmin/reviewed-session",
       "MARKETING_SSM_DOCUMENT_VERSION": "2", "MARKETING_SSM_DOCUMENT_SHA256": "d" * 64}
state, events = {}, []


def fake_output(args):
    if args[0] == "gh":
        assert args[1:] == ["api", "repos/EVNSolution/EVN-MARKETING/git/ref/heads/main", "--jq", ".object.sha"]
        events.append("main")
        return state.get("main", SHA)
    assert args[0] == "git"
    if "status" in args:
        assert args[1:] == ["-C", str(ROOT), "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"]
        return state.get("dirty", "")
    assert args[-2:] == ["rev-parse", "HEAD"]
    return state.get("head", SHA)


def fake_aws(*args):
    operation = args[:2]
    events.append(operation)
    if operation == ("sts", "get-caller-identity"):
        return {"Account": state.get("account", ENV["MARKETING_AWS_ACCOUNT_ID"]),
                "Arn": state.get("principal", ENV["MARKETING_DEPLOYER_ARN"])}
    if operation == ("ec2", "describe-instances"):
        assert args[2:] == ("--instance-ids", ENV["MARKETING_INSTANCE_ID"])
        target = {"InstanceId": state.get("instance", ENV["MARKETING_INSTANCE_ID"]),
                  "Tags": [{"Key": "Service", "Value": state.get("tag", "evn-marketing")}]}
        return {"Reservations": [] if state.get("missing_target") else [{"Instances": [target]}]}
    if operation == ("ecr", "describe-repositories"):
        assert args[2:] == ("--repository-names", "evn-marketing")
        return {"repositories": [{"imageTagMutability": state.get("mutability", "IMMUTABLE")}]}
    if operation == ("ecr", "describe-images"):
        assert args[2:] == ("--repository-name", "evn-marketing", "--image-ids", "imageTag=" + SHA)
        return {"imageDetails": [{"imageDigest": state.get("digest", DIGEST)}]}
    if operation == ("ecr", "describe-image-scan-findings"):
        assert args[2:] == ("--repository-name", "evn-marketing", "--image-id", "imageDigest=" + DIGEST)
        state.update(state.get("after_scan", {}))
        now = datetime.now(timezone.utc).isoformat()
        return {"imageId": {"imageDigest": DIGEST}, "imageScanStatus": {"status": state.get("scan", "COMPLETE")},
                "imageScanFindings": {"imageScanCompletedAt": state.get("scan_time", now),
                                      "vulnerabilitySourceUpdatedAt": now, "findingSeverityCounts": {}}}
    assert operation == ("ssm", "send-command")
    assert events[-4:] == [("sts", "get-caller-identity"), ("ec2", "describe-instances"), "main", operation]
    if os.environ["RELEASE_ACTION"] == "release":
        assert events[-5] == ("ecr", "describe-image-scan-findings")
    if state.get("lost_send"):
        raise RuntimeError("response lost")
    expected_digest = DIGEST if os.environ["RELEASE_ACTION"] == "release" else "previous"
    assert json.loads(args[3]) == cloud.command_request(os.environ, BUNDLE, expected_digest)
    return {"Command": {"CommandId": COMMAND}}


def poll(args, **kwargs):
    if args[:3] == ["aws", "ecr", "describe-image-scan-findings"]:
        assert args[-5:] == ["--region", cloud.REGION, "--output", "json", "--no-cli-pager"]
        return SimpleNamespace(returncode=0, stdout=json.dumps(fake_aws(*args[1:-5])), stderr="")
    assert args[:3] == ["aws", "ssm", "get-command-invocation"]
    assert args[args.index("--query") + 1] == "{Status:Status,ResponseCode:ResponseCode}"
    assert args[args.index("--command-id") + 1] == COMMAND
    assert args[args.index("--instance-id") + 1] == ENV["MARKETING_INSTANCE_ID"]
    status = state.get("poll", ["Pending", "Success"])
    state["poll"] = status
    value = status.pop(0)
    return SimpleNamespace(returncode=0, stdout=json.dumps({"Status": value, "ResponseCode": 0}), stderr="")


def invoke(command, *, reject=False, sent=0):
    events.clear()
    digest = DIGEST if os.environ["RELEASE_ACTION"] == "release" else "previous"
    captured = io.StringIO()
    with patch.object(sys, "argv", ["release.py", command, digest]), redirect_stdout(captured):
        try:
            cloud.main()
        except (ValueError, RuntimeError, KeyError):
            assert reject, captured.getvalue()
        else:
            assert not reject
    assert events.count(("ssm", "send-command")) == sent
    assert not any(key.startswith("GITHUB_") for key in os.environ)
    return captured.getvalue()


with patch.dict(os.environ, ENV, clear=True), patch.object(cloud, "output", side_effect=fake_output), \
        patch.object(cloud, "aws", side_effect=fake_aws), patch.object(cloud, "bundle_hash", return_value=BUNDLE), \
        patch.object(cloud.subprocess, "run", side_effect=poll), patch.object(cloud.time, "sleep"), \
        patch("builtins.open", side_effect=AssertionError("manual path must not write files")):
    for command in ("manual-validate", "manual-dispatch"):
        for change in ({"account": "111111111111"}, {"principal": ENV["MARKETING_DEPLOYER_ARN"] + "-other"},
                       {"instance": "i-" + "1" * 17}, {"tag": "evn-warp"}, {"tag": None}, {"missing_target": True},
                       {"head": "e" * 40}, {"main": "e" * 40}, {"dirty": " M tracked"}, {"dirty": "?? untracked"},
                       {"mutability": "MUTABLE"}, {"digest": "sha256:" + "e" * 64}, {"scan": "ACTIVE"},
                       {"scan_time": "2000-01-01T00:00:00+00:00"},
                       {"after_scan": {"account": "111111111111"}},
                       {"after_scan": {"principal": ENV["MARKETING_DEPLOYER_ARN"] + "-other"}},
                       {"after_scan": {"instance": "i-" + "1" * 17}},
                       {"after_scan": {"tag": "evn-warp"}}, {"after_scan": {"missing_target": True}},
                       {"after_scan": {"main": "e" * 40}}, {"after_scan": {"dirty": " M tracked"}}):
            state.clear()
            state.update(change)
            invoke(command, reject=True)
        state.clear()
        for key, value in (("SOURCE_SHA", "short"), ("RELEASE_ACTION", "recover"), ("MARKETING_DEPLOYER_ARN", ""),
                           ("MARKETING_SSM_DOCUMENT_VERSION", "$LATEST"), ("MARKETING_SSM_DOCUMENT_SHA256", "bad")):
            with patch.dict(os.environ, {key: value}):
                invoke(command, reject=True)
        for action in ("release", "rollback"):
            state.clear()
            with patch.dict(os.environ, {"RELEASE_ACTION": action}):
                result = invoke(command, sent=int(command == "manual-dispatch"))
                assert all(value in result for value in (SHA, BUNDLE, DIGEST if action == "release" else "previous"))
                if action == "rollback":
                    assert not any(isinstance(event, tuple) and event[0] == "ecr" for event in events)
                if command == "manual-dispatch":
                    assert COMMAND in result and "succeeded" in result
    for failure in ({"lost_send": True}, {"poll": ["Failed"]}):
        state.clear()
        state.update(failure)
        invoke("manual-dispatch", reject=True, sent=1)
    state.clear()
    for command in ("validate", "dispatch"):
        invoke(command, reject=True)  # CI still rejects absent GitHub metadata.

# The shared wrapper disables send retries for CI and manual callers, leaving reads unchanged.
with patch.dict(os.environ, {**ENV, "AWS_MAX_ATTEMPTS": "7"}, clear=True), patch.object(cloud.subprocess, "run",
        return_value=SimpleNamespace(returncode=0, stdout="{}")) as run:
    cloud.aws("ssm", "send-command")
    assert run.call_args.kwargs["env"] == {**ENV, "AWS_MAX_ATTEMPTS": "1"}
    cloud.aws("sts", "get-caller-identity")
    assert run.call_args.kwargs["env"] is None
    assert os.environ["AWS_MAX_ATTEMPTS"] == "7"

print("manual release checks passed (synthetic only; no AWS operations)")
