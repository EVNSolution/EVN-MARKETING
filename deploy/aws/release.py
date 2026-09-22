"""Bounded CI helpers. No AWS operation runs on import or in local tests."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[2]
BUNDLE = ("deploy/controller.py", "deploy/nginx-config.mjs")
REGION = "ap-northeast-2"
REPOSITORY = "EVNSolution/EVN-MARKETING"
DOCUMENT = "EVN-Marketing-Release"


def checked(value, pattern, name):
    if not isinstance(value, str) or not re.fullmatch(pattern, value):
        raise ValueError("invalid " + name)
    return value


def source(env, head, main):
    revision = checked(env.get("SOURCE_SHA"), r"[0-9a-f]{40}", "source SHA")
    if (env.get("GITHUB_REPOSITORY") != REPOSITORY
            or env.get("GITHUB_EVENT_NAME") != "workflow_dispatch"
            or env.get("GITHUB_REF") != "refs/heads/main"
            or revision != env.get("GITHUB_SHA") or revision != head or revision != main):
        raise ValueError("source must be the dispatched, checked-out, current main SHA")
    checked(env.get("RELEASE_ACTION"), r"release|rollback", "action")
    return revision


def bundle_hash(root):
    manifest = "".join(hashlib.sha256((root / name).read_bytes()).hexdigest()
                       + "  " + name + "\n" for name in BUNDLE)
    return hashlib.sha256(manifest.encode()).hexdigest()


def config(env):
    return {
        "account": checked(env.get("MARKETING_AWS_ACCOUNT_ID"), r"[0-9]{12}", "account"),
        "instance": checked(env.get("MARKETING_INSTANCE_ID"), r"i-([0-9a-f]{8}|[0-9a-f]{17})", "instance"),
        "version": checked(env.get("MARKETING_SSM_DOCUMENT_VERSION"), r"[1-9][0-9]*", "document version"),
        "hash": checked(env.get("MARKETING_SSM_DOCUMENT_SHA256"), r"[0-9a-f]{64}", "document hash"),
    }


def scan_clean(report, digest, now):
    if report.get("imageId", {}).get("imageDigest") != digest:
        raise ValueError("scan digest mismatch")
    status = report.get("imageScanStatus", {}).get("status")
    if status == "IN_PROGRESS":
        return False
    if status != "COMPLETE":
        raise ValueError("basic image scan is not complete")
    findings = report.get("imageScanFindings", {})
    # Refuse stale or missing results, including reruns of an existing immutable tag.
    for key in ("imageScanCompletedAt", "vulnerabilitySourceUpdatedAt"):
        stamp = datetime.fromisoformat(str(findings.get(key, "")).replace("Z", "+00:00"))
        if stamp.tzinfo is None or not 0 <= (now - stamp).total_seconds() <= 86400:
            raise ValueError("stale image scan")
    counts = findings.get("findingSeverityCounts")
    if not isinstance(counts, dict) or any(type(n) is not int or n < 0 for n in counts.values()):
        raise ValueError("missing or invalid scan counts")
    if any(counts.get(level, 0) for level in ("CRITICAL", "HIGH", "UNDEFINED")):
        raise ValueError("image scan gate failed")
    return True


def command_request(env, bundle, digest):
    cfg = config(env)
    action = checked(env.get("RELEASE_ACTION"), r"release|rollback", "action")
    revision = checked(env.get("SOURCE_SHA"), r"[0-9a-f]{40}", "source SHA")
    checked(bundle, r"[0-9a-f]{64}", "bundle hash")
    if action == "release":
        checked(digest, r"sha256:[0-9a-f]{64}", "image digest")
    elif digest != "previous":
        raise ValueError("rollback uses stored previous release only")
    return {
        "DocumentName": f"arn:aws:ssm:{REGION}:{cfg['account']}:document/{DOCUMENT}",
        "DocumentVersion": cfg["version"], "DocumentHash": cfg["hash"], "DocumentHashType": "Sha256",
        "InstanceIds": [cfg["instance"]], "TimeoutSeconds": 120,
        "MaxConcurrency": "1", "MaxErrors": "0",
        "Parameters": {"Action": [action], "Revision": [revision],
                       "Digest": [digest], "BundleSha256": [bundle]},
        "CloudWatchOutputConfig": {"CloudWatchOutputEnabled": False},
    }


def output(args):
    result = subprocess.run(args, capture_output=True, text=True, check=False)
    if result.returncode:
        # Never echo arbitrary CLI output, controller logs or credentials.
        raise RuntimeError("external command failed: " + args[0])
    return result.stdout.strip()


def aws(*args):
    return json.loads(output(["aws", *args, "--region", REGION, "--output", "json", "--no-cli-pager"]))


def check_source():
    main = output(["gh", "api", f"repos/{REPOSITORY}/git/ref/heads/main", "--jq", ".object.sha"])
    return source(os.environ, output(["git", "rev-parse", "HEAD"]), main)


def scan(digest):
    checked(digest, r"sha256:[0-9a-f]{64}", "image digest")
    for _ in range(60):
        report = aws("ecr", "describe-image-scan-findings", "--repository-name", "evn-marketing",
                     "--image-id", "imageDigest=" + digest)
        if scan_clean(report, digest, datetime.now(timezone.utc)):
            return
        time.sleep(10)
    raise RuntimeError("image scan timed out; nothing dispatched")


def dispatch(digest):
    request = command_request(os.environ, bundle_hash(ROOT), digest)
    if os.environ["RELEASE_ACTION"] == "release":
        actual = aws("ecr", "describe-images", "--repository-name", "evn-marketing",
                     "--image-ids", "imageTag=" + os.environ["SOURCE_SHA"])["imageDetails"]
        if len(actual) != 1 or actual[0]["imageDigest"] != digest:
            raise ValueError("source tag no longer matches digest")
        scan(digest)
    # Recheck main after the build, scan and approval delay, immediately before dispatch.
    check_source()
    # No send retry: a lost response can mean the command is already running.
    command = aws("ssm", "send-command", "--cli-input-json", json.dumps(request))["Command"]["CommandId"]
    checked(command, r"[0-9a-f-]{36}", "command ID")
    print("SSM command " + command, flush=True)
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
        summary.write(f"Action: {os.environ['RELEASE_ACTION']}\n\nSource: {os.environ['SOURCE_SHA']}\n\n"
                      f"Image: {digest}\n\nController bundle: {request['Parameters']['BundleSha256'][0]}\n\n"
                      f"SSM command: {command}\n")
    # Only status/code are requested. Remote stdout/stderr never enter CI logs/artifacts.
    for _ in range(390):
        result = subprocess.run([
            "aws", "ssm", "get-command-invocation", "--command-id", command,
            "--instance-id", request["InstanceIds"][0], "--region", REGION,
            "--query", "{Status:Status,ResponseCode:ResponseCode}", "--output", "json", "--no-cli-pager",
        ], capture_output=True, text=True, check=False)
        if result.returncode:
            if "InvocationDoesNotExist" not in result.stderr:
                raise RuntimeError("cannot confirm SSM command; inspect command ID before retry")
        else:
            invocation = json.loads(result.stdout)
            if invocation.get("Status") == "Success" and invocation.get("ResponseCode") == 0:
                print("SSM command succeeded; operational acceptance remains separate")
                return
            if invocation.get("Status") not in ("Pending", "InProgress", "Delayed"):
                raise RuntimeError("SSM command did not succeed; inspect command ID before retry")
        time.sleep(10)
    raise RuntimeError("SSM status timeout; inspect command ID before retry")


def main():
    action = sys.argv[1]
    if action == "validate":
        check_source()
        config(os.environ)
        print("source and configuration validated; controller bundle " + bundle_hash(ROOT))
    elif action == "bundle-hash":
        print(bundle_hash(ROOT))
    elif action == "dispatch":
        dispatch(sys.argv[2])
    else:
        raise ValueError("unsupported helper action")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, RuntimeError, IndexError):
        sys.exit("Cloud release refused or unconfirmed. Inspect the recorded command ID before any retry.")
