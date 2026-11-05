import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { join } from "node:path";

// Same native flock as host release/watchdog tooling. The child retains its
// open descriptor until the parent closes stdin. Parent death closes the pipe;
// there is no stale-file deletion or process-age heuristic.
const guardian = String.raw`
import fcntl, os, stat, sys
fd = None
try:
    path = sys.argv[1]
    if not os.path.isabs(path) or os.path.realpath(os.path.dirname(path)) != os.path.dirname(path):
        raise ValueError()
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError()
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    print('LOCKED', flush=True)
    for line in sys.stdin:
        current = os.lstat(path)
        if line != 'CHECK\n' or current.st_dev != info.st_dev or current.st_ino != info.st_ino or stat.S_ISLNK(current.st_mode):
            raise ValueError()
        print('HELD', flush=True)
except BaseException:
    sys.exit(1)
finally:
    if fd is not None:
        os.close(fd)
`;

export const frontendEnvironmentLockPath = () => process.platform === "darwin" ?
  join(realpathSync(tmpdir()), `lash-her-release-${process.getuid()}.lock`) : "/run/lock/lash-her-release.lock";

export async function withFrontendEnvironmentLock(task, options = {}) {
  if (typeof task !== "function") throw new Error("FRONTEND_ENVIRONMENT_LOCK_REFUSED");
  const child = spawn("python3", ["-I", "-u", "-c", guardian, options.path ?? frontendEnvironmentLockPath()],
    { stdio: ["pipe", "pipe", "ignore"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  const lease = new AbortController();
  let stopped = false, pending, active = true, exitCode;
  const lines = createInterface({ input: child.stdout });
  const rejectPending = () => { stopped = true; if (active) lease.abort(); if (pending) { clearTimeout(pending.timer); pending.reject(new Error("FRONTEND_ENVIRONMENT_LOCK_LOST")); pending = undefined; } };
  child.on("error", rejectPending); child.on("exit", code => { exitCode = code; rejectPending(); });
  child.stdin.on("error", rejectPending);
  lines.on("line", line => {
    if (!pending || line !== pending.expected) { rejectPending(); return; }
    const current = pending; pending = undefined; clearTimeout(current.timer); current.resolve();
  });
  const expect = (expected, send = false) => new Promise((resolve, reject) => {
    if (stopped || !active || pending) { reject(new Error("FRONTEND_ENVIRONMENT_LOCK_LOST")); return; }
    const timer = setTimeout(() => { stopped = true; lease.abort(); pending = undefined; reject(new Error("FRONTEND_ENVIRONMENT_LOCK_LOST")); }, 5000);
    pending = { expected, resolve, reject, timer };
    if (send) child.stdin.write("CHECK\n");
  });
  let failed, result;
  try {
    await expect("LOCKED");
    const verify = () => expect("HELD", true);
    await verify(); result = await task(verify, lease.signal); await verify();
  } catch { failed = new Error("FRONTEND_ENVIRONMENT_LOCK_OR_ACTION_FAILED_REVIEW_REQUIRED"); }
  finally {
    active = false; if (pending) clearTimeout(pending.timer);
    child.stdin.end();
    if (exitCode === undefined) {
      await new Promise(resolve => {
        const timer = setTimeout(() => { child.kill("SIGTERM"); failed ??= new Error("FRONTEND_ENVIRONMENT_LOCK_CLEANUP_UNVERIFIED"); resolve(); }, 5000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
    lines.close();
    if (exitCode !== 0) failed ??= new Error("FRONTEND_ENVIRONMENT_LOCK_CLEANUP_UNVERIFIED");
  }
  if (failed) throw failed;
  return result;
}
