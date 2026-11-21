"""Prepare disposable certificates or probe the isolated issuer after stack approval."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
from secrets import token_hex
import subprocess

ACCOUNT = "691588646557"
REGION = "us-east-1"
ROLE_SLOTS = ("api", "worker")
SCOPE = re.compile(r"p503-check-[0-9a-f]{8}")


def run(arguments, env=None):
    return subprocess.run(arguments, env=env, capture_output=True, check=False, timeout=45)


def required(result, error):
    if result.returncode:
        raise ValueError(error)
    return result.stdout


def prepare(directory):
    directory.mkdir(mode=0o700)
    scope = "p503-check-" + token_hex(4)
    params = {"Scope": scope}
    fingerprints = {}
    for role in ROLE_SLOTS:
        slot = directory / role
        slot.mkdir(mode=0o700)
        cn = scope + "-" + role
        ca, ca_key = slot / "ca.pem", slot / "ca.key"
        request, key, certificate = slot / "leaf.csr", slot / "leaf.key", slot / "leaf.pem"
        extensions = slot / "leaf.cnf"
        extensions.write_text("basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n")
        required(run(["openssl", "req", "-new", "-x509", "-nodes", "-newkey", "rsa:2048", "-days", "2",
                      "-subj", f"/CN={cn}-root", "-keyout", ca_key, "-out", ca,
                      "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
                      "-addext", "keyUsage=critical,keyCertSign,cRLSign"]), "CA_GENERATION_FAILED")
        try:
            required(run(["openssl", "req", "-new", "-nodes", "-newkey", "rsa:2048",
                          "-subj", f"/CN={cn}", "-keyout", key, "-out", request]), "LEAF_GENERATION_FAILED")
            required(run(["openssl", "x509", "-req", "-in", request, "-CA", ca, "-CAkey", ca_key,
                          "-set_serial", "0x" + token_hex(16), "-days", "1",
                          "-extfile", extensions, "-out", certificate]), "LEAF_SIGNING_FAILED")
        finally:
            ca_key.unlink(missing_ok=True)
            request.unlink(missing_ok=True)
            extensions.unlink(missing_ok=True)
        params[role.capitalize() + "Ca"] = ca.read_text()
        fingerprints[role] = hashlib.sha256(
            required(run(["openssl", "x509", "-in", ca, "-outform", "DER"]), "CA_ENCODING_FAILED")
        ).hexdigest()
    for role, opposite in (("api", "worker"), ("worker", "api")):
        required(run(["openssl", "verify", "-CAfile", directory / role / "ca.pem",
                      directory / role / "leaf.pem"]), "ASSIGNED_CERTIFICATE_CHAIN_REFUSED")
        crossed = run(["openssl", "verify", "-CAfile", directory / opposite / "ca.pem",
                       directory / role / "leaf.pem"])
        if crossed.returncode == 0:
            raise ValueError("CROSS_ROLE_CERTIFICATE_ACCEPTED")
    (directory / "parameters.json").write_text(json.dumps([
        {"ParameterKey": key, "ParameterValue": value} for key, value in params.items()
    ], indent=2) + "\n")
    return {"scope": scope, "account": ACCOUNT, "region": REGION, "caFingerprints": fingerprints,
            "localCertificateIsolationVerified": True}


def bindings(output):
    scope = output["Scope"]
    if not SCOPE.fullmatch(scope):
        raise ValueError("QUALIFICATION_SCOPE_REQUIRED")
    slots = {}
    for role in ROLE_SLOTS:
        prefix = role.capitalize()
        names = {
            "anchor": output[prefix + "AnchorArn"],
            "profile": output[prefix + "ProfileArn"],
            "issuer": output[prefix + "IssuerArn"],
            "target": output[prefix + "TargetArn"],
        }
        ra = f"arn:aws:rolesanywhere:{REGION}:{ACCOUNT}:"
        iam = f"arn:aws:iam::{ACCOUNT}:role/p503-issuer-qualification/{scope}-{role}-"
        if not (re.fullmatch(ra + r"trust-anchor/[0-9a-f-]{36}", names["anchor"])
                and re.fullmatch(ra + r"profile/[0-9a-f-]{36}", names["profile"])
                and names["issuer"] == iam + "issuer" and names["target"] == iam + "target"):
            raise ValueError("QUALIFICATION_EXACT_ACCOUNT_AND_ROLES_REQUIRED")
        slots[role] = names
    if any(slots["api"][key] == slots["worker"][key] for key in slots["api"]):
        raise ValueError("QUALIFICATION_ROLES_MUST_BE_DISTINCT")
    return scope, slots


def sts(arguments, session):
    env = {name: os.environ[name] for name in ("PATH", "HOME", "TMPDIR") if name in os.environ}
    env.update(AWS_ACCESS_KEY_ID=session["AccessKeyId"],
               AWS_SECRET_ACCESS_KEY=session["SecretAccessKey"], AWS_SESSION_TOKEN=session["SessionToken"],
               AWS_CONFIG_FILE=os.devnull, AWS_SHARED_CREDENTIALS_FILE=os.devnull,
               AWS_IGNORE_CONFIGURED_ENDPOINT_URLS="true", AWS_EC2_METADATA_DISABLED="true",
               AWS_CLI_AUTO_PROMPT="off", LANG="C")
    return run(["aws", "--region", REGION, "--no-cli-pager", "--output", "json", "sts", *arguments], env)


def check_identity(session, role_arn):
    identity = json.loads(required(sts(["get-caller-identity"], session), "ISSUED_STS_SESSION_REFUSED"))
    role = role_arn.rsplit("/", 1)[-1]
    if identity["Account"] != ACCOUNT or not re.fullmatch(
        rf"arn:aws:sts::{ACCOUNT}:assumed-role/{re.escape(role)}/[A-Za-z0-9+=,.@_-]+", identity["Arn"]
    ):
        raise ValueError("ISSUED_STS_ROLE_MISMATCH")
    return identity["Arn"]


def verify(directory, output, helper):
    scope, slots = bindings(output)
    local_parameters = {entry["ParameterKey"]: entry["ParameterValue"]
                        for entry in json.loads((directory / "parameters.json").read_text())}
    if local_parameters["Scope"] != scope:
        raise ValueError("QUALIFICATION_CERTIFICATE_SCOPE_MISMATCH")
    evidence = {}
    for role, opposite in (("api", "worker"), ("worker", "api")):
        names = slots[role]
        workload = directory / role
        base_env = {name: os.environ[name] for name in ("PATH", "HOME", "TMPDIR") if name in os.environ}
        source = json.loads(required(run([helper, "credential-process", "--certificate", workload / "leaf.pem",
                                          "--private-key", workload / "leaf.key", "--trust-anchor-arn", names["anchor"],
                                          "--profile-arn", names["profile"], "--role-arn", names["issuer"],
                                          "--session-duration", "900"], base_env), "WORKLOAD_CERTIFICATE_ISSUE_FAILED"))
        issuer = check_identity(source, names["issuer"])
        params = ["assume-role", "--role-session-name", f"{scope}-{role}", "--duration-seconds", "900", "--role-arn"]
        target = json.loads(required(sts([*params, names["target"]], source), "ASSIGNED_TARGET_REFUSED"))
        target_identity = check_identity(target["Credentials"], names["target"])
        expires = datetime.fromisoformat(target["Credentials"]["Expiration"].replace("Z", "+00:00"))
        if target["SourceIdentity"] != f"CN={scope}-{role}" or expires <= datetime.now(timezone.utc):
            raise ValueError("ISSUED_SESSION_SOURCE_IDENTITY_OR_EXPIRY_REFUSED")
        denied = sts([*params, slots[opposite]["target"]], source)
        if denied.returncode == 0 or b"(AccessDenied)" not in denied.stderr:
            raise ValueError("OPPOSITE_TARGET_NOT_EXPLICITLY_DENIED")
        evidence[role] = {"issuer": issuer, "target": target_identity, "expiresAt": expires.isoformat(),
                          "oppositeTargetDenied": True}
    return {"scope": scope, "account": ACCOUNT, "region": REGION, "issuers": evidence}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)
    for command in ("prepare", "verify"):
        subparser = subcommands.add_parser(command)
        subparser.add_argument("directory", type=Path)
        if command == "verify":
            subparser.add_argument("outputs", type=Path)
            subparser.add_argument("helper", type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        result = prepare(args.directory) if args.command == "prepare" else verify(
            args.directory, json.loads(args.outputs.read_text()), args.helper.resolve(strict=True)
        )
        print(json.dumps(result, indent=2))
    except (OSError, subprocess.TimeoutExpired, ValueError, KeyError, TypeError) as error:
        # Subprocesses return credentials in memory. Only explicit failure codes can reach output.
        code = str(error)
        parser.exit(1, (code if re.fullmatch(r"[A-Z][A-Z_]+", code) else "ISSUER_QUALIFICATION_REFUSED") + "\n")


if __name__ == "__main__":
    main()
