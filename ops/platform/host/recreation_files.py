"""Bounded private staging handoff and exact action-receipt retrieval.

No archive extraction, shell, database or provider operation. Private material
is written only below a fresh action's inputs directory. Export has a separate
fixed JSON-receipt allowlist and cannot retrieve configuration, keys or errors.
"""
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import sys

import migrate
import runtime_actions
import staging_state

demand = migrate.demand
ROOT = Path("/var/lib/lash-her/releases/staging")
INPUT_FIXED = {"compose.yaml", "inventory/mux-inventory.json", "compatibility/compatible.candidate.json",
    "compatibility/compatibility-proof.json", "programs/staging-fixture-operator.mjs", "programs/staging-work-operator.mjs",
    "bundle/build.candidate.json", "bundle/release.candidate.json", "database-receipts/candidate.json",
    "database-receipts/migration-outcome.json", "runtime-receipts/runtime-outcome.json",
    "retirement/retirement-outcome.json", "retirement/pending-work/retained-work.json", "retirement/pending-work/business-baseline.json",
    "maintenance/private-ca/ca.pem", "maintenance/private-ca/ca.key", "maintenance/certificates-staging.json",
    *("configuration/" + name for name in staging_state.CONFIGURATION_FILES),
    *("bundle/" + kind + "/" + name + ".json" for kind in ("jobs", "schema") for name in ("frontend", "course", "community")),
    *("database-receipts/" + name + "/" + file for name in ("frontend", "course", "community")
      for file in ("database-receipt.json", "job-outcome.json"))}
RECEIPTS = {
    "cold-restore": ("cold-restore-started.json", "cold-restore-outcome.json", "runtime-outcome.json", "configuration-binding.json", "runtime-binding.json",
        "database-current/current-databases-outcome.json",
        *("database-current/" + name + "/database-receipt.json" for name in ("frontend", "course", "community"))),
    "prepare-bootstrap": ("preparation-outcome.json", "bootstrap-started.json"),
    "prepare-cache-compatible": ("preparation-outcome.json", "image-cache-outcome.json"),
    "prepare-cache-current": ("preparation-outcome.json", "image-cache-outcome.json"),
    "maintenance-install": ("maintenance-outcome.json", "maintenance-install-started.json"),
    "maintenance-activate": ("maintenance-outcome.json", "maintenance-activation-started.json"),
    "rollback": ("rollback-outcome.json", "restored-current/runtime-outcome.json", "restored-current/round-outcome.json",
                 "compatible-previous/compatible-runtime-outcome.json", "compatible-previous/graceful-stop.json"),
    "retirement": ("retirement-outcome.json", "pending-work/retained-work.json", "pending-work/business-baseline.json",
                   "pending-work/fixture-outcome.json", "pending-work/retained-work-outcome.json"),
    "restore": ("restore-outcome.json", "runtime-outcome.json", "business-preservation.json", "configuration-binding.json",
                "publisher-checkpoint/durable-recovery.json", "database-current/current-databases-outcome.json",
                *("database-current/" + name + "/database-receipt.json" for name in ("frontend", "course", "community")),
                "native-qualification/qualification-outcome.json", "native-qualification/native-window-outcome.json",
                "native-qualification/cron-scope-outcome.json", "native-qualification/native-window-started.json",
                "native-qualification/frontend/frontend-build-outcome.json",
                "native-qualification/frontend/frontend-probe-started.json",
                "native-qualification/frontend/frontend-probe-preparation.json",
                "native-qualification/frontend/frontend-workload-outcome.json",
                "native-qualification/frontend/frontend-promotion-outcome.json")}


def action_root(action):
    demand(isinstance(action, str) and re.fullmatch(r"p1-recreate-[a-z0-9][a-z0-9-]{0,24}", action), "RECREATION_FILES_ACTION_REQUIRED")
    demand(not any(p.is_symlink() for p in (ROOT, *ROOT.parents)), "RECREATION_FILES_CANONICAL_ROOT_REQUIRED")
    target = ROOT / action
    demand(not target.is_symlink(), "RECREATION_FILES_ACTION_SYMLINK_REFUSED")
    return target


def safe_name(name):
    demand(isinstance(name, str) and 0 < len(name) <= 500 and "\\" not in name and "\x00" not in name,
           "RECREATION_FILES_RELATIVE_NAME_REQUIRED")
    path = PurePosixPath(name)
    demand(not path.is_absolute() and ".." not in path.parts and str(path) == name, "RECREATION_FILES_RELATIVE_NAME_REQUIRED")
    return path


def private_parents(path):
    """mkdir(parents=True) does not apply mode to intermediate directories."""
    missing, parent = [], path.parent
    while not parent.exists():
        demand(not parent.is_symlink(), "RECREATION_FILES_PARENT_SYMLINK_REFUSED")
        missing.append(parent); parent = parent.parent
    for directory in reversed(missing):
        directory.mkdir(mode=0o700)


def validate_inputs(value):
    """Validate privately in memory, without creating an action or input file."""
    files = value.get("files")
    demand(isinstance(files, list) and 1 <= len(files) <= 100, "RECREATION_FILES_BOUNDED_INPUTS_REQUIRED")
    verified, seen, total, acme = [], set(), 0, 0
    for item in files:
        demand(isinstance(item, dict) and set(item) == {"path", "sha256", "data"}, "RECREATION_FILES_TYPED_INPUT_REQUIRED")
        name = item["path"]; safe_name(name)
        demand(name not in seen and (name in INPUT_FIXED or name.startswith("maintenance/acme-staging/")), "RECREATION_FILES_ALLOWED_INPUT_REQUIRED")
        if name.startswith("maintenance/acme-staging/"):
            acme += 1
            demand(name.endswith((".key", ".crt", ".json", ".pem")) and acme <= 8, "RECREATION_FILES_ACME_SCOPE_REQUIRED")
        raw = base64.b64decode(item["data"], validate=True)
        total += len(raw)
        demand(len(raw) <= 2_000_000 and total <= 16_000_000 and hashlib.sha256(raw).hexdigest() == item["sha256"], "RECREATION_FILES_INPUT_HASH_REQUIRED")
        verified.append((name, raw)); seen.add(name)
    manifest = {item["path"]: item["sha256"] for item in files}
    canonical = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
    demand(hashlib.sha256(canonical).hexdigest() == value.get("manifestSha256"), "RECREATION_FILES_REVIEWED_MANIFEST_REQUIRED")
    return verified


def stage(value):
    root = action_root(value["action"])
    verified = validate_inputs(value)
    destination = root / "inputs"
    demand(not root.exists(), "RECREATION_FILES_EXCLUSIVE_ACTION_REQUIRED")
    # Validate the full payload before creating anything. An interrupted copy
    # leaves its exclusive directory for review, never automatic overwrite.
    private_parents(root)
    root.mkdir(mode=0o700)
    destination.mkdir(mode=0o700)
    migrate.write_json(root, "handoff-started.json", {"manifestSha256": value["manifestSha256"], "files": len(verified), "credentialsDisplayed": False})
    for name, raw in verified:
        target = destination / name
        private_parents(target)
        fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(raw)
    return {"status": "RECREATION_PRIVATE_INPUTS_STAGED", "manifestSha256": value["manifestSha256"],
            "files": len(verified), "inputValuesDisplayed": False}


def receipts(value):
    root = action_root(value["action"])
    phase = value.get("phase")
    demand(phase in RECEIPTS, "RECREATION_FILES_FIXED_RECEIPT_PHASE_REQUIRED")
    directory = root / phase
    staging_state.outside_checkout(directory)
    records, total = [], 0
    for name in RECEIPTS[phase]:
        path = directory / name
        demand(not any(p.is_symlink() for p in (path, *path.parents)), "RECREATION_FILES_RECEIPT_SYMLINK_REFUSED")
        if not path.exists():
            continue
        raw = migrate.read_input(directory, name, 2_000_000)
        demand(isinstance(json.loads(raw), dict), "RECREATION_FILES_JSON_RECEIPT_REQUIRED")
        total += len(raw)
        demand(total <= 10_000_000, "RECREATION_FILES_EXPORT_BOUND_REQUIRED")
        records.append({"path": name, "sha256": hashlib.sha256(raw).hexdigest(), "data": base64.b64encode(raw).decode()})
    demand(any(r["path"] == RECEIPTS[phase][0] for r in records), "RECREATION_FILES_TERMINAL_OUTCOME_REQUIRED")
    # Only the trusted local parent receives this private stdout. It must save
    # these files outside Git and print no decoded fields or data blobs.
    return {"status": "RECREATION_EXACT_PRIVATE_RECEIPTS", "phase": phase, "files": records}


def main():
    try:
        demand(os.geteuid() == 0 and sys.platform == "linux", "RECREATION_FILES_ROOT_LINUX_REQUIRED")
        raw = sys.stdin.buffer.read(24_000_001)
        demand(len(raw) <= 24_000_000, "RECREATION_FILES_PAYLOAD_TOO_LARGE")
        value = json.loads(raw)
        demand(value.get("version") == 1 and value.get("operation") in ("stage", "receipts"), "RECREATION_FILES_FIXED_OPERATION_REQUIRED")
        print(json.dumps(stage(value) if value["operation"] == "stage" else receipts(value)))
    except BaseException as error:
        print(json.dumps({"status": "RECREATION_FILES_REQUIRES_REVIEW", "failureCode": runtime_actions.safe_code(error)}), file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
