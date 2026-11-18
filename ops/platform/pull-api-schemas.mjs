import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SOURCE_REPOSITORIES, isRevision } from "./source-policy.mjs";

const require = condition => { if (!condition) throw new Error("Private API schema retrieval refused"); };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const command = (program, args) => execFileSync(program, args, {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000, maxBuffer: 4_000_000,
}).trim();

export function apiSchemaSource(candidate, service) {
  require(["course", "community"].includes(service));
  const source = candidate.sources?.[service];
  const repository = SOURCE_REPOSITORIES[service];
  require(source?.repository === `https://github.com/${repository}.git` && source.branch === "main" &&
    source.requiredChecks === "passed" && isRevision(source.commit) &&
    /^[1-9][0-9]*$/u.test(source.ciRunId ?? "") && Number.isSafeInteger(source.ciAttempt) && source.ciAttempt > 0);
  const image = `ghcr.io/${repository}-schema`;
  return { service, source, repository, image,
    tag: `${image}:ci-${source.ciRunId}-${source.ciAttempt}-${source.commit}` };
}

function checkedSchema(bytes, labels, selected) {
  const source = selected.source;
  const expected = { "org.opencontainers.image.source": `https://github.com/${selected.repository}`,
    "org.opencontainers.image.revision": source.commit, "io.lash-her.ci.run-id": source.ciRunId,
    "io.lash-her.ci.run-attempt": String(source.ciAttempt), "io.lash-her.postgres.major": "18" };
  require(Object.entries(expected).every(([key, value]) => labels?.[key] === value) &&
    labels["io.lash-her.operator-schema.sha256"] === hash(bytes));
  let records;
  try { records = [JSON.parse(bytes)]; }
  catch { records = bytes.toString("utf8").trim().split(/\r?\n/u).map(line => JSON.parse(line)); }
  require(records.every(record => record && typeof record === "object" && !Array.isArray(record)) &&
    records.filter(record => record.status === "OPERATOR_MIGRATION_OWNED_POSTGRES_PASS").length === 1);
  const report = records.at(-1);
  require(report.status === "OPERATOR_MIGRATION_OWNED_POSTGRES_PASS" && report.providerTouched === false &&
    report.service === selected.repository.split("/")[1] && report.postgresMajor === 18 &&
    report.schemaBaseline?.schemaVersion === 1 && report.schemaBaseline.serverMajor === 18 &&
    /^[a-f0-9]{64}$/u.test(report.schemaBaseline.artifactSha256 ?? "") &&
    report.schemaBaseline.catalog && typeof report.schemaBaseline.catalog === "object" && !Array.isArray(report.schemaBaseline.catalog));
  return report;
}

export function pullApiSchemas(candidate, destination, run = command) {
  const selected = ["course", "community"].map(service => apiSchemaSource(candidate, service));
  destination = resolve(destination);
  const parent = realpathSync(dirname(destination));
  destination = join(parent, basename(destination));
  require(lstatSync(destination, { throwIfNoEntry: false }) === undefined);
  for (let path = parent; ; path = dirname(path)) {
    require(!existsSync(join(path, ".git")));
    if (dirname(path) === path) break;
  }
  mkdirSync(destination, { mode: 0o700 });
  const result = [];
  let complete = false;
  try {
    for (const context of selected) {
      run("docker", ["pull", "--platform", "linux/amd64", context.tag]);
      const digests = JSON.parse(run("docker", ["image", "inspect", "--format", "{{json .RepoDigests}}", context.tag]));
      require(Array.isArray(digests));
      const images = digests.filter(value => typeof value === "string" &&
        new RegExp("^" + context.image.replaceAll(".", "\\.") + "@sha256:[a-f0-9]{64}$", "u").test(value));
      require(images.length === 1);
      const image = images[0];
      run("docker", ["pull", "--platform", "linux/amd64", image]);
      const labels = JSON.parse(run("docker", ["image", "inspect", "--format", "{{json .Config.Labels}}", image]));
      const directory = join(destination, context.service);
      mkdirSync(directory, { mode: 0o700 });
      const container = run("docker", ["create", "--entrypoint", "/operator-schema-postgres18.json", image]);
      require(/^[a-f0-9]{64}$/u.test(container));
      try {
        const file = join(directory, "operator-schema-postgres18.json");
        run("docker", ["cp", container + ":/operator-schema-postgres18.json", file]);
        const info = lstatSync(file);
        require(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= 2_000_000);
        const bytes = readFileSync(file);
        const report = checkedSchema(bytes, labels, context);
        // CI stdout also contains intermediate checks; the existing bundle preparer consumes the final report.
        writeFileSync(file, JSON.stringify(report) + "\n", { mode: 0o600 });
        chmodSync(file, 0o600);
        result.push({ service: context.service, sourceCommit: context.source.commit,
          ciRunId: context.source.ciRunId, ciAttempt: context.source.ciAttempt, image });
      } finally {
        run("docker", ["rm", "--force", container]);
      }
    }
    complete = true;
    return result;
  } finally { if (!complete) rmSync(destination, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    require(process.argv.length === 4);
    const candidate = JSON.parse(readFileSync(resolve(process.argv[2])));
    process.stdout.write(JSON.stringify(pullApiSchemas(candidate, process.argv[3])) + "\n");
  } catch {
    process.stderr.write("Private API schema retrieval refused\n");
    process.exitCode = 1;
  }
}
