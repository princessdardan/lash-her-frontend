import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const securityRoot = path.join(root, "vendor/security");
const manifestPath = path.join(securityRoot, "forks.json");
const manifest = JSON.parse(readFileSync(manifestPath));
for (const fork of manifest.forks) {
  const directory = path.join(securityRoot, fork.directory);
  const pkg = JSON.parse(readFileSync(path.join(directory, "package.json")));
  const npmCli = process.env.npm_execpath;
  const args = [
    "pack",
    directory,
    "--ignore-scripts",
    "--pack-destination",
    securityRoot,
    "--json",
  ];
  const [packed] = JSON.parse(
    npmCli
      ? execFileSync(process.execPath, [npmCli, ...args], {
          cwd: root,
          encoding: "utf8",
        })
      : execFileSync("npm", args, { cwd: root, encoding: "utf8" }),
  );
  fork.name = pkg.name;
  fork.version = pkg.version;
  fork.archive = packed.filename;
  fork.integrity = packed.integrity;
  fork.files = Object.fromEntries(
    packed.files
      .map(({ path: file }) => [
        file,
        createHash("sha256")
          .update(readFileSync(path.join(directory, file)))
          .digest("hex"),
      ])
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
