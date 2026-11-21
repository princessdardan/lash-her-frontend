#!/usr/bin/env python3
"""Inspect media release bindings or publish one verified temporary session."""
import argparse
from datetime import datetime, timedelta, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile

import migrate

SERVICE = "community-media-worker"
OVERLAY = "compose.community-media.yaml"
FILES = ("media.json", OVERLAY, "media/worker-db.env", "media/db-ca.pem")
ROLE_NAMES = ("api", "worker")
SESSION_FIELDS = {"Version", "AccessKeyId", "SecretAccessKey", "SessionToken", "Expiration"}
MINIMUM_REMAINING = timedelta(minutes=10)


def settings(configuration, environment):
    path = configuration / "media.json"
    if not path.exists() and not path.is_symlink():
        return None
    raw = migrate.read_json(configuration, path.name)
    required = {"environment", "accountId", "region", "bucket", "databaseNetwork", "sessionsDirectory", "roles"}
    migrate.demand(isinstance(raw, dict) and set(raw) == required and raw["environment"] == environment
                   and environment in ("staging", "production"), "MEDIA_ENVIRONMENT_BINDING_REFUSED")
    account, region = raw["accountId"], raw["region"]
    migrate.demand(isinstance(account, str) and re.fullmatch(r"[0-9]{12}", account)
                   and isinstance(region, str) and re.fullmatch(r"[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+", region)
                   and raw["bucket"] == f"lash-community-{environment}-{account}-{region}"
                   and isinstance(raw["databaseNetwork"], str)
                   and re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,127}", raw["databaseNetwork"]),
                   "MEDIA_TARGET_BINDING_REFUSED")
    roles = raw["roles"]
    migrate.demand(isinstance(roles, dict) and set(roles) == set(ROLE_NAMES)
                   and all(isinstance(role, str) and re.fullmatch(
                       rf"arn:aws:iam::{account}:role/[A-Za-z0-9+=,.@_/-]+", role
                   ) for role in roles.values()) and roles["api"] != roles["worker"],
                   "MEDIA_ROLE_BINDING_REFUSED")
    loc = raw["sessionsDirectory"]
    migrate.demand(isinstance(loc, str) and re.fullmatch(r"/[A-Za-z0-9_/.-]+", loc)
                   and Path(loc).name == environment and ".." not in Path(loc).parts,
                   "MEDIA_SESSION_DIRECTORY_REFUSED")
    return raw


def pinned_inputs(release, configuration):
    values = settings(configuration, release["environment"])
    if values is None:
        migrate.demand(not os.path.lexists(configuration / OVERLAY), "MEDIA_OVERLAY_REQUIRES_BINDING")
        return None
    runtime = release.get("runtime", {})
    digest = runtime.get("communityMediaOverlaySha256")
    overlay = migrate.read_input(configuration, OVERLAY, 65_536)
    migrate.demand(migrate.digest(digest) and digest == "sha256:" + migrate.file_hash(overlay),
                   "PINNED_MEDIA_OVERLAY_REQUIRED")
    return values


def environment(settings_value, snapshot):
    if settings_value is None:
        return {}
    return {
        "COMMUNITY_MEDIA_BUCKET": settings_value["bucket"],
        "COMMUNITY_MEDIA_REGION": settings_value["region"],
        "COMMUNITY_MEDIA_DATABASE_NETWORK": settings_value["databaseNetwork"],
        "COMMUNITY_MEDIA_BINDINGS_DIR": str(snapshot / "media"),
        "COMMUNITY_MEDIA_SESSIONS_DIR": settings_value["sessionsDirectory"],
    }


def session_directory(values, role):
    migrate.demand(role in ROLE_NAMES, "MEDIA_SESSION_ROLE_REFUSED")
    base = Path(values["sessionsDirectory"])
    migrate.demand(base.resolve() == base and not any((d / ".git").exists() for d in (base, *base.parents)),
                   "MEDIA_SESSION_DIRECTORY_REFUSED")
    migrate.private_directory(base)
    directory = base / role
    info = directory.lstat()
    migrate.demand(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
                   and info.st_mode & 0o027 == 0, "MEDIA_SESSION_DIRECTORY_REFUSED")
    if os.getuid() == 0:
        migrate.demand(info.st_gid == 65532 and info.st_mode & 0o010 != 0,
                       "MEDIA_SESSION_CONTAINER_GROUP_REQUIRED")
    return directory


def expiration(value):
    try:
        if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z", value):
            raise ValueError()
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise ValueError("MEDIA_SESSION_EXPIRATION_REFUSED") from None


def validated_session(value, now, minimum=MINIMUM_REMAINING):
    migrate.demand(isinstance(value, dict) and set(value) == SESSION_FIELDS
                   and type(value["Version"]) is int and value["Version"] == 1
                   and all(isinstance(value[key], str) and 0 < len(value[key]) <= 8192
                           and re.fullmatch(r"[!-~]+", value[key])
                           for key in ("AccessKeyId", "SecretAccessKey", "SessionToken")),
                   "MEDIA_SESSION_FORMAT_REFUSED")
    expires = expiration(value["Expiration"])
    migrate.demand(expires > now + minimum, "MEDIA_SESSION_TOO_CLOSE_TO_EXPIRY")
    return expires


def session_value(directory):
    info = (directory / "session.json").lstat()
    migrate.demand(info.st_uid == os.getuid() and info.st_mode & 0o037 == 0
                   and (os.getuid() != 0 or (info.st_gid == 65532 and info.st_mode & 0o040)),
                   "MEDIA_SESSION_FILE_PERMISSIONS_REFUSED")
    return json.loads(migrate.read_input(directory, "session.json", 16_384))


def preflight_sessions(values, now=None):
    now = now or datetime.now(timezone.utc)
    credentials = [session_value(session_directory(values, role)) for role in ROLE_NAMES]
    for credential in credentials:
        validated_session(credential, now)
    migrate.demand(credentials[0]["AccessKeyId"] != credentials[1]["AccessKeyId"], "MEDIA_SESSION_ROLE_COLLISION")


def publish_session(values, role, issued, now=None):
    """The trusted issuer supplies the verified role ARN with its session."""
    now = now or datetime.now(timezone.utc)
    directory = session_directory(values, role)
    migrate.demand(isinstance(issued, dict) and set(issued) == {"roleArn", "session"}
                   and issued["roleArn"] == values["roles"][role], "MEDIA_ISSUER_ROLE_REFUSED")
    session = issued["session"]
    expires = validated_session(session, now)
    payload = (json.dumps(session, separators=(",", ":")) + "\n").encode()
    migrate.demand(len(payload) <= 16_384, "MEDIA_SESSION_FORMAT_REFUSED")
    with os.fdopen(os.open(directory / ".publish.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600), "w") as lock:
        migrate.demand(stat.S_ISREG(os.fstat(lock.fileno()).st_mode), "MEDIA_SESSION_LOCK_REFUSED")
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = directory / "session.json"
        if os.path.lexists(path):
            current = session_value(directory)
            if current == session:
                return expires
            migrate.demand(expires > expiration(current["Expiration"]), "MEDIA_STALE_SESSION_REFUSED")
        fd, temporary = tempfile.mkstemp(prefix=".session-", dir=directory)
        try:
            with os.fdopen(fd, "wb") as stream:
                if os.getuid() == 0:
                    os.fchown(stream.fileno(), 0, 65532)
                os.fchmod(stream.fileno(), 0o440)
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
            directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            Path(temporary).unlink(missing_ok=True)
        return expires


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("configuration", type=Path)
    parser.add_argument("environment", choices=("staging", "production"))
    parser.add_argument("role", choices=ROLE_NAMES)
    args = parser.parse_args()
    try:
        migrate.private_directory(args.configuration)
        values = settings(args.configuration, args.environment)
        migrate.demand(values is not None, "MEDIA_BINDING_REQUIRED")
        raw = sys.stdin.buffer.read(20_001)
        migrate.demand(len(raw) <= 20_000, "MEDIA_SESSION_FORMAT_REFUSED")
        expires = publish_session(values, args.role, json.loads(raw))
        print(json.dumps({"role": args.role, "expiresAt": expires.isoformat()}))
    except (OSError, ValueError, KeyError, TypeError):
        print("Community media session publication failed.", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
