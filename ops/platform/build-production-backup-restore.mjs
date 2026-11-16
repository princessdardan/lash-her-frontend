import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const target = process.argv[2];
if (!target) throw new Error("Provide a dedicated runner deployment directory");

const vercel = resolve(target, ".vercel");
const project = JSON.parse(await readFile(resolve(vercel, "project.json"), "utf8"));
if (project.projectId !== "prj_B7bEG3kusrfasLFFVNg4Sj3nLzzM" ||
    project.orgId !== "team_2Hrn5eMZyZxfAWdmYvyKi9t3" ||
    project.projectName !== "lash-her-production-backup-runner") {
  throw new Error("Expected the dedicated production restore runner project");
}

const output = resolve(vercel, "output");
const handler = resolve(output, "functions/api/restore.func");
await mkdir(handler, { recursive: true });
await writeFile(resolve(output, "config.json"), JSON.stringify({ version: 3 }));
await writeFile(resolve(handler, ".vc-config.json"), JSON.stringify({
  runtime: "nodejs24.x", handler: "index.js", launcherType: "Nodejs", maxDuration: 185,
}));
await build({
  entryPoints: [fileURLToPath(new URL("./production-backup-restore.mjs", import.meta.url))],
  outfile: resolve(handler, "index.js"),
  bundle: true, platform: "node", target: "node24", format: "cjs",
  footer: { js: "module.exports = module.exports.default;" },
});
