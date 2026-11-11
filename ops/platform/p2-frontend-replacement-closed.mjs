import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { withP2FrontendReplacementClosedProbe, withP2FrontendReplacementRecoveryProbe } from "./p2-frontend-replacement-abort.mjs";
import { validateP2FrontendReplacementProbe, verifyP2FrontendReplacementObservation } from "./p2-frontend-replacement-probe.mjs";
import { prepareP2FrontendReplacementWrittenReadback, readP2FrontendReplacementImagePacket,
  replacementReceiptBytes } from "./p2-frontend-replacement-written.mjs";
import { decodeQualificationTargetJson } from "./qualification-target-profile.mjs";

const refusal = "P2_FRONTEND_REPLACEMENT_CLOSED_OBSERVATION_REFUSED";
const demand = condition => { if (!condition) throw new Error(refusal); };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

function selectClosedPacket(packet) {
  demand(packet && Object.getPrototypeOf(packet) === Object.prototype);
  const { writtenObservation, ...writtenPacket } = Object.getOwnPropertyDescriptors(packet);
  demand(writtenObservation?.enumerable && Object.hasOwn(writtenObservation, "value"));
  const raw = replacementReceiptBytes(writtenObservation.value, 8192);
  const selected = prepareP2FrontendReplacementWrittenReadback(Object.defineProperties({}, writtenPacket));
  demand(isDeepStrictEqual(decodeQualificationTargetJson(raw, "carrier"), selected.proof));
  return { ...selected, writtenObservationSha256: hash(raw) };
}

export async function observeP2FrontendReplacementClosed(packet, { getUrl }) {
  try {
    const { probe, proof, verify, writtenObservationSha256 } = selectClosedPacket(packet);
    await withP2FrontendReplacementClosedProbe(probe, getUrl, verify);
    return { ...proof, operation: "verify-replacement-closed", status: "P2_FRONTEND_REPLACEMENT_SESSION_CLOSED",
      writtenObservationSha256,
      originalBackendAbsent: true, originalLocksAbsent: true, observationLockReleased: true };
  } catch {
    throw new Error(refusal);
  }
}

// The host caller authenticates the original receipt bytes and holds the
// staging release lock. This session gives no authority to replay SQL.
export async function withP2FrontendReplacementRecovery(packet, { getUrl, signal }, work) {
  try {
    demand(typeof work === "function" && packet && Object.getPrototypeOf(packet) === Object.prototype);
    const { abortObservation, ...closedFields } = Object.getOwnPropertyDescriptors(packet);
    demand(abortObservation?.enumerable && Object.hasOwn(abortObservation, "value"));
    const closed = Object.defineProperties({}, closedFields);
    const { probe, proof, verify, writtenObservationSha256 } = selectClosedPacket(closed);
    const { migrations } = validateP2FrontendReplacementProbe(probe);
    const physical = verifyP2FrontendReplacementObservation(probe, replacementReceiptBytes(closed.physicalObservation, 8192));
    const raw = replacementReceiptBytes(abortObservation.value, 65_536);
    const actual = decodeQualificationTargetJson(raw, "carrier");
    const { backendTerminated, observedAt } = actual;
    const appliedPrefix = migrations.map(({ tag, hash, folderMillis }) => ({ tag, hash, folderMillis }));
    demand(typeof backendTerminated === "boolean" && typeof observedAt === "string" &&
      Number.isFinite(Date.parse(observedAt)) && new Date(observedAt).toISOString() === observedAt &&
      Date.parse(observedAt) >= Date.parse(probe.backendStart));
    demand(isDeepStrictEqual(actual, { ...physical, operation: "observe-after-replacement-abort",
      status: "P2_FRONTEND_REPLACEMENT_ABORT_OBSERVED", physicalObservationSha256: proof.physicalObservationSha256,
      observedAt, backendTerminated, originalBackendAbsent: true, originalLocksAbsent: true, observationLockReleased: true,
      journalPresent: true, appliedPrefix, appliedPrefixSha256: hash(JSON.stringify(appliedPrefix)), replayAuthorized: false }));
    return await withP2FrontendReplacementRecoveryProbe(probe, getUrl, verify, lease => work({
      ...lease, retained: Object.freeze({ databaseReceiptSha256: proof.databaseReceiptSha256,
        writtenObservationSha256, abortObservationSha256: hash(raw) }),
    }), signal);
  } catch {
    throw new Error("P2_FRONTEND_REPLACEMENT_RECOVERY_OBSERVATION_REFUSED");
  }
}

export async function runP2FrontendReplacementClosedCli(sourceCommit) {
  const packet = readP2FrontendReplacementImagePacket(sourceCommit);
  const observation = await observeP2FrontendReplacementClosed(packet, {
    getUrl: () => process.env.FRONTEND_STAGING_MIGRATION_DATABASE_URL,
  });
  console.log(JSON.stringify(observation));
}
