import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, existsSync, mkdirSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SOURCE_REPOSITORIES, isRevision } from "./source-policy.mjs";

const services = { course: "lash-her-course-api", community: "lash-her-community-api" };
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const demand = (ok) => { if (!ok) throw new Error("Migration bundle input refused"); };
function read(file) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd); demand(stat.isFile() && stat.size > 0 && stat.size <= 2_000_000);
    const buffer = Buffer.alloc(2_000_001); let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null); if (!count) break; length += count;
    }
    demand(length <= 2_000_000);
    return JSON.parse(buffer.subarray(0, length).toString("utf8"));
  } finally { closeSync(fd); }
}

/** Binding/assembly only. No tokens, database access, provider queries or approval. */
export function prepareMigrationBundle(candidate, settings, schemas) {
  demand(candidate?.version === 2 && ["staging", "production"].includes(settings?.environment) &&
    typeof candidate.releaseId === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(candidate.releaseId) &&
    candidate.integration?.state === "passed" && /^sha256:[a-f0-9]{64}$/u.test(candidate.contractManifestSha256 ?? ""));
  for (const [name, repository] of Object.entries(SOURCE_REPOSITORIES)) {
    demand(candidate.sources?.[name]?.repository === `https://github.com/${repository}.git` &&
      isRevision(candidate.sources[name].commit) && candidate.sources[name].requiredChecks === "passed");
  }
  if (settings.environment === "production") demand(settings.workload?.environment === "production" &&
    /^prj_[A-Za-z0-9]+$/u.test(settings.workload?.projectId ?? "") && settings.workload.projectId !== candidate.workload?.projectId);
  const release = { ...structuredClone(candidate), environment: settings.environment,
    ...(settings.environment === "production" ? { workload: { environment: "production", projectId: settings.workload.projectId } } : {}),
    approval: { state: "pending", operator: "Dardan", releaseId: candidate.releaseId, environment: settings.environment, approvedAt: null } };
  const jobs = {}, baselines = {};
  for (const [name, service] of Object.entries(services)) {
    const target = settings.services?.[name], run = schemas[name];
    demand(target && typeof target.host === "string" && /^[a-z0-9.-]+$/u.test(target.host) && !target.host.includes("-pooler") &&
      [target.database, target.user, target.runtimeRole].every((value) => typeof value === "string" && /^[A-Za-z0-9_-]+$/u.test(value)) &&
      typeof target.recoveryRef === "string" && /^[A-Za-z0-9_./:-]{1,200}$/u.test(target.recoveryRef) &&
      typeof target.providerIdentityEvidenceRef === "string" && /^[A-Za-z0-9_./-]{1,200}$/u.test(target.providerIdentityEvidenceRef) &&
      Array.isArray(target.approvedPendingTags) && target.approvedPendingTags.every((value) => typeof value === "string" && /^\d{4}_[a-z0-9_]+$/u.test(value)) &&
      run?.status === "OPERATOR_MIGRATION_OWNED_POSTGRES_PASS" && run.service === service &&
      run.postgresMajor === target.serverMajor && run.providerTouched === false && run.schemaBaseline?.serverMajor === target.serverMajor);
    const baseline = run.schemaBaseline;
    demand(/^[a-f0-9]{64}$/u.test(baseline.artifactSha256 ?? "") && !/^0+$/u.test(baseline.artifactSha256));
    baselines[name] = JSON.stringify(baseline, null, 2) + "\n";
    const image = (key, suffix) => {
      const value = candidate.artifacts?.[key]?.image;
      demand(typeof value === "string" && new RegExp(`^ghcr\\.io/princessdardan/lash-her-platform-${name}-${suffix}@sha256:[a-f0-9]{64}$`, "u").test(value));
      return value.split("@")[1];
    };
    const targetDescriptor = { schemaVersion: 1, service, environment: settings.environment,
      ...Object.fromEntries(["host", "port", "database", "user", "serverMajor", "approvedPendingTags", "allowEmptyBootstrap", "providerIdentityEvidenceRef"].map((key) => [key, target[key]])),
      artifactSha256: baseline.artifactSha256 };
    demand(Object.values(targetDescriptor).every((value) => value !== undefined) && typeof target.runtimeRole === "string" && typeof target.recoveryRef === "string");
    const job = { schemaVersion: 1, kind: "operator-migration", releaseId: release.releaseId, operator: "Dardan", environment: settings.environment,
      sourceCommit: candidate.sources[name].commit, migrationImageDigest: image(`${name}Migration`, "migration"), runtimeImageDigest: image(`${name}Runtime`, "runtime"),
      contractSha256: candidate.contractManifestSha256.slice(7), target: targetDescriptor, runtimeRole: target.runtimeRole,
      schemaBaselineSha256: hash(baselines[name]), recoveryRef: target.recoveryRef, stagingVerification: null,
      statementTimeoutMs: target.statementTimeoutMs ?? 30_000, ddlLockTimeoutMs: target.ddlLockTimeoutMs ?? 5_000 };
    if (settings.environment === "production") job.stagingVerification = { receiptRef: `staging/${name}`, sourceCommit: job.sourceCommit,
      migrationImageDigest: job.migrationImageDigest, runtimeImageDigest: job.runtimeImageDigest, contractSha256: job.contractSha256, artifactSha256: baseline.artifactSha256 };
    jobs[name] = job;
  }
  return { release, jobs, baselines };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let created;
  try {
    const [candidateFile, settingsFile, schemaDirectory, outputDirectory, stagingDirectory] = process.argv.slice(2);
    demand(process.argv.length >= 6 && process.argv.length <= 7 && candidateFile && settingsFile && schemaDirectory && outputDirectory);
    const candidate = read(candidateFile), settings = read(settingsFile);
    demand((settings.environment === "production") === Boolean(stagingDirectory));
    const schemas = Object.fromEntries(Object.keys(services).map((name) => {
      const major = settings.services?.[name]?.serverMajor;
      demand(Number.isSafeInteger(major) && major >= 16 && major <= 99);
      return [name, read(join(schemaDirectory, name, `operator-schema-postgres${major}.json`))];
    }));
    const { release, jobs, baselines } = prepareMigrationBundle(candidate, settings, schemas);
    // Read every required evidence file before creating output. Production receipt
    // binding is independently rechecked by the read-only host plan and image CLI.
    const evidence = {};
    if (stagingDirectory) {
      evidence["staging/acceptance.json"] = read(join(stagingDirectory, "acceptance.json"));
      evidence["recovery.json"] = read(join(stagingDirectory, "recovery.json"));
      for (const name of Object.keys(services)) for (const file of ["database-receipt.json", "job-outcome.json"])
        evidence[`staging/${name}/${file}`] = read(join(stagingDirectory, name, file));
    }
    const output = resolve(outputDirectory);
    // Private API schema exports must not become files in a public checkout.
    for (let parent = dirname(output); ; parent = dirname(parent)) {
      demand(!existsSync(join(parent, ".git")));
      if (parent === dirname(parent)) break;
    }
    mkdirSync(output, { mode: 0o700 }); created = output;
    for (const directory of ["jobs", "schema", ...(stagingDirectory ? ["staging", "staging/course", "staging/community"] : [])]) mkdirSync(join(output, directory), { mode: 0o700 });
    const save = (file, value) => writeFileSync(join(output, file), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    save("release.candidate.json", release); save("build.candidate.json", candidate);
    for (const name of Object.keys(services)) {
      save(`jobs/${name}.json`, jobs[name]);
      writeFileSync(join(output, `schema/${name}.json`), baselines[name], { flag: "wx", mode: 0o600 });
    }
    for (const [file, value] of Object.entries(evidence)) save(file, value);
    process.stdout.write("Migration bundle prepared; run the read-only host plan before explicit execution\n");
  } catch {
    if (created) rmSync(created, { recursive: true, force: true });
    process.stderr.write("Migration bundle preparation refused\n"); process.exitCode = 1;
  }
}
