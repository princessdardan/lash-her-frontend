#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const CANONICAL_URLS = new Set([
  "https://github.com/princessdardan/lash-her-frontend.git",
  "git@github.com:princessdardan/lash-her-frontend.git",
]);

const remoteName = process.argv[2] ?? "origin";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

let remoteUrl;
try {
  remoteUrl = git(["remote", "get-url", remoteName]);
} catch {
  console.error(`Remote '${remoteName}' is not configured.`);
  console.error("Expected canonical repository: https://github.com/princessdardan/lash-her-frontend.git");
  process.exit(1);
}

if (!CANONICAL_URLS.has(remoteUrl)) {
  console.error(`Refusing to use remote '${remoteName}' because it points to: ${remoteUrl}`);
  console.error("Expected canonical repository: https://github.com/princessdardan/lash-her-frontend.git");
  process.exit(1);
}

console.log(`Verified '${remoteName}' remote: ${remoteUrl}`);
