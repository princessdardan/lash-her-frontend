import { createHash } from "node:crypto";
import { prepareP2LifecyclePersistencePlan } from "./p2-lifecycle-persistence-probe.mjs";
export const receiverFixtureUuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const receiverFixtureHash = value => createHash("sha256").update(value).digest("hex");
const canonical = value => JSON.stringify(value, (_key, child) => child && typeof child === "object" && !Array.isArray(child)
  ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);
export function receiverWitnessFixture() {
  const userId = receiverFixtureUuid(1), commandId = receiverFixtureUuid(10), issuedAt = "2026-11-06T12:00:00.000Z";
  const original = { version: 1, commandId, userId, accountVersion: 1, action: "suspend", issuedAt };
  const command = { commandId, accountVersion: 1, action: "suspend", issuedAt, canonicalSha256: receiverFixtureHash(canonical(original)) };
  const counts = { frontend: { accountRows: 1, commandRows: 1, deliveryRows: 2, exportRows: 0, sessionRows: 0, providerLinkRows: 0, verificationTokenRows: 0, preferenceRows: 0 },
    course: { accountRows: 1, commandRows: 1, exportRows: 0, progressRows: 0, attemptRows: 0, grantRows: 0 },
    community: { accountRows: 1, commandRows: 1, exportRows: 0, projectionRows: 0, inboxRows: 0 } };
  return { version: 1, profile: "lifecycle-account-v1", environment: "staging", candidateSha256: "1".repeat(64), configurationSha256: "2".repeat(64),
    sources: { frontend: "1".repeat(40), course: "2".repeat(40), community: "3".repeat(40) },
    targetSha256: { frontend: "3".repeat(64), course: "4".repeat(64), community: "5".repeat(64) }, userId, command,
    frontend: { status: "suspended", accountVersion: 1, latestCommandId: commandId, commandCount: 1, laterCommandCount: 0, pendingOrDeliveringCount: 0,
      deliveries: ["course", "community"].map(receiver => ({ receiver, status: "acknowledged", attempts: 1, leaseId: null, leaseUntil: null, acknowledgedAt: issuedAt })) },
    receivers: Object.fromEntries(["course", "community"].map(service => [service, { status: "suspended", accountVersion: 1, latestCommandId: commandId, commandCount: 1,
      knownCommand: { id: commandId, version: 1, action: "suspend", canonicalDigest: command.canonicalSha256, acceptedAt: issuedAt } }])),
    domainSnapshots: Object.fromEntries(Object.entries(counts).map(([service, item]) => [service, { profileId: "lifecycle-account-v1", rowCount: Object.values(item).reduce((a, b) => a + b, 0), counts: item, digest: receiverFixtureHash(service) }])), readOnly: true };
}
export function receiverPostFixture(caseName = "exact-replay", service = "course") {
  const gateway = Buffer.from(JSON.stringify({ appEnv: "staging", courseOrigin: "https://course-tls:8443", communityOrigin: "https://community-tls:8443", upstreamCaFile: "/tls/ca.pem" }));
  const ca = Buffer.from("OWNED-UNIT-CA-NOT-A-CREDENTIAL");
  return { input: { version: 1, mode: "post", environment: "staging", service, case: caseName, bindingSha256: "a".repeat(64), witness: receiverWitnessFixture(),
    freshCommandId: ["stale-restore", "future-gap"].includes(caseName) ? receiverFixtureUuid(20) : null,
    secret: "OWNED-SYNTHETIC-UNIT-KEY-NEVER-LIVE".repeat(2), gatewayConfigurationSha256: receiverFixtureHash(gateway), gatewayCaSha256: receiverFixtureHash(ca) }, gateway, ca };
}
export function receiverReviewedFixture() {
  const witness = receiverWitnessFixture();
  const targets = Object.fromEntries(["frontend", "course", "community"].map(service => [service, { targetSha256: witness.targetSha256[service], host: "localhost", port: 5432,
    database: "owned_" + service, runtimeRole: "owned_" + service, runtimeRoleOid: "1234", serverMajor: 16 }]));
  const plan = prepareP2LifecyclePersistencePlan({ version: 1, environment: "staging", releaseId: "owned", candidateSha256: witness.candidateSha256,
    configurationSha256: witness.configurationSha256, sources: witness.sources, targets, containerImages: { course: "sha256:" + "6".repeat(64), community: "sha256:" + "7".repeat(64) },
    operatorSourceSha256: "8".repeat(64), frontendDeploymentSha256: "9".repeat(64), originalReleaseSha256: "a".repeat(64), expectedMigrations: { frontend: 83, course: 22, community: 11 } });
  return { version: 1, environment: "staging", profile: "suspended-head-negatives-v1", actionId: "owned-negatives", persistence: { version: 1, environment: "staging", plan,
    containers: ["community-api", "course-api", "community-tls", "course-tls", "course-snapshot", "community-worker", "course-media", "course-export-cleanup", "course-publisher", "gateway"]
      .map((service, index) => ({ service, containerId: String(index).repeat(64), image: "ghcr.io/princessdardan/lash-her-owned@sha256:" + "e".repeat(64), health: service.endsWith("-tls") ? "none" : "healthy" })),
    probeId: "owned-persistence", operatorFiles: Object.fromEntries(["ops/platform/p2-lifecycle-state-witness.mjs", "ops/platform/p2-lifecycle-persistence-probe.mjs",
      "ops/platform/host/p2_lifecycle_persistence_scope.py", "ops/platform/host/p2_lifecycle_persistence_probe.py"].map(name => [name, "d".repeat(64)])),
    programSha256: "f".repeat(64), privateDirectory: "/var/lib/lash-her/releases/staging/owned-persistence" },
  programSha256: "b".repeat(64), operatorSourceFiles: { "ops/platform/p2-lifecycle-receiver-post.mjs": "c".repeat(64) },
  privateDirectory: "/var/lib/lash-her/releases/staging/owned-negatives" };
}
