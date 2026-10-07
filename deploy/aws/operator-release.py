"""Local, explicit release entrypoint. Only publish writes ECR."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

try:
    from . import release
except ImportError:
    import release


ROOT = Path(__file__).resolve().parents[2]
CONFIG_KEYS = {
    "AWS_PROFILE", "MARKETING_AWS_ACCOUNT_ID", "MARKETING_INSTANCE_ID",
    "MARKETING_DEPLOYER_ARN", "MARKETING_SSM_DOCUMENT_VERSION",
    "MARKETING_SSM_DOCUMENT_SHA256",
}


class MissingImageError(RuntimeError):
    pass


def load_config(path):
    def unique(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError("duplicate config key: " + key)
            value[key] = item
        return value

    data = json.loads(Path(path).read_text(), object_pairs_hook=unique)
    if not isinstance(data, dict) or set(data) != CONFIG_KEYS:
        raise ValueError("config must contain exactly: " + ", ".join(sorted(CONFIG_KEYS)))
    if not all(isinstance(value, str) and value for value in data.values()):
        raise ValueError("config values must be non-empty strings")
    return data


def run(args, *, env=None):
    result = subprocess.run(args, cwd=ROOT, capture_output=True, text=True, check=False, env=env)
    if result.returncode:
        raise RuntimeError("external command failed: " + args[0])
    return result.stdout.strip()


def require_pr_checks(revision):
    pulls = json.loads(run([
        "gh", "api", "-H", "Accept: application/vnd.github+json",
        f"repos/{release.REPOSITORY}/commits/{revision}/pulls",
    ]))
    matches = [pr for pr in pulls if pr.get("merged_at") and pr.get("merge_commit_sha") == revision
               and pr.get("base", {}).get("ref") == "main"
               and release.checked(pr.get("head", {}).get("sha"), r"[0-9a-f]{40}", "PR head SHA")]
    if len(matches) != 1:
        raise ValueError("current main must resolve to exactly one merged PR")
    pull = matches[0]
    checks = json.loads(run(["gh", "pr", "checks", str(matches[0]["number"]), "--repo",
                             release.REPOSITORY, "--json", "name,bucket,workflow"]))
    if not checks or any(check.get("bucket") not in ("pass", "skipping") for check in checks):
        raise ValueError("merged PR checks are missing, pending or unsuccessful")
    head = pull["head"]["sha"]
    runs = json.loads(run(["gh", "run", "list", "--repo", release.REPOSITORY, "--workflow", "pr.yml",
                           "--commit", head, "--event", "pull_request", "--json",
                           "databaseId,headSha,status,conclusion", "--limit", "100"]))
    actual = [item for item in runs if item.get("headSha") == head and item.get("conclusion") != "skipped"]
    if not actual or actual[0].get("status") != "completed" or actual[0].get("conclusion") != "success":
        raise ValueError("latest PR verification run is missing, pending or unsuccessful")
    details = json.loads(run(["gh", "run", "view", str(actual[0]["databaseId"]), "--repo",
                              release.REPOSITORY, "--json", "jobs"]))
    jobs = details.get("jobs", [])
    if not any(job.get("name") == "verify" and job.get("status") == "completed"
               and job.get("conclusion") == "success" for job in jobs):
        raise ValueError("successful PR verification job is missing")


def configure(path, action):
    os.environ.update(load_config(path), RELEASE_ACTION=action)
    head = release.checked(run(["git", "rev-parse", "HEAD"]), r"[0-9a-f]{40}", "source SHA")
    os.environ["SOURCE_SHA"] = head
    revision = release.check_source(manual=True)
    require_pr_checks(revision)
    return revision


def image_digest(revision, *, missing_ok=False):
    result = subprocess.run([
        "aws", "ecr", "describe-images", "--repository-name", "evn-marketing",
        "--image-ids", "imageTag=" + revision, "--region", release.REGION,
        "--output", "json", "--no-cli-pager",
    ], cwd=ROOT, capture_output=True, text=True, check=False)
    if result.returncode:
        if "ImageNotFoundException" in result.stderr:
            if missing_ok:
                return None
            raise MissingImageError("source image is absent; run publish first")
        raise RuntimeError("cannot determine source image state")
    images = json.loads(result.stdout).get("imageDetails", [])
    if len(images) != 1:
        raise RuntimeError("source image lookup returned an unexpected result")
    return release.checked(images[0].get("imageDigest"), r"sha256:[0-9a-f]{64}", "image digest")


def validate_publish_target():
    release.check_manual_target()
    repositories = release.aws("ecr", "describe-repositories", "--repository-names", "evn-marketing")["repositories"]
    if len(repositories) != 1 or repositories[0].get("imageTagMutability") != "IMMUTABLE":
        raise ValueError("Marketing image tags must be immutable")


def publish_image(revision, target="runtime"):
    if target not in ("runtime", "operations"):
        raise ValueError("unsupported image target")
    validate_publish_target()
    tag = revision if target == "runtime" else revision + "-ops"
    digest = image_digest(tag, missing_ok=True)
    if digest:
        return digest
    if not shutil.which("docker-credential-ecr-login"):
        raise RuntimeError("docker-credential-ecr-login is required")
    registry = f"{os.environ['MARKETING_AWS_ACCOUNT_ID']}.dkr.ecr.{release.REGION}.amazonaws.com"
    image = f"{registry}/evn-marketing:{tag}"
    archive = subprocess.run(["git", "archive", "--format=tar", revision], cwd=ROOT,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False)
    if archive.returncode:
        raise RuntimeError("cannot archive the pinned source")
    build = subprocess.run(["docker", "build", "--platform", "linux/amd64", "--provenance=false", "--target", target, "--build-arg",
                            "MARKETING_BUILD_REVISION=" + revision, "--label",
                            "org.opencontainers.image.revision=" + revision, "--label",
                            "org.opencontainers.image.source=https://github.com/" + release.REPOSITORY,
                            "-t", image, "-"], cwd=ROOT, input=archive.stdout,
                           capture_output=True, check=False)
    if build.returncode:
        raise RuntimeError("external command failed: docker")
    release.check_source(manual=True)
    release.check_manual_target()
    with tempfile.TemporaryDirectory(prefix="marketing-docker-") as directory:
        Path(directory, "config.json").write_text(json.dumps({"credHelpers": {registry: "ecr-login"}}) + "\n")
        run(["docker", "push", image], env={**os.environ, "DOCKER_CONFIG": directory,
                                             "AWS_ECR_DISABLE_CACHE": "true"})
    return image_digest(tag)


def execute(command, config):
    action = "rollback" if command == "rollback" else "release"
    revision = configure(config, action)
    if command == "rollback":
        release.dispatch("previous", manual=True)
        return
    run(["npm", "audit", "--omit=dev", "--audit-level=high"])
    if command == "publish-ops":
        digest = publish_image(revision, target="operations")
        release.scan(digest)
        release.check_source(manual=True)
        release.check_manual_target()
        print(json.dumps({"revision": revision, "operationsDigest": digest, "deployed": False}))
        return
    if command == "publish":
        digest = publish_image(revision)
        release.prepare_request(digest, manual=True)
        print("Published and validated " + digest)
        return
    digest = image_digest(revision)
    if command == "check":
        request = release.prepare_request(digest, manual=True)
        print(json.dumps({name: values[0] for name, values in request["Parameters"].items()}))
    else:
        release.dispatch(digest, manual=True)


def parser():
    value = argparse.ArgumentParser(description="EV&Marketing local deployment operator")
    commands = value.add_subparsers(dest="command")
    for name in ("check", "publish", "publish-ops", "release", "rollback"):
        command = commands.add_parser(name)
        command.add_argument("--config", required=True, help="nonsecret operator JSON config")
    return value


def main(argv=None):
    arguments = parser().parse_args(argv)
    if not arguments.command:
        parser().print_help()
        return
    execute(arguments.command, arguments.config)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, RuntimeError, json.JSONDecodeError) as error:
        raise SystemExit("Operator refused: " + str(error))
