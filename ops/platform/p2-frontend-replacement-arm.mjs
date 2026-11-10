import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, mkdirSync, openSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Client } from "pg";
import { frontendConnectionOptions, FRONTEND_MIGRATION_LOCK } from "./frontend-migration.mjs";
import { verifyEmptyFrontendReplacement } from "./frontend-replacement-boundary.mjs";
import { frontendPrivateReceiptDirectory, frontendReleaseReceiptStore, readFrontendReleaseEvidence } from "./frontend-release-receipts.mjs";
import { prepareP2FrontendReplacementPlan } from "./p2-frontend-replacement-plan.mjs";
import { createP2FrontendReplacementProbe, verifyP2FrontendReplacementObservation,
  verifyP2FrontendReplacementSession } from "./p2-frontend-replacement-probe.mjs";
import { withFrontendReplacementHost } from "./p2-frontend-replacement-arm-transport.mjs";
import { decodeQualificationTargetJson, requireQualificationTargetProfile,
  STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";
import { committedProfiledCurrentOperatorSource, verifyOperatorCi } from "./recreation_source.mjs";
import { recreationSsh } from "./recreation_ssh.mjs";
import { githubSourceApi } from "./release-inputs.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const refusal = "P2_FRONTEND_REPLACEMENT_ARM_REVIEW_REQUIRED";
const mode = "p2-profiled-frontend-replacement-arm";
const credential = "FRONTEND_STAGING_MIGRATION_DATABASE_URL";
const demand = ok => { if (!ok) throw new Error(refusal); };
const hash = value => createHash("sha256").update(value).digest("hex");
const digest = value => typeof value === "string" && /^(?!0+$)[a-f0-9]{64}$/u.test(value);
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype &&
  isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
const hostPath = value => typeof value === "string" && /^\/var\/lib\/lash-her\/releases\/staging\/[A-Za-z0-9_/.-]+$/u.test(value) &&
  !value.split("/").some(part => part === "." || part === "..") && !value.includes("//") && !value.endsWith("/");

export function readReviewedFrontendReplacementArm(settings) {
  demand(exact(settings, ["version", "qualificationTargetProfile", "environment", "bundle", "reviewFile", "reviewSha256",
    "lineageFile", "reviewedPlanFile", "reviewedPlanSha256", "host", "results", "knownHosts", "sshKey"]) &&
    settings.version === 1 && settings.environment === "staging" && digest(settings.reviewedPlanSha256));
  requireQualificationTargetProfile(profile, settings);
  for (const name of ["bundle", "reviewFile", "lineageFile", "reviewedPlanFile", "results", "knownHosts", "sshKey"]) {
    demand(typeof settings[name] === "string" && resolve(settings[name]) === settings[name]);
  }
  const { host } = settings;
  demand(exact(host, ["machineId", "bundle", "results"]) && /^(?!0+$)[a-f0-9]{32}$/u.test(host.machineId ?? "") &&
    hostPath(host.bundle) && hostPath(host.results) && host.bundle !== host.results);
  const prepared = prepareP2FrontendReplacementPlan({ bundle: settings.bundle, reviewFile: settings.reviewFile,
    reviewSha256: settings.reviewSha256, lineageFile: settings.lineageFile });
  const bytes = readFrontendReleaseEvidence(dirname(settings.reviewedPlanFile), basename(settings.reviewedPlanFile));
  demand(hash(bytes) === settings.reviewedPlanSha256 &&
    isDeepStrictEqual(decodeQualificationTargetJson(bytes, "carrier"), prepared.plan));
  return { prepared, bytes };
}

function observedArm(probe, arm) {
  demand(exact(arm, ["physicalObservation", "physicalObservationSha256", "armReceiptSha256"]) &&
    digest(arm.armReceiptSha256) && digest(arm.physicalObservationSha256) &&
    typeof arm.physicalObservation === "string" && arm.physicalObservation.length <= 10_924);
  const raw = Buffer.from(arm.physicalObservation, "base64");
  demand(raw.toString("base64") === arm.physicalObservation && hash(raw) === arm.physicalObservationSha256);
  verifyP2FrontendReplacementObservation(probe, raw);
  return raw;
}

// Source-only observer. No callback receives the client, and the PostgreSQL
// session only checks identity, takes locks and reads the selected catalog.
export async function observeHeldFrontendReplacement(prepared, url, { verifyEnvironment, arm, signal }) {
  demand(typeof verifyEnvironment === "function" && typeof arm === "function" && signal instanceof AbortSignal);
  const { probe, plan, administrativeLogins } = prepared;
  const { target, managedCatalog, provider } = plan.replacement;
  const guard = async () => {
    demand(!signal.aborted);
    await verifyEnvironment();
    demand(!signal.aborted);
  };
  await guard();
  const client = new Client({ ...frontendConnectionOptions(url, { ...probe.job.target, approvedPendingTags: [] }),
    query_timeout: 15_000, statement_timeout: 10_000 });
  let lost = false, locked = false, lockedProbe, outcome, failure;
  client.on("error", () => { lost = true; });
  const stop = () => { lost = true; client.connection?.stream?.destroy(); };
  signal.addEventListener("abort", stop, { once: true });
  try {
    demand(!signal.aborted);
    await client.connect();
    demand(!lost && !signal.aborted && client.connection.stream.encrypted && client.connection.stream.authorized);
    const { rows: [lock] } = await client.query("SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtext($1)) AS held",
      [FRONTEND_MIGRATION_LOCK]);
    locked = lock?.held === true;
    demand(locked);
    lockedProbe = await createP2FrontendReplacementProbe(probe, client, guard);
    const armed = await arm(lockedProbe);
    const physicalObservation = observedArm(lockedProbe, armed);
    const verifySession = async () => {
      demand(!lost && !signal.aborted);
      await verifyP2FrontendReplacementSession(client, lockedProbe);
      demand(!lost && !signal.aborted);
    };
    const boundary = await verifyEmptyFrontendReplacement(client, { target, predecessorTarget: probe.predecessorTarget,
      administrativeLogins, verifyEnvironment: guard, verifySession,
      ...(Object.hasOwn(plan.replacement, "managedCatalog") ? { managedCatalog, provider } : {}) });
    demand(boundary.databaseOid === lockedProbe.databaseOid && boundary.migrationRoleOid === lockedProbe.migrationRoleOid);
    outcome = { boundary, physicalObservation, armReceiptSha256: armed.armReceiptSha256,
      physicalObservationSha256: armed.physicalObservationSha256 };
  } catch { failure = true; }
  finally {
    try {
      if (locked && !lost) {
        for (const key of [lockedProbe?.marker, FRONTEND_MIGRATION_LOCK].filter(Boolean)) {
          const { rows: [lock] } = await client.query("SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtext($1)) AS released", [key]);
          demand(lock?.released === true);
        }
      }
    } catch { failure = true; }
    try { await client.end(); } catch { failure = true; }
    signal.removeEventListener("abort", stop);
  }
  demand(!failure && !lost && outcome);
  await guard();
  return outcome;
}

export async function verifyFrontendReplacementArm(settings, confirmation) {
  demand(process.versions.node.split(".")[0] === "24");
  const { prepared, bytes } = readReviewedFrontendReplacementArm(settings);
  const { plan } = prepared;
  demand(confirmation === `staging/${plan.releaseId}/replacement-arm/${settings.reviewedPlanSha256}`);
  const source = committedProfiledCurrentOperatorSource(root, plan.sourceCommit);
  const ci = await verifyOperatorCi({ api: githubSourceApi(process.env.PLATFORM_SOURCE_READ_TOKEN),
    sourceCommit: plan.sourceCommit, branch: source.branch, workflowBytes: source.workflowBytes });
  const url = process.env[credential];
  frontendConnectionOptions(url, prepared.probe.job.target);
  frontendPrivateReceiptDirectory(settings.results);
  const directory = join(settings.results, `${plan.releaseId}-replacement-arm`);
  mkdirSync(directory, { mode: 0o700 });
  const results = openSync(settings.results, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(results); } finally { closeSync(results); }
  const store = frontendReleaseReceiptStore(directory);
  store.record("exact-source-ci.json", ci);
  store.retain(`${settings.reviewedPlanSha256}-${plan.reviewSha256}.json`, bytes);
  const diagnostics = join(directory, "ssh");
  mkdirSync(diagnostics, { mode: 0o700 });
  const ssh = await recreationSsh({ knownHosts: settings.knownHosts, keyFile: settings.sshKey, diagnostics });
  demand((await ssh.machine()).machineId === settings.host.machineId);
  const installed = await ssh.installProfiledCurrentSource({ commit: plan.sourceCommit, files: source.files });
  demand(installed.status === "EXACT_OPERATOR_SOURCE_INSTALLED" && installed.commit === plan.sourceCommit);
  const entries = source.files.map(file => [file.path, file.sha256]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const initial = { version: 1, mode, qualificationTargetProfile: profile, environment: "staging", sourceCommit: plan.sourceCommit,
    sourceSha256: Object.fromEntries(entries), sourceClosureSha256: hash(JSON.stringify(entries)), hostMachineId: settings.host.machineId,
    bundle: settings.host.bundle, results: settings.host.results, candidateSha256: plan.candidateSha256,
    reviewedPlanBytes: bytes.toString("base64"), reviewedPlanSha256: settings.reviewedPlanSha256, confirmation,
    credentials: { [credential]: url } };
  const { result, receipt } = await withFrontendReplacementHost(settings, initial, plan, custody =>
    observeHeldFrontendReplacement(prepared, url, custody));
  store.retain(`${result.physicalObservationSha256}-${result.armReceiptSha256}.json`, result.physicalObservation);
  store.record("replacement-boundary.json", result.boundary);
  store.record("host-arm-committed.json", receipt);
  const outcome = { ...receipt, status: "P2_FRONTEND_REPLACEMENT_ARM_VERIFIED",
    emptyCatalogObserved: true, localDatabaseSessionClosed: true,
    boundaryReceiptSha256: hash(readFrontendReleaseEvidence(directory, "replacement-boundary.json")),
    hostCommitReceiptSha256: hash(readFrontendReleaseEvidence(directory, "host-arm-committed.json")) };
  store.record("replacement-arm-outcome.json", outcome);
  return outcome;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [mode, settingsPath, flag, confirmation] = process.argv.slice(2);
    demand(process.argv.length === 6 && mode === "--verify-locked" && flag === "--confirm" && settingsPath === resolve(settingsPath));
    const raw = readFrontendReleaseEvidence(dirname(settingsPath), basename(settingsPath));
    console.log(JSON.stringify(await verifyFrontendReplacementArm(decodeQualificationTargetJson(raw, "carrier"), confirmation)));
  } catch { console.error(refusal); process.exitCode = 1; }
}
