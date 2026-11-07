import assert from "node:assert/strict";
import test from "node:test";
import { lifecycleWitnessPublicReceipt, p2LifecycleStateWitnessSha256, validateP2LifecycleStateWitness } from "./p2-lifecycle-state-witness.mjs";

const uuid = suffix => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
const sha = digit => digit.repeat(64);
function witness() {
  const command = { commandId: uuid("10"), accountVersion: 4, action: "delete", issuedAt: "2026-11-06T12:00:00.000Z", canonicalSha256: sha("a") };
  const counts = {
    frontend: { accountRows: 1, commandRows: 4, deliveryRows: 8, exportRows: 1, sessionRows: 0, providerLinkRows: 0, verificationTokenRows: 0, preferenceRows: 0 },
    course: { accountRows: 1, commandRows: 4, exportRows: 0, progressRows: 0, attemptRows: 1, grantRows: 1 },
    community: { accountRows: 1, commandRows: 4, exportRows: 0, projectionRows: 1, inboxRows: 1 },
  };
  return { version: 1, profile: "delete-persisted-v1", environment: "staging", candidateSha256: sha("1"), configurationSha256: sha("2"),
    sources: { frontend: "1".repeat(40), course: "2".repeat(40), community: "3".repeat(40) }, targetSha256: { frontend: sha("3"), course: sha("4"), community: sha("5") },
    userId: uuid("1"), command, frontend: { status: "deleted", accountVersion: 4, latestCommandId: command.commandId, commandCount: 4, laterCommandCount: 0,
      pendingOrDeliveringCount: 0, deliveries: ["course", "community"].map((receiver, index) => ({ receiver, status: "acknowledged", attempts: 1, leaseId: null, leaseUntil: null, acknowledgedAt: `2026-11-06T12:00:0${index + 1}.000Z` })) },
    receivers: Object.fromEntries(["course", "community"].map((service, index) => [service, { status: "deleted", accountVersion: 4, latestCommandId: command.commandId, commandCount: 4,
      knownCommand: { id: command.commandId, version: 4, action: "delete", canonicalDigest: command.canonicalSha256, acceptedAt: `2026-11-06T12:00:0${index + 1}.000Z` } }])),
    domainSnapshots: Object.fromEntries(Object.entries(counts).map(([service, serviceCounts]) => [service, { profileId: "delete-persisted-v1", rowCount: Object.values(serviceCounts).reduce((a, b) => a + b, 0), counts: serviceCounts, digest: sha(service === "frontend" ? "6" : service === "course" ? "7" : "8") }])), readOnly: true };
}

test("closed exact lifecycle witness validates and hashes canonically", () => {
  const value = witness();
  assert.equal(validateP2LifecycleStateWitness(value), value);
  assert.match(p2LifecycleStateWitnessSha256(value), /^[a-f0-9]{64}$/u);
  const reordered = Object.fromEntries(Object.entries(value).reverse());
  assert.equal(p2LifecycleStateWitnessSha256(reordered), p2LifecycleStateWitnessSha256(value));
});

test("common receipt contains only bounded counts and hashes", () => {
  const value = witness(), receipt = lifecycleWitnessPublicReceipt(value), serialized = JSON.stringify(receipt);
  assert.equal(receipt.receiverAcknowledgedCount, 2);
  assert.equal(receipt.pendingOrDeliveringCount, 0);
  for (const secret of [value.userId, value.command.commandId, value.command.issuedAt, value.frontend.deliveries[0].acknowledgedAt]) assert.equal(serialized.includes(secret), false);
});

test("changed shapes, receiver digests, row counts and delivery order refuse", () => {
  for (const mutate of [
    value => { value.extra = true; },
    value => { value.receivers.course.knownCommand.canonicalDigest = "f".repeat(64); },
    value => { value.domainSnapshots.course.rowCount++; },
    value => { value.frontend.deliveries.reverse(); },
  ]) {
    const value = structuredClone(witness()); mutate(value);
    assert.throws(() => validateP2LifecycleStateWitness(value), /P2_LIFECYCLE_STATE_WITNESS_REFUSED/u);
  }
});
