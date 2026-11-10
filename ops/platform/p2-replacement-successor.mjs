import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { frontendCoordinationHash as hash } from "./frontend-release-inventory.mjs";
import { frontendPrivateReceiptDirectory } from "./frontend-release-receipts.mjs";
import { validP2CertificationReplacementDescriptor } from "./p2-certification-replacement-release.mjs";
import { p2NativeHash } from "./p2-lifecycle-native.mjs";
import { validateP2HostSettings } from "./p2-release.mjs";
import { decodeQualificationTargetJson, requireQualificationTargetProfile,
  STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";

const refusal = "P2_REPLACEMENT_SUCCESSOR_RUNTIME_REFUSED";
const receiptName = "p2-replacement-successor-runtime.json";
const stagingRoot = "/var/lib/lash-her/releases/staging";
const demand = condition => { if (!condition) throw new Error(refusal); };
const digest = value => typeof value === "string" && /^(?!0+$)[a-f0-9]{64}$/u.test(value);
const action = value => typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(value);
const epoch = value => typeof value === "string" && /^[1-9][0-9]{0,17}$/u.test(value);
const exactSelection = selection => selection && Object.getPrototypeOf(selection) === Object.prototype &&
  Reflect.ownKeys(selection).length === 2 && ["receiptFile", "receiptSha256"].every(key => {
    const field = Object.getOwnPropertyDescriptor(selection, key);
    return field?.enumerable && Object.hasOwn(field, "value");
  });

function readSuccessor(selection, results) {
  demand(exactSelection(selection) && digest(selection.receiptSha256) && typeof selection.receiptFile === "string" &&
    selection.receiptFile.length <= 4096 && resolve(selection.receiptFile) === selection.receiptFile);
  frontendPrivateReceiptDirectory(results);
  const { receiptFile, receiptSha256 } = selection;
  const directory = dirname(receiptFile);
  demand(dirname(directory) === results && action(basename(directory)) && receiptFile === join(directory, receiptName));
  frontendPrivateReceiptDirectory(directory);
  const fd = openSync(receiptFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    demand(before.isFile() && before.uid === BigInt(process.getuid()) && (before.mode & 0o077n) === 0n &&
      before.nlink === 1n && before.size > 0n && before.size <= 65_536n);
    const raw = Buffer.alloc(Number(before.size));
    for (let offset = 0; offset < raw.length;) {
      const count = readSync(fd, raw, offset, raw.length - offset, null);
      demand(count > 0);
      offset += count;
    }
    demand(readSync(fd, Buffer.alloc(1), 0, 1, null) === 0);
    const after = fstatSync(fd, { bigint: true });
    demand(["dev", "ino", "uid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].every(key => before[key] === after[key]) &&
      raw.at(-1) === 10 && hash(raw) === receiptSha256);
    return decodeQualificationTargetJson(raw, "carrier");
  } finally { closeSync(fd); }
}

// The durable host copy and actual runtime still require independent checks
// before the next certification action. This selection only joins local pins.
export function prepareP2ReplacementSuccessor(selection, { original, profiledRelease, host, results, input } = {}) {
  try {
    const { plan: release, inventory } = original;
    const { replacementRelease, receiptSha256: originalReleaseReceiptSha256, planSha256: originalReleasePlanSha256 } = profiledRelease;
    requireQualificationTargetProfile(profile, release, inventory, input, input.native, input.native?.target);
    demand(validP2CertificationReplacementDescriptor(replacementRelease) &&
      isDeepStrictEqual(inventory.replacementRelease, replacementRelease) && digest(originalReleaseReceiptSha256) &&
      originalReleasePlanSha256 === replacementRelease.reviewedPlanSha256 &&
      inventory.actionId === release.releaseId && inventory.environment === release.environment &&
      inventory.targetSha256 === release.targetSha256 && inventory.sourceCommit === release.sourceCommit);
    const { machineId: hostMachineId, results: hostResults } = validateP2HostSettings(host);
    const { releaseId, sourceCommit, targetSha256, candidateSha256, configurationSha256 } = release;
    const nextAction = input.certificationActionId;
    demand(release.environment === "staging" && action(releaseId) && /^(?!0+$)[a-f0-9]{40}$/u.test(sourceCommit ?? "") &&
      [targetSha256, candidateSha256, configurationSha256?.["gateway.json"]].every(digest) &&
      host.configuration === profiledRelease.configurationDirectory &&
      host.configuration === join(hostResults, `runtime-profiled-frontend-replacement-${releaseId}`, "configuration") &&
      input.version === 2 && input.environment === "staging" && input.startState === "already-closed" &&
      action(nextAction) && nextAction !== releaseId && input.operatorSourceCommit === sourceCommit &&
      input.candidateSha256 === candidateSha256 && input.native.targetSha256 === targetSha256 &&
      input.configurationSha256 === hash(configurationSha256) && input.gatewayConfigurationSha256 === configurationSha256["gateway.json"] &&
      epoch(input.initialEpoch));

    const receipt = readSuccessor(selection, results);
    const { kind, actionId, runtimeActionId, terminalSha256, runtimeReceiptSha256, frontendSessionClosedSha256,
      frontendEpoch, runtimeInventorySha256, gatewayProcessSha256 } = receipt;
    const interrupted = kind === "interrupted-known-ack";
    demand((interrupted || kind === "known-ack") && action(actionId) && action(runtimeActionId) &&
      (actionId === runtimeActionId) === interrupted && ![nextAction, releaseId].includes(actionId) &&
      ![nextAction, releaseId].includes(runtimeActionId) && selection.receiptFile === join(results, actionId, receiptName) &&
      [terminalSha256, runtimeReceiptSha256, frontendSessionClosedSha256, runtimeInventorySha256, gatewayProcessSha256].every(digest) &&
      (!interrupted || terminalSha256 === runtimeReceiptSha256) &&
      runtimeInventorySha256 === input.runtimeInventorySha256 && gatewayProcessSha256 === input.gatewayProcessSha256 &&
      epoch(frontendEpoch) && BigInt(input.initialEpoch) >= BigInt(frontendEpoch));
    demand(isDeepStrictEqual(receipt, { version: 2, qualificationTargetProfile: profile,
      status: "P2_REPLACEMENT_SUCCESSOR_RUNTIME_VERIFIED", environment: "staging", kind, actionId, runtimeActionId,
      releaseId, sourceCommit, candidateSha256, targetSha256, hostMachineId,
      configurationCanonicalSha256: p2NativeHash(configurationSha256),
      replacementRelease, originalReleaseReceiptSha256, originalReleasePlanSha256, terminalSha256, runtimeReceiptSha256,
      frontendSessionClosedSha256, frontendEpoch, runtimeInventorySha256, gatewayProcessSha256 }));

    const configuration = interrupted
      ? join(hostResults, `p2-profiled-known-ack-restoration-${actionId}`, "runtime-interrupted", "configuration")
      : join(stagingRoot, `p2-profiled-known-ack-${runtimeActionId}`, "runtime-known-ack", "configuration");
    return { binding: Object.freeze({ kind, actionId, runtimeActionId, receiptSha256: selection.receiptSha256 }), configuration, frontendEpoch };
  } catch { throw new Error(refusal); }
}
