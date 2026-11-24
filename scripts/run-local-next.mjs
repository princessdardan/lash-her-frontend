import { spawn, spawnSync } from "node:child_process";
import { constants, closeSync, fstatSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
let root = fileURLToPath(new URL("..", import.meta.url));
if (args[0] === "--app-dir") {
  if (!args[1]) throw new Error("Pass the exported Next app directory.");
  root = resolve(args[1]);
  args.splice(0, 2);
}
const next = join(root, "node_modules/next/dist/bin/next");
if (!["dev", "build", "start"].includes(args[0]))
  throw new Error("Pass a Next command: dev, build, or start.");

const env = { ...process.env };
const stdio = ["inherit", "inherit", "inherit"];
if (process.platform === "darwin") {
  const uid = process.getuid();
  // The path is shared by this user across checkout and fixture directories.
  const fd = openSync(
    `/tmp/lash-her-frontend-next-${uid}.lock`,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o600,
  );
  try {
    const file = fstatSync(fd);
    if (!file.isFile() || file.uid !== uid || (file.mode & 0o077) !== 0)
      throw new Error("The local Next lock must be a private file owned by this user.");
    const lock = spawnSync("/usr/bin/lockf", ["-s", "-t", "0", "3"], {
      stdio: ["ignore", "ignore", "inherit", fd],
    });
    if (lock.error) throw lock.error;
    if (lock.status === 75)
      throw new Error("Another Lash Her Next process is running on this Mac. Stop it before starting this run.");
    if (lock.status !== 0) throw new Error("Could not acquire the local Next lock.");
    // Keep the kernel lock while Next lives, even if its launcher is killed.
    stdio.push(fd);
    env.LASH_LOCAL_NEXT_LIMITED = "1";
    env.RAYON_NUM_THREADS ??= "2";
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

let requestedSignal;
try {
  const child = spawn(process.execPath, [next, ...args], { cwd: root, env, stdio });
  const forward = (signal) => {
    requestedSignal = signal;
    child.kill(signal);
  };
  const interrupt = () => forward("SIGINT");
  const terminate = () => forward("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    process.exitCode = code ?? (requestedSignal === "SIGINT" ? 130 : 143);
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
} finally {
  if (typeof stdio[3] === "number") closeSync(stdio[3]);
}
