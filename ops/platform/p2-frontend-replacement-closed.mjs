import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { withP2FrontendReplacementClosedProbe } from "./p2-frontend-replacement-abort.mjs";
import { prepareP2FrontendReplacementWrittenReadback, readP2FrontendReplacementImagePacket,
  replacementReceiptBytes } from "./p2-frontend-replacement-written.mjs";
import { decodeQualificationTargetJson } from "./qualification-target-profile.mjs";

const refusal = "P2_FRONTEND_REPLACEMENT_CLOSED_OBSERVATION_REFUSED";
const demand = condition => { if (!condition) throw new Error(refusal); };

export async function observeP2FrontendReplacementClosed(packet, { getUrl }) {
  try {
    demand(packet && Object.getPrototypeOf(packet) === Object.prototype);
    const { writtenObservation, ...writtenPacket } = Object.getOwnPropertyDescriptors(packet);
    demand(writtenObservation?.enumerable && Object.hasOwn(writtenObservation, "value"));
    const raw = replacementReceiptBytes(writtenObservation.value, 8192);
    const { probe, proof, verify } = prepareP2FrontendReplacementWrittenReadback(Object.defineProperties({}, writtenPacket));
    demand(isDeepStrictEqual(decodeQualificationTargetJson(raw, "carrier"), proof));

    await withP2FrontendReplacementClosedProbe(probe, getUrl, verify);
    return { ...proof, operation: "verify-replacement-closed", status: "P2_FRONTEND_REPLACEMENT_SESSION_CLOSED",
      writtenObservationSha256: createHash("sha256").update(raw).digest("hex"),
      originalBackendAbsent: true, originalLocksAbsent: true, observationLockReleased: true };
  } catch {
    throw new Error(refusal);
  }
}

export async function runP2FrontendReplacementClosedCli(sourceCommit) {
  const packet = readP2FrontendReplacementImagePacket(sourceCommit);
  const observation = await observeP2FrontendReplacementClosed(packet, {
    getUrl: () => process.env.FRONTEND_STAGING_MIGRATION_DATABASE_URL,
  });
  console.log(JSON.stringify(observation));
}
