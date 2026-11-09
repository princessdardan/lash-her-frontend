import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { frontendCandidateSurfaces } from "./frontend-release-inventory.mjs";
import { frontendPrivateReceiptDirectory } from "./frontend-release-receipts.mjs";
import { frontendWriterInventory } from "./frontend-writer-inventory.mjs";
import { prepareP2CertificationProfile } from "./p2-certification-profile.mjs";
import { readReviewedFrontendReplacementArm } from "./p2-frontend-replacement-arm.mjs";
import { P2_PROFILED_CURRENT_CONFIGURATION_FILES } from "./p2-profiled-current-release.mjs";
import { validateP2HostSettings, validateP2PriorGatewayReference } from "./p2-release.mjs";
import { decodeQualificationTargetJson, requireQualificationTargetProfile, resolveQualificationTargetProfile,
  STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const refusal = "P2_FRONTEND_REPLACEMENT_RELEASE_REVIEW_REFUSED";
const metadataMaximum = 65_536;
const serviceNames = ["course", "community"];
const settingsFields = ["version", "qualificationTargetProfile", "environment", "arm", "configuration",
  "runtimeReviewFile", "runtimeReviewSha256", "writerReviewFile", "providerContext"];
const runtimeFields = ["version", "qualificationTargetProfile", "environment", "releaseId", "sourceCommit", "candidateSha256",
  "targetSha256", "reviewedPlanSha256", "hostMachineId", "configuration", "configurationSha256", "apiJobSha256", "certification", "producerSha256"];
const writerFields = ["version", "qualificationTargetProfile", "sourceCommit", "targetSha256", "sourceInventorySha256",
  "adaptersSha256", "gatewayBindingSha256", "candidateCoverage"];
const coverageFields = ["surfaceSha256", "disposition", "evidenceSha256"];
const demand = condition => { if (!condition) throw new Error(refusal); };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const digest = value => typeof value === "string" && /^(?!0+$)[a-f0-9]{64}$/u.test(value);
const absolute = value => typeof value === "string" && value.length <= 4096 && resolve(value) === value;
const exact = (value, fields) => value && Object.getPrototypeOf(value) === Object.prototype &&
  Reflect.ownKeys(value).length === fields.length && fields.every(field => {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    return descriptor?.enumerable && Object.hasOwn(descriptor, "value");
  });
const disjoint = (left, right) => left !== right && !left.startsWith(right + "/") && !right.startsWith(left + "/");

function immutable(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(immutable);
    Object.freeze(value);
  }
  return value;
}

function privateBytes(path, maximum) {
  demand(absolute(path));
  frontendPrivateReceiptDirectory(dirname(path));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    demand(before.isFile() && before.nlink === 1 && before.uid === process.getuid() && (before.mode & 0o077) === 0 &&
      before.size > 0 && before.size <= maximum);
    const raw = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < raw.length) {
      const count = readSync(fd, raw, offset, raw.length - offset, null);
      demand(count > 0);
      offset += count;
    }
    demand(readSync(fd, Buffer.alloc(1), 0, 1, null) === 0);
    const after = fstatSync(fd);
    demand(["dev", "ino", "size", "mode", "uid", "nlink", "mtimeMs", "ctimeMs"].every(key => before[key] === after[key]));
    return raw;
  } finally { closeSync(fd); }
}

function requireRuntimeReview(runtimeReview, settings, plan) {
  const priorSelected = Object.hasOwn(runtimeReview ?? {}, "priorGatewayReference");
  demand(exact(runtimeReview, [...runtimeFields, ...(priorSelected ? ["priorGatewayReference"] : [])]) &&
    runtimeReview.version === 1 && runtimeReview.environment === "staging" && runtimeReview.releaseId === plan.releaseId &&
    runtimeReview.sourceCommit === plan.sourceCommit && runtimeReview.targetSha256 === plan.targetSha256 &&
    runtimeReview.candidateSha256 === plan.candidateSha256 && runtimeReview.reviewedPlanSha256 === settings.arm.reviewedPlanSha256 &&
    runtimeReview.hostMachineId === settings.arm.host.machineId && digest(runtimeReview.producerSha256));
  requireQualificationTargetProfile(profile, runtimeReview, plan);
  prepareP2CertificationProfile(runtimeReview.certification);
  validateP2HostSettings({ ...settings.arm.host, configuration: runtimeReview.configuration });
  demand(runtimeReview.configuration.length <= 4096 && !runtimeReview.configuration.endsWith("/") &&
    disjoint(runtimeReview.configuration, settings.arm.host.bundle));
  const prior = validateP2PriorGatewayReference(runtimeReview.priorGatewayReference);
  demand(!prior || Object.entries(prior).every(([key, value]) => !key.endsWith("Directory") || !value.endsWith("/")));
  for (const [pins, names] of [[runtimeReview.apiJobSha256, serviceNames],
    [runtimeReview.configurationSha256, P2_PROFILED_CURRENT_CONFIGURATION_FILES]]) {
    demand(exact(pins, names) && Object.values(pins).every(digest));
  }
}

function requireApiJobs(bundle, candidate, pins) {
  for (const name of serviceNames) {
    const raw = privateBytes(join(bundle, "jobs", name + ".json"), metadataMaximum);
    demand(hash(raw) === pins[name]);
    const job = decodeQualificationTargetJson(raw, "carrier"), target = job?.target;
    requireQualificationTargetProfile(profile, job, target);
    demand(job.schemaVersion === 2 && job.kind === "operator-migration" && job.operator === "Dardan" &&
      job.environment === "staging" && job.releaseId === candidate.releaseId && job.sourceCommit === candidate.sources[name].commit &&
      job.contractPhase === "p2" && job.phase2ContractManifestSha256 === candidate.phase2ContractManifestSha256 &&
      job.contractSha256 === candidate.contractManifestSha256.slice(7) &&
      job.migrationImageDigest === candidate.artifacts[name + "Migration"].image.split("@")[1] &&
      job.runtimeImageDigest === candidate.artifacts[name + "Runtime"].image.split("@")[1] &&
      typeof job.runtimeRole === "string" && /^[a-z][a-z0-9_]{0,62}$/u.test(job.runtimeRole) && job.runtimeRole !== target.user &&
      target.schemaVersion === 2 && target.service === `lash-her-${name}-api` && target.environment === "staging" &&
      typeof target.host === "string" && /^[a-z0-9.-]+$/u.test(target.host) && !target.host.includes("-pooler") &&
      [target.database, target.user].every(value => typeof value === "string" && /^[A-Za-z0-9_-]+$/u.test(value)) &&
      Array.isArray(target.approvedPendingTags) && target.approvedPendingTags.every(tag => typeof tag === "string" && /^\d{4}_[a-z0-9_]+$/u.test(tag)) &&
      digest(job.schemaBaselineSha256) &&
      hash(privateBytes(join(bundle, "schema", name + ".json"), 2_000_000)) === job.schemaBaselineSha256);
  }
}

function requireConfiguration(configuration, runtimeReview, candidate) {
  const { configurationSha256, releaseId, candidateSha256, hostMachineId } = runtimeReview;
  const metadata = {};
  for (const name of P2_PROFILED_CURRENT_CONFIGURATION_FILES) {
    const raw = privateBytes(join(configuration, name), metadataMaximum);
    demand(hash(raw) === configurationSha256[name]);
    if (name.endsWith(".json")) metadata[name] = decodeQualificationTargetJson(raw, "carrier");
  }
  const runtime = metadata["runtime.json"], gateway = metadata["gateway.json"];
  requireQualificationTargetProfile(profile, runtime);
  demand(exact(runtime, ["version", "qualificationTargetProfile", "environment", "releaseId", "hostMachineId", "maintenanceRef", "previousReleaseRef"]) &&
    runtime.version === 2 && runtime.environment === "staging" && runtime.releaseId === releaseId && runtime.hostMachineId === hostMachineId &&
    ["maintenanceRef", "previousReleaseRef"].every(key => typeof runtime[key] === "string" && /^[A-Za-z0-9_./:-]{1,200}$/u.test(runtime[key])));
  const definition = resolveQualificationTargetProfile(profile);
  demand(gateway && !Object.hasOwn(gateway, "qualificationTargetProfile") && gateway.appEnv === "staging" &&
    gateway.environment === "production" && gateway.maintenance === true &&
    gateway.ownerId === definition.frontend.teamId && gateway.projectId === candidate.workload.projectId &&
    gateway.projectId === definition.frontend.projectId && `https://${gateway.publicHost}` === definition.gateway.publicOrigin &&
    gateway.courseOrigin === "https://course-tls:8443" && [undefined, null, "https://community-tls:8443"].includes(gateway.communityOrigin) &&
    gateway.tlsKeyFile === "/tls/key.pem" && gateway.tlsCertFile === "/tls/cert.pem" && gateway.upstreamCaFile === "/tls/ca.pem" &&
    isDeepStrictEqual(gateway.admission, { file: "/admission/state.json", releaseId, candidateSha256 }));
  demand(candidate.runtime?.composeSha256 === "sha256:" + hash(readFileSync(join(root, "ops/platform/compose.yaml"))));
  for (const name of serviceNames) {
    const expected = candidate.runtime?.privateTlsPolicies?.[name];
    demand(expected && Object.getPrototypeOf(expected) === Object.prototype && isDeepStrictEqual(metadata[name + "-tls.json"], expected));
  }
}

function requireWriterReview(writerReview, runtimeReview) {
  demand(exact(writerReview, writerFields) && writerReview.version === 1 &&
    writerReview.sourceCommit === runtimeReview.sourceCommit && writerReview.targetSha256 === runtimeReview.targetSha256 &&
    digest(writerReview.adaptersSha256) && digest(writerReview.gatewayBindingSha256));
  requireQualificationTargetProfile(profile, writerReview);
  const inventory = frontendWriterInventory(root);
  demand(writerReview.sourceInventorySha256 === hash(JSON.stringify(inventory)));
  const expected = new Set(frontendCandidateSurfaces(inventory).map(row => row.surfaceSha256));
  demand(Array.isArray(writerReview.candidateCoverage) && writerReview.candidateCoverage.length === expected.size);
  for (const row of writerReview.candidateCoverage) {
    demand(exact(row, coverageFields) && expected.delete(row.surfaceSha256) && digest(row.evidenceSha256) &&
      ["admitted", "read-only", "closed"].includes(row.disposition));
  }
  demand(expected.size === 0);
}

// Review binds original private bytes and candidate source coverage. A later
// custody step verifies exact source, provider observation and the held host.
export function prepareP2FrontendReplacementReleaseReview(settings) {
  try {
    demand(exact(settings, settingsFields) && settings.version === 1 && settings.environment === "staging" &&
      digest(settings.runtimeReviewSha256) && ["configuration", "runtimeReviewFile", "writerReviewFile", "providerContext"]
        .every(key => absolute(settings[key])));
    requireQualificationTargetProfile(profile, settings, settings.arm);
    frontendPrivateReceiptDirectory(settings.configuration);
    frontendPrivateReceiptDirectory(dirname(settings.providerContext));
    const { prepared, bytes: armBytes } = readReviewedFrontendReplacementArm(settings.arm);
    const { plan, probe, administrativeLogins } = prepared;
    demand(disjoint(settings.configuration, settings.arm.bundle));
    const reviewedPlanBytes = privateBytes(settings.arm.reviewedPlanFile, metadataMaximum);
    demand(reviewedPlanBytes.equals(armBytes));
    const runtimeReviewBytes = privateBytes(settings.runtimeReviewFile, metadataMaximum);
    demand(hash(runtimeReviewBytes) === settings.runtimeReviewSha256);
    const runtimeReview = decodeQualificationTargetJson(runtimeReviewBytes, "carrier");
    requireRuntimeReview(runtimeReview, settings, plan);
    const writerReviewBytes = privateBytes(settings.writerReviewFile, 2_000_000);
    demand(hash(writerReviewBytes) === runtimeReview.producerSha256);
    const writerReview = decodeQualificationTargetJson(writerReviewBytes, "carrier");
    requireWriterReview(writerReview, runtimeReview);
    requireApiJobs(settings.arm.bundle, probe.candidate, runtimeReview.apiJobSha256);
    requireConfiguration(settings.configuration, runtimeReview, probe.candidate);
    return Object.freeze({ plan, probe, administrativeLogins, reviewedPlanBytes, runtimeReviewBytes, writerReviewBytes,
      runtimeReview: immutable(runtimeReview), writerReview: immutable(writerReview), settings: immutable(structuredClone(settings)) });
  } catch { throw new Error(refusal); }
}
