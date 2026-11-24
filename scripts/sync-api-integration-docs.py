#!/usr/bin/env python3
"""Keep the local Lash Her integration plan and execution tracker current."""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import time

PLAN = "API-INTEGRATION-PLAN.md"
TRACKER = "API-INTEGRATION-EXECUTION.md"
REPOS = ("lash-her-frontend", "lash-her-course-api", "lash-her-community-api")


def git(repo, *args, input_text=None, check=True, timeout=30):
    result = subprocess.run(
        ["/usr/bin/git", "-C", repo, *args],
        input=input_text,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
        timeout=timeout,
    )
    if result.returncode and check:
        raise RuntimeError(f"{repo.name}: git {args[0]}: {result.stderr.strip()}")
    return result


def blob(repo, ref, name):
    result = git(repo, "show", f"{ref}:{name}", check=False)
    return result.stdout if result.returncode == 0 else None


def write_atomic(path, text):
    if path.is_symlink():
        raise RuntimeError(f"Refusing to replace symlink {path}")
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o600
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=path.parent, delete=False
    ) as file:
        temp = Path(file.name)
        try:
            file.write(text)
            file.flush()
            os.chmod(temp, mode)
            os.replace(temp, path)
        finally:
            temp.unlink(missing_ok=True)


def checkout_heads(repo):
    output = git(repo, "worktree", "list", "--porcelain", "-z").stdout
    heads = {}
    for record in output.split("\0\0"):
        fields = record.split("\0")
        if len(fields) >= 2 and fields[1].startswith("HEAD "):
            heads[fields[0][9:]] = fields[1][5:]
    return heads


def snapshot(repo, names):
    heads = checkout_heads(repo)
    refs = git(repo, "for-each-ref", "--format=%(objectname)", "refs/heads", "refs/remotes")
    tips = sorted(set(refs.stdout.splitlines()) | set(heads.values()))
    files = {}
    for directory, head in heads.items():
        for name in names:
            path = Path(directory) / name
            if path.is_file() and not path.is_symlink():
                files[str(path)] = (head, path.read_text(encoding="utf-8"))
    return tips, files


def draft_changes(repo, files, previous):
    linked = [(path, head, text) for path, (head, text) in files.items()
              if Path(path).parent != repo]
    queries = [f"{head}:{Path(path).name}" for path, head, _ in linked]
    objects = git(repo, "cat-file", "--batch-check=%(objectname)",
                  input_text="\n".join(queries) + "\n").stdout.splitlines()
    drafts = {}
    changes = []
    for (path, head, text), object_id in zip(linked, objects):
        data = text.encode("utf-8")
        if object_id == hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest():
            continue
        name = Path(path).name
        base = blob(repo, head, name)
        if base is None:
            continue
        old_head, old_text = previous.get(path, (None, None))
        if old_head == head:
            base = old_text
        drafts[path] = [head, text]
        if base != text:
            changes.append([f"save {path} [{hashlib.sha256(data).hexdigest()[:12]}]",
                            name, base, text])
    return drafts, changes


def committed_changes(repo, names, tips, previous):
    if set(tips).issubset(previous):
        return []
    # Exclude all previously observed history, even when a ref moved backward.
    revisions = tips + [f"^{value}" for value in previous]
    output = git(repo, "rev-list", "--ignore-missing", "--full-history", "--topo-order", "--reverse",
                 "--stdin", "--", *names, input_text="\n".join(revisions) + "\n")
    changes = []
    for commit in output.stdout.splitlines():
        parents = git(repo, "show", "-s", "--format=%P", commit).stdout.split()
        for name in names:
            after = blob(repo, commit, name)
            before = [blob(repo, parent, name) for parent in parents]
            if after is not None and before and before[0] is not None and after not in before:
                changes.append([f"{repo.name} {commit}", name, before[0], after])
    return changes


def merge(current, base, incoming):
    if current == incoming or base == incoming:
        return current
    if current == base:
        return incoming
    with tempfile.TemporaryDirectory() as temporary:
        paths = [Path(temporary) / name for name in ("local", "base", "incoming")]
        for path, content in zip(paths, (current, base, incoming)):
            path.write_text(content, encoding="utf-8")
        result = git(Path(temporary), "merge-file", "-p", *paths, check=False)
    if result.returncode > 0 and not result.stderr:
        return None
    if result.returncode:
        raise RuntimeError(f"git merge-file: {result.stderr.strip()}")
    return result.stdout


def fetch_if_due(repos, state_dir):
    marker = state_dir / "last-fetch"
    if marker.exists() and time.time() - marker.stat().st_mtime < 300:
        return
    marker.touch()
    os.environ["GIT_TERMINAL_PROMPT"] = "0"
    for repo in repos:
        try:
            git(repo, "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin")
        except (RuntimeError, subprocess.TimeoutExpired) as error:
            print(f"Fetch deferred: {error}", flush=True)


def sync(workspace, state_dir, fetch, acknowledge):
    repos = [workspace / name for name in REPOS]
    state_file = state_dir / "state.json"
    initializing = not state_file.exists()
    state = json.loads(state_file.read_text(encoding="utf-8")) if not initializing else {
        "docs": {}, "heads": {}, "tips": {}, "drafts": {}, "pending": [],
    }
    if fetch and not initializing:
        fetch_if_due(repos, state_dir)
    acknowledged = set(acknowledge)
    changes = [item for item in state["pending"] if item[0] not in acknowledged]
    prior_sources = {item[0] for item in state["pending"]}
    pending = []
    blocked_roots = set()
    roots = {}
    docs = {}
    for repo in repos:
        names = (PLAN, TRACKER) if repo == repos[0] else (PLAN,)
        tips, files = snapshot(repo, names)
        drafts, edits = draft_changes(repo, files, state["drafts"].get(repo.name, {}))
        if not initializing:
            changes.extend(committed_changes(repo, names, tips, state["tips"][repo.name]))
            changes.extend(edits)
        state["tips"][repo.name] = sorted(set(tips) | set(state["tips"].get(repo.name, [])))
        state["drafts"][repo.name] = drafts
        for name in names:
            path = str(repo / name)
            head, content = files[path]
            roots[path] = content
            base = state["docs"].get(name, content)
            checkout = head != state["heads"].get(path) and content == blob(repo, head, name)
            if repo == repos[0]:
                docs[name] = base if checkout else content
            elif not initializing and not checkout and content != base:
                digest = hashlib.sha256(content.encode("utf-8")).hexdigest()[:12]
                source = f"save {path} [{digest}]"
                if source not in prior_sources:
                    changes.append([source, name, base, content])
            state["heads"][path] = head

    for source, name, base, incoming in changes:
        combined = merge(docs[name], base, incoming)
        if combined is None:
            pending.append([source, name, base, incoming])
            blocked_roots.update(path for path in roots
                                 if source.startswith(f"save {path} [") and roots[path] == incoming)
        else:
            docs[name] = combined

    # Avoid overwriting a file changed by an editor or a checkout during this run.
    for path, previous in roots.items():
        if Path(path).read_text(encoding="utf-8") != previous:
            raise RuntimeError(f"{path} changed during synchronization. Retry on the next run.")
    for path, previous in roots.items():
        new = docs[Path(path).name]
        if new != previous and path not in blocked_roots:
            write_atomic(Path(path), new)
            print(f"Updated {path}", flush=True)
    state["docs"] = docs
    state["pending"] = pending
    write_atomic(state_file, json.dumps(state, ensure_ascii=False))

    report = state_dir / "conflicts.txt"
    if pending:
        details = "\n".join(f"{name} | {source}" for source, name, _, _ in pending) + "\n"
        if not report.exists() or report.read_text(encoding="utf-8") != details:
            write_atomic(report, details)
            print(f"Overlapping changes need review: {report}", flush=True)
    else:
        report.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, default=Path.home() / "workspace")
    parser.add_argument("--state-dir", type=Path,
                        default=Path.home() / "Library/Application Support/Lash Her API Docs")
    parser.add_argument("--fetch", action="store_true")
    parser.add_argument("--ack", action="append", default=[], metavar="SOURCE")
    args = parser.parse_args()
    state_dir = args.state_dir.resolve()
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (state_dir / "lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        sync(args.workspace.resolve(), state_dir, args.fetch, args.ack)


if __name__ == "__main__":
    main()
