import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, existsSync, mkdirSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SOURCE_REPOSITORIES, isRevision } from "./source-policy.mjs";
import { prepareFrontendMigrationJob } from "./frontend-migration.mjs";
import { decodeQualificationTargetJson, parseQualificationTargetProfileRef, requireQualificationTargetProfile,
  resolveQualificationTargetProfile, STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE } from "./qualification-target-profile.mjs";

const services = { course: "lash-her-course-api", community: "lash-her-community-api" };
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const demand = (ok) => { if (!ok) throw new Error("Migration bundle input refused"); };
function read(file, kind = "carrier") {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd); demand(before.isFile() && before.size > 0 && before.size <= 2_000_000);
    const buffer = Buffer.alloc(before.size); let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null); if (!count) break; length += count;
    }
    demand(length === buffer.length && readSync(fd, Buffer.alloc(1), 0, 1, null) === 0);
    const after = fstatSync(fd);
    demand(["dev", "ino", "size", "mtimeMs", "ctimeMs"].every((key) => before[key] === after[key]));
    return decodeQualificationTargetJson(buffer, kind);
  } finally { closeSync(fd); }
}

const ownProfile = (value) => value && typeof value === "object" && Object.hasOwn(value, "qualificationTargetProfile");
const candidateCarriers = (candidate) => [candidate, candidate?.sourceApproval, candidate?.integration,
  ...Object.values(candidate?.sources ?? {}), candidate?.workload, candidate?.approval,
  ...(candidate?.frontendMigration === undefined ? [] : [candidate.frontendMigration])];
const targetCarriers = (settings) => [settings, ...Object.values(settings?.services ?? {}),
  ...(settings?.workload === undefined ? [] : [settings.workload]), ...(settings?.frontend === undefined ? [] : [settings.frontend])];

const operatorCommands = Object.freeze({
  legacy: Object.freeze({ check: "--check", execute: "--execute" }),
  current: Object.freeze({ check: "--check-profiled-current", execute: "--execute-profiled-current" }),
});

/** The caller selects a source action before any raw job/manifest is read. */
export function migrationOperatorCommand(expectedQualificationTargetProfile, action) {
  demand(action === "check" || action === "execute");
  if (expectedQualificationTargetProfile === undefined) return operatorCommands.legacy[action];
  const expected = parseQualificationTargetProfileRef(expectedQualificationTargetProfile);
  const profile = resolveQualificationTargetProfile(expected);
  demand(profile.id === "staging-current" && profile.kind === "existing-staging" && profile.selectionPolicy === "existing-staging-v1");
  return operatorCommands.current[action];
}

/** Binding/assembly only. No tokens, database access, provider queries or approval. */
export function prepareMigrationBundle(candidate, settings, schemas) {
  return prepareMigrationBundleForContext(candidate, settings, schemas, undefined);
}

/** Fixed current-profile preparation. It cannot accept a caller-selected ID. */
export function prepareProfiledCurrentMigrationBundle(candidate, settings, schemas) {
  resolveQualificationTargetProfile(STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE);
  return prepareMigrationBundleForContext(candidate, settings, schemas, STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE);
}

function prepareMigrationBundleForContext(candidate, settings, schemas, expectedQualificationTargetProfile) {
  const expected = expectedQualificationTargetProfile === undefined ? undefined :
    parseQualificationTargetProfileRef(expectedQualificationTargetProfile);
  const profiled = expected !== undefined;
  if (profiled) {
    requireQualificationTargetProfile(expected, ...candidateCarriers(candidate), ...targetCarriers(settings));
    const profile = resolveQualificationTargetProfile(expected);
    demand(profile.id === "staging-current" && profile.kind === "existing-staging" && profile.selectionPolicy === "existing-staging-v1" &&
      profile.environment === "staging" && settings?.environment === profile.environment && candidate?.environment === profile.environment &&
      candidate?.workload?.environment === profile.frontend.workloadEnvironment && candidate?.workload?.projectId === profile.frontend.projectId &&
      candidate?.sourceGraph === undefined);
    if (candidate?.artifacts?.frontendMigration !== undefined || settings?.frontend !== undefined || candidate?.frontendMigration !== undefined)
      demand(candidate?.artifacts?.frontendMigration && settings?.frontend && candidate?.frontendMigration);
  } else demand(!candidateCarriers(candidate).some(ownProfile) && !targetCarriers(settings).some(ownProfile));
  demand(candidate?.version === (profiled ? 3 : 2) && ["staging", "production"].includes(settings?.environment) &&
    typeof candidate.releaseId === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(candidate.releaseId) &&
    candidate.integration?.state === "passed" && /^sha256:[a-f0-9]{64}$/u.test(candidate.contractManifestSha256 ?? ""));
  for (const [name, repository] of Object.entries(SOURCE_REPOSITORIES)) {
    demand(candidate.sources?.[name]?.repository === `https://github.com/${repository}.git` &&
      isRevision(candidate.sources[name].commit) && candidate.sources[name].requiredChecks === "passed");
  }
  if (candidate.contractPhase !== undefined || candidate.phase2ContractManifestSha256 !== undefined) demand(candidate.contractPhase === "p2" &&
    /^sha256:[a-f0-9]{64}$/u.test(candidate.phase2ContractManifestSha256 ?? "") && !/^sha256:0+$/u.test(candidate.phase2ContractManifestSha256) &&
    candidate.frontendMigration?.contractPhase === "p2" && candidate.frontendMigration.phase2ContractManifestSha256 === candidate.phase2ContractManifestSha256);
  if (settings.environment === "production") demand(settings.workload?.environment === "production" &&
    /^prj_[A-Za-z0-9]+$/u.test(settings.workload?.projectId ?? "") && settings.workload.projectId !== candidate.workload?.projectId);
  const release = { ...structuredClone(candidate), environment: settings.environment,
    ...(settings.environment === "production" ? { workload: { environment: "production", projectId: settings.workload.projectId } } : {}),
    approval: { state: "pending", operator: "Dardan", releaseId: candidate.releaseId, environment: settings.environment, approvedAt: null,
      ...(profiled ? { qualificationTargetProfile: expected } : {}) } };
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
    const targetDescriptor = { schemaVersion: profiled ? 2 : 1, service, environment: settings.environment,
      ...Object.fromEntries(["host", "port", "database", "user", "serverMajor", "approvedPendingTags", "allowEmptyBootstrap", "providerIdentityEvidenceRef"].map((key) => [key, target[key]])),
      artifactSha256: baseline.artifactSha256, ...(profiled ? { qualificationTargetProfile: expected } : {}) };
    demand(Object.values(targetDescriptor).every((value) => value !== undefined) && typeof target.runtimeRole === "string" && typeof target.recoveryRef === "string");
    const job = { schemaVersion: profiled ? 2 : 1, kind: "operator-migration", releaseId: release.releaseId, operator: "Dardan", environment: settings.environment,
      ...(profiled ? { qualificationTargetProfile: expected } : {}),
      ...(candidate.contractPhase === "p2" ? { contractPhase: "p2", phase2ContractManifestSha256: candidate.phase2ContractManifestSha256 } : {}),
      sourceCommit: candidate.sources[name].commit, migrationImageDigest: image(`${name}Migration`, "migration"), runtimeImageDigest: image(`${name}Runtime`, "runtime"),
      contractSha256: candidate.contractManifestSha256.slice(7), target: targetDescriptor, runtimeRole: target.runtimeRole,
      schemaBaselineSha256: hash(baselines[name]), recoveryRef: target.recoveryRef, stagingVerification: null,
      statementTimeoutMs: target.statementTimeoutMs ?? 30_000, ddlLockTimeoutMs: target.ddlLockTimeoutMs ?? 5_000 };
    if (settings.environment === "production") job.stagingVerification = { receiptRef: `staging/${name}`, sourceCommit: job.sourceCommit,
      migrationImageDigest: job.migrationImageDigest, runtimeImageDigest: job.runtimeImageDigest, contractSha256: job.contractSha256,
      artifactSha256: baseline.artifactSha256, ...(profiled ? { qualificationTargetProfile: expected } : {}) };
    jobs[name] = job;
  }
  return { release, jobs, baselines };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let created;
  try {
    const args = process.argv.slice(2), profiled = args[0] === "--prepare-profiled-current";
    // Resolve fixed source context before opening any caller-controlled carrier.
    const expected = profiled ? STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE : undefined;
    if (expected !== undefined) resolveQualificationTargetProfile(expected);
    const input = profiled ? args.slice(1) : args;
    const [candidateFile, settingsFile, schemaDirectory, outputDirectory, stagingDirectory] = input;
    demand(input.length >= 4 && input.length <= 5 && candidateFile && settingsFile && schemaDirectory && outputDirectory);
    const candidate = read(candidateFile), settings = read(settingsFile);
    demand((settings.environment === "production") === Boolean(stagingDirectory));
    const schemas = Object.fromEntries(Object.keys(services).map((name) => {
      const major = settings.services?.[name]?.serverMajor;
      demand(Number.isSafeInteger(major) && major >= 16 && major <= 99);
      return [name, read(join(schemaDirectory, name, `operator-schema-postgres${major}.json`), "private-packet")];
    }));
    const { release, jobs, baselines } = expected === undefined ? prepareMigrationBundle(candidate, settings, schemas) :
      prepareProfiledCurrentMigrationBundle(candidate, settings, schemas);
    // Read every required evidence file before creating output. Production receipt
    // binding is independently rechecked by the read-only host plan and image CLI.
    const evidence = {};
    if (stagingDirectory) {
      evidence["staging/acceptance.json"] = read(join(stagingDirectory, "acceptance.json"), "private-packet");
      evidence["recovery.json"] = read(join(stagingDirectory, "recovery.json"), "private-packet");
      for (const name of Object.keys(services)) for (const file of ["database-receipt.json", "job-outcome.json"])
        evidence[`staging/${name}/${file}`] = read(join(stagingDirectory, name, file), "private-packet");
    }
    let frontend;
    demand(!candidate.artifacts?.frontendMigration || settings.frontend);
    if (settings.frontend) {
      const exported = read(join(schemaDirectory, "frontend", `operator-schema-postgres${settings.frontend.serverMajor}.json`), "private-packet");
      const prior = stagingDirectory ? { database: read(join(stagingDirectory, "frontend/database-receipt.json"), "private-packet"),
        terminal: read(join(stagingDirectory, "frontend/job-outcome.json"), "private-packet") } : undefined;
      frontend = prepareFrontendMigrationJob(release, settings.frontend, exported, prior, expected);
      if (prior) {
        evidence["staging/frontend/database-receipt.json"] = prior.database;
        evidence["staging/frontend/job-outcome.json"] = prior.terminal;
      }
    }
    const output = resolve(outputDirectory);
    // Private API schema exports must not become files in a public checkout.
    for (let parent = dirname(output); ; parent = dirname(parent)) {
      demand(!existsSync(join(parent, ".git")));
      if (parent === dirname(parent)) break;
    }
    mkdirSync(output, { mode: 0o700 }); created = output;
    for (const directory of ["jobs", "schema", ...(stagingDirectory ? ["staging", "staging/course", "staging/community", ...(frontend ? ["staging/frontend"] : [])] : [])]) mkdirSync(join(output, directory), { mode: 0o700 });
    const save = (file, value) => writeFileSync(join(output, file), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    save("release.candidate.json", release); save("build.candidate.json", candidate);
    for (const name of Object.keys(services)) {
      save(`jobs/${name}.json`, jobs[name]);
      writeFileSync(join(output, `schema/${name}.json`), baselines[name], { flag: "wx", mode: 0o600 });
    }
    if (frontend) {
      save("jobs/frontend.json", frontend.job);
      save("schema/frontend.json", frontend.baseline);
    }
    for (const [file, value] of Object.entries(evidence)) save(file, value);
    process.stdout.write("Migration bundle prepared; run the read-only host plan before explicit execution\n");
  } catch {
    if (created) rmSync(created, { recursive: true, force: true });
    process.stderr.write("Migration bundle preparation refused\n"); process.exitCode = 1;
  }
}
