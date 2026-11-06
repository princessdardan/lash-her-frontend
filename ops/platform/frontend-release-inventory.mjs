// Pure reviewed inventory validation. Source coverage is not deployment discovery.
import { createHash } from "node:crypto";
import { frontendAdmissionTargetSha256, frontendAdmissionBootstrapArtifact } from "./frontend-admission-bootstrap.mjs";
import { prepareHistoricalFrontendLogins } from "./frontend-historical-logins.mjs";
import { prepareFrontendBootstrapCompatibility } from "./frontend-bootstrap-compatibility.mjs";
import { prepareFrontendRestoration } from "./frontend-release-restoration.mjs";
import { prepareP2CertificationProfile } from "./p2-certification-profile.mjs";

export const frontendCoordinationHash = value => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
const demand = ok => { if (!ok) throw new Error("FRONTEND_RELEASE_INVENTORY_REFUSED"); };
const digest = (v, size = 64) => typeof v === "string" && new RegExp(`^[a-f0-9]{${size}}$`, "u").test(v) && !/^0+$/u.test(v);
const oid = v => typeof v === "string" && /^[1-9][0-9]{0,9}$/u.test(v) && Number(v) <= 4294967295;
const roleName = v => typeof v === "string" && /^[a-z][a-z0-9_]{0,62}$/u.test(v);

export function frontendCandidateSurfaces(source) {
  demand(source?.version === 2 && source.scope === "candidate-source-only" && digest(source.sourceManifestSha256));
  const surfaces = [];
  const add = (kind, value) => surfaces.push({ surfaceSha256: frontendCoordinationHash({ kind, ...value }), kind });
  for (const [key, names] of [["routes", "methods"], ["actionModules", "exports"]]) {
    demand(Array.isArray(source[key]));
    for (const entry of source[key]) for (const name of entry[names]) add(key, { file: entry.file, name, sourceSha256: entry.sourceSha256 });
  }
  for (const key of ["renderEntries", "manualEntries"]) {
    demand(Array.isArray(source[key]));
    for (const entry of source[key]) {
      demand(typeof entry.file === "string" && digest(entry.sourceSha256) && Array.isArray(entry.exports));
      if (key === "renderEntries") demand(["server", "client"].includes(entry.runtime) && entry.exports.includes("default"));
      // Every script/module is a surface, including top-level invocations with
      // no exported names. Render exports also bind metadata/static generators.
      add(key, { file: entry.file, exports: entry.exports, sourceSha256: entry.sourceSha256,
        ...(key === "renderEntries" ? { runtime: entry.runtime } : {}) });
    }
  }
  for (const key of ["inlineActions", "deferredSites", "databaseConstructors", "schedules"]) {
    demand(Array.isArray(source[key]));
    for (const entry of source[key]) {
      const identity = { ...entry }; delete identity.classification;
      add(key, identity);
    }
  }
  demand(new Set(surfaces.map(s => s.surfaceSha256)).size === surfaces.length);
  return surfaces.sort((a, b) => a.surfaceSha256.localeCompare(b.surfaceSha256));
}

export function prepareFrontendReleaseInventory(input, migration, source) {
  const job = migration?.job;
  demand(input?.version === 1 && input.environment === "staging" && job?.environment === "staging" &&
    typeof input.actionId === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(input.actionId) && input.actionId === job.releaseId &&
    input.sourceCommit === job.sourceCommit && digest(input.sourceCommit, 40) &&
    input.targetSha256 === frontendAdmissionTargetSha256("staging", job.target) &&
    input.sourceInventorySha256 === frontendCoordinationHash(source) && digest(input.reviewSha256) && digest(input.adaptersSha256) &&
    (input.providerBindingsSha256 === undefined || digest(input.providerBindingsSha256)) &&
    Number.isInteger(input.observationBudgetSeconds) && input.observationBudgetSeconds > 0 && input.observationBudgetSeconds <= 300 &&
    ["bootstrap", "existing"].includes(input.admissionMode) && typeof input.expectedEpoch === "string" && /^[1-9][0-9]{0,17}$/u.test(input.expectedEpoch));
  let bootstrapCompatibility;
  if (input.admissionMode === "bootstrap") {
    demand(input.expectedEpoch === "1" && job.target.approvedPendingTags.length > 0 && input.bootstrapSqlSha256 === frontendAdmissionBootstrapArtifact().sqlSha256);
    bootstrapCompatibility = prepareFrontendBootstrapCompatibility(input.bootstrapCompatibility);
  } else demand(input.bootstrapSqlSha256 === undefined && input.bootstrapCompatibility === undefined);
  const owner = input.owner;
  demand(roleName(owner?.name) && oid(owner.oid) && owner.name !== job.target.user &&
    Array.isArray(input.producers) && input.producers.length > 0 && input.producers.length <= 256);
  const producers = input.producers.map(p => {
    demand(digest(p?.producerSha256) && roleName(p.role?.name) && oid(p.role.oid) && ![owner.name, job.target.user].includes(p.role.name) && p.role.oid !== owner.oid);
    return { producerSha256: p.producerSha256, role: { name: p.role.name, oid: p.role.oid } };
  }).sort((a, b) => a.producerSha256.localeCompare(b.producerSha256));
  demand(new Set(producers.map(p => p.producerSha256)).size === producers.length);
  const roleNames = new Map(), roleOids = new Map();
  for (const producer of producers) {
    demand((!roleNames.has(producer.role.name) || roleNames.get(producer.role.name) === producer.role.oid) &&
      (!roleOids.has(producer.role.oid) || roleOids.get(producer.role.oid) === producer.role.name));
    roleNames.set(producer.role.name, producer.role.oid); roleOids.set(producer.role.oid, producer.role.name);
  }
  demand(producers.some(p => p.role.name === job.target.runtimeRole));
  if (bootstrapCompatibility) demand(producers.some(p => p.role.name === job.target.runtimeRole &&
    p.producerSha256 === bootstrapCompatibility.runtimeProducerSha256));
  const expected = frontendCandidateSurfaces(source);
  demand(Array.isArray(input.candidateCoverage) && input.candidateCoverage.length === expected.length);
  const coverage = input.candidateCoverage.map(row => {
    demand(digest(row?.surfaceSha256) && digest(row.evidenceSha256) && ["admitted", "read-only", "closed"].includes(row.disposition));
    if (row.disposition === "admitted") demand(producers.some(p => p.producerSha256 === row.producerSha256));
    else demand(row.producerSha256 === undefined);
    return { surfaceSha256: row.surfaceSha256, disposition: row.disposition, evidenceSha256: row.evidenceSha256,
      ...(row.disposition === "admitted" ? { producerSha256: row.producerSha256 } : {}) };
  }).sort((a, b) => a.surfaceSha256.localeCompare(b.surfaceSha256));
  demand(coverage.every((row, index) => row.surfaceSha256 === expected[index].surfaceSha256));
  demand(Array.isArray(input.externalSurfaces) && input.externalSurfaces.length >= 4 && input.externalSurfaces.length <= 4096);
  const surfaces = input.externalSurfaces.map(row => {
    demand(digest(row?.surfaceSha256) && digest(row.identitySha256) && ["deployment", "provider", "scheduler", "direct-caller"].includes(row.kind));
    demand(row.surfaceSha256 === frontendCoordinationHash({ kind: row.kind, identitySha256: row.identitySha256 }));
    return { surfaceSha256: row.surfaceSha256, kind: row.kind, identitySha256: row.identitySha256 };
  }).sort((a, b) => a.surfaceSha256.localeCompare(b.surfaceSha256));
  demand(new Set(surfaces.map(row => row.surfaceSha256)).size === surfaces.length &&
    ["deployment", "provider", "scheduler", "direct-caller"].every(kind => surfaces.some(row => row.kind === kind)));
  const historical = prepareHistoricalFrontendLogins(input.historicalLogins);
  demand(historical.actionId === input.actionId && historical.sourceCommit === input.sourceCommit &&
    ["host", "port", "database", "user", "serverMajor"].every(key => historical.target[key] === job.target[key]) &&
    historical.target.currentRuntimeRole === job.target.runtimeRole && historical.target.admissionOwnerRole === owner.name);
  return { version: 1, environment: "staging", actionId: input.actionId, sourceCommit: input.sourceCommit,
    targetSha256: input.targetSha256, sourceInventorySha256: input.sourceInventorySha256,
    reviewSha256: input.reviewSha256, adaptersSha256: input.adaptersSha256,
    ...(input.providerBindingsSha256 ? { providerBindingsSha256: input.providerBindingsSha256 } : {}),
    observationBudgetSeconds: input.observationBudgetSeconds, admissionMode: input.admissionMode,
    ...(input.restoration !== undefined ? { restoration: prepareFrontendRestoration(input.restoration) } : {}),
    ...(input.certification !== undefined ? { certification: prepareP2CertificationProfile(input.certification) } : {}),
    ...(input.admissionMode === "bootstrap" ? { bootstrapSqlSha256: input.bootstrapSqlSha256, bootstrapCompatibility } : {}),
    expectedEpoch: input.expectedEpoch, owner: { name: owner.name, oid: owner.oid }, producers,
    candidateCoverage: coverage, externalSurfaces: surfaces, historicalLogins: historical };
}

// Observers return retained evidence bytes rather than boolean certificates.
// This validates bindings/coverage; only the source-pinned provider adapter can
// acquire real observations. No JSON input can install that adapter's code.
export async function validateFrontendFenceObservation(plan, nonce, observed, retain, options = {}) {
  const requireFenced = options.requireFenced !== false;
  demand(digest(nonce) && typeof retain === "function" && observed?.version === 1 && observed.nonce === nonce &&
    observed.actionId === plan.actionId && observed.sourceCommit === plan.sourceCommit && observed.targetSha256 === plan.targetSha256 &&
    observed.inventorySha256 === frontendCoordinationHash(plan) && Array.isArray(observed.surfaces) &&
    observed.surfaces.length === plan.externalSurfaces.length);
  const rows = [...observed.surfaces].sort((a, b) => String(a?.surfaceSha256).localeCompare(String(b?.surfaceSha256)));
  const summaries = []; let bytesRetained = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i], expected = plan.externalSurfaces[i];
    demand(row?.surfaceSha256 === expected.surfaceSha256 && Buffer.isBuffer(row.evidence) &&
      row.evidence.length > 0 && row.evidence.length <= 2_000_000 && digest(row.evidenceSha256) &&
      frontendCoordinationHash(row.evidence) === row.evidenceSha256);
    let evidence; try { evidence = JSON.parse(row.evidence.toString("utf8")); } catch { demand(false); }
    demand(evidence?.version === 1 && evidence.nonce === nonce && evidence.actionId === plan.actionId &&
      evidence.targetSha256 === plan.targetSha256 && evidence.sourceCommit === plan.sourceCommit &&
      evidence.surfaceSha256 === expected.surfaceSha256 && evidence.identitySha256 === expected.identitySha256 && evidence.kind === expected.kind &&
      (Number.isSafeInteger(evidence.activeExecutions) && evidence.activeExecutions >= 0 || !requireFenced && evidence.activeExecutions === null) &&
      (Number.isSafeInteger(evidence.uncertainEffects) && evidence.uncertainEffects >= 0 || !requireFenced && evidence.uncertainEffects === null) &&
      digest(evidence.observationSha256) && digest(evidence.reconciliationSha256));
    for (const [key, expectedHash] of [["observation", evidence.observationSha256], ["reconciliation", evidence.reconciliationSha256]]) {
      demand(Buffer.isBuffer(row[key]) && row[key].length > 0 && row[key].length <= 2_000_000 && frontendCoordinationHash(row[key]) === expectedHash);
      bytesRetained += row[key].length;
    }
    bytesRetained += row.evidence.length; demand(bytesRetained <= 32_000_000);
    const fencedState = expected.kind === "provider" ? ["credentials-retired-and-effects-reconciled", "source-inapplicable-and-effects-reconciled"].includes(evidence.state) :
      expected.kind === "scheduler" ? evidence.state === "disabled-and-running-executions-reconciled" :
        ["retired-and-effects-reconciled", "admission-bound-and-effects-reconciled"].includes(evidence.state);
    if (evidence.activeExecutions === null || evidence.uncertainEffects === null) demand(evidence.state === "unfenced");
    demand(requireFenced ? fencedState && evidence.activeExecutions === 0 && evidence.uncertainEffects === 0 : fencedState || evidence.state === "unfenced");
    await retain(`${nonce}-${expected.surfaceSha256}.json`, row.evidence);
    await retain(`${nonce}-${frontendCoordinationHash({ surfaceSha256: expected.surfaceSha256, artifact: "observation" })}.json`, row.observation);
    await retain(`${nonce}-${frontendCoordinationHash({ surfaceSha256: expected.surfaceSha256, artifact: "reconciliation" })}.json`, row.reconciliation);
    summaries.push({ surfaceSha256: expected.surfaceSha256, evidenceSha256: row.evidenceSha256,
      observationSha256: evidence.observationSha256, reconciliationSha256: evidence.reconciliationSha256,
      state: evidence.state, activeExecutions: evidence.activeExecutions, uncertainEffects: evidence.uncertainEffects });
  }
  return { nonce, inventorySha256: frontendCoordinationHash(plan), surfaces: summaries };
}
