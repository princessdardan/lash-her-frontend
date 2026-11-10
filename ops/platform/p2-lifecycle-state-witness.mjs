import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const ACTIONS = Object.freeze(["suspend", "restore", "export", "delete"]);
const STATUSES = Object.freeze(["active", "suspended", "deleted"]);
const PROFILES = Object.freeze([
  "lifecycle-account-v1", "export-ready-v1", "export-scrubbed-v1",
  "delete-baseline-v1", "delete-persisted-v1",
]);
const COUNT_NAMES = Object.freeze({
  frontend: Object.freeze(["accountRows", "commandRows", "deliveryRows", "exportRows", "sessionRows", "providerLinkRows", "verificationTokenRows", "preferenceRows"]),
  course: Object.freeze(["accountRows", "commandRows", "exportRows", "progressRows", "attemptRows", "grantRows"]),
  community: Object.freeze(["accountRows", "commandRows", "exportRows", "projectionRows", "inboxRows"]),
});

export class P2LifecycleStateWitnessError extends Error {
  constructor(check) { super("P2_LIFECYCLE_STATE_WITNESS_REFUSED"); this.check = check; }
}
const demand = (condition, check) => { if (!condition) throw new P2LifecycleStateWitnessError(check); };
const closed = (value, fields) => Boolean(value && typeof value === "object" && !Array.isArray(value)
  && isDeepStrictEqual(Object.keys(value).sort(), [...fields].sort()));
const integer = value => Number.isSafeInteger(value) && value >= 0;
const canonical = value => JSON.stringify(value, (_key, child) => child && typeof child === "object" && !Array.isArray(child)
  ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);

export function p2LifecycleStateWitnessSha256(value) {
  return createHash("sha256").update(canonical(validateP2LifecycleStateWitness(value))).digest("hex");
}

export function validateP2LifecycleStateWitness(value) {
  demand(closed(value, ["version", "profile", "environment", "candidateSha256", "configurationSha256", "sources", "targetSha256", "userId", "command", "frontend", "receivers", "domainSnapshots", "readOnly"]), "witness-shape");
  demand(value.version === 1 && value.environment === "staging" && PROFILES.includes(value.profile) && value.readOnly === true
    && SHA.test(value.candidateSha256) && SHA.test(value.configurationSha256) && UUID.test(value.userId), "witness-binding");
  demand(closed(value.sources, ["frontend", "course", "community"]) && Object.values(value.sources).every(item => COMMIT.test(item)), "source-binding");
  demand(closed(value.targetSha256, ["frontend", "course", "community"]) && Object.values(value.targetSha256).every(item => SHA.test(item)), "target-binding");

  const command = value.command;
  demand(closed(command, ["commandId", "accountVersion", "action", "issuedAt", "canonicalSha256"]) && UUID.test(command.commandId)
    && Number.isSafeInteger(command.accountVersion) && command.accountVersion >= 1 && ACTIONS.includes(command.action)
    && ISO.test(command.issuedAt) && SHA.test(command.canonicalSha256), "command-binding");

  const frontend = value.frontend;
  demand(closed(frontend, ["status", "accountVersion", "latestCommandId", "commandCount", "deliveries", "laterCommandCount", "pendingOrDeliveringCount"])
    && STATUSES.includes(frontend.status) && frontend.accountVersion === command.accountVersion && UUID.test(frontend.latestCommandId)
    && integer(frontend.commandCount) && integer(frontend.laterCommandCount) && integer(frontend.pendingOrDeliveringCount)
    && Array.isArray(frontend.deliveries) && frontend.deliveries.length === 2, "frontend-state");
  const expectedReceivers = ["course", "community"];
  for (let index = 0; index < frontend.deliveries.length; index++) {
    const delivery = frontend.deliveries[index];
    demand(closed(delivery, ["receiver", "status", "attempts", "leaseId", "leaseUntil", "acknowledgedAt"])
      && delivery.receiver === expectedReceivers[index] && ["pending", "delivering", "acknowledged", "blocked"].includes(delivery.status)
      && integer(delivery.attempts) && (delivery.leaseId === null || UUID.test(delivery.leaseId))
      && (delivery.leaseUntil === null || ISO.test(delivery.leaseUntil)) && (delivery.acknowledgedAt === null || ISO.test(delivery.acknowledgedAt)), "delivery-state");
  }

  demand(closed(value.receivers, ["course", "community"]), "receiver-set");
  for (const service of expectedReceivers) {
    const receiver = value.receivers[service], known = receiver?.knownCommand;
    demand(closed(receiver, ["status", "accountVersion", "latestCommandId", "commandCount", "knownCommand"])
      && STATUSES.includes(receiver.status) && receiver.accountVersion === command.accountVersion && UUID.test(receiver.latestCommandId)
      && integer(receiver.commandCount) && closed(known, ["id", "version", "action", "canonicalDigest", "acceptedAt"])
      && known.id === command.commandId && known.version === command.accountVersion && known.action === command.action
      && known.canonicalDigest === command.canonicalSha256 && ISO.test(known.acceptedAt), "receiver-state");
  }

  demand(closed(value.domainSnapshots, ["frontend", "course", "community"]), "snapshot-set");
  for (const service of ["frontend", ...expectedReceivers]) {
    const snapshot = value.domainSnapshots[service];
    demand(closed(snapshot, ["profileId", "rowCount", "counts", "digest"]) && snapshot.profileId === value.profile
      && integer(snapshot.rowCount) && SHA.test(snapshot.digest) && closed(snapshot.counts, COUNT_NAMES[service])
      && Object.values(snapshot.counts).every(integer)
      && snapshot.rowCount === Object.values(snapshot.counts).reduce((sum, count) => sum + count, 0), "snapshot-state");
  }
  return value;
}

export function lifecycleWitnessPublicReceipt(value) {
  const witness = validateP2LifecycleStateWitness(value);
  return Object.freeze({
    version: 1,
    status: "P2_LIFECYCLE_STATE_WITNESS_RETAINED",
    profile: witness.profile,
    candidateSha256: witness.candidateSha256,
    configurationSha256: witness.configurationSha256,
    sourceSha256: createHash("sha256").update(canonical(witness.sources)).digest("hex"),
    targetSha256: createHash("sha256").update(canonical(witness.targetSha256)).digest("hex"),
    witnessSha256: p2LifecycleStateWitnessSha256(witness),
    commandCount: witness.frontend.commandCount,
    pendingOrDeliveringCount: witness.frontend.pendingOrDeliveringCount,
    receiverAcknowledgedCount: witness.frontend.deliveries.filter(row => row.status === "acknowledged").length,
    rowCounts: Object.fromEntries(Object.entries(witness.domainSnapshots).map(([service, snapshot]) => [service, snapshot.rowCount])),
    readOnly: true,
  });
}

export const P2_LIFECYCLE_STATE_WITNESS_PROFILES = PROFILES;
export const P2_LIFECYCLE_STATE_WITNESS_COUNT_NAMES = COUNT_NAMES;
