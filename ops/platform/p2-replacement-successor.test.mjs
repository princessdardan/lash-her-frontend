import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { frontendCoordinationHash as hash } from "./frontend-release-inventory.mjs";
import { p2NativeHash } from "./p2-lifecycle-native.mjs";
import { prepareP2ReplacementSuccessor } from "./p2-replacement-successor.mjs";
import { STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";

const stagingRoot = "/var/lib/lash-her/releases/staging";
const refusal = { message: "P2_REPLACEMENT_SUCCESSOR_RUNTIME_REFUSED" };
const name = "p2-replacement-successor-runtime.json";
const pin = char => char.repeat(64);
const serialized = value => Buffer.from(JSON.stringify(value, null, 2) + "\n");

function fixture(t, kind = "known-ack") {
  const results = realpathSync(mkdtempSync(join(tmpdir(), "p2-replacement-successor-")));
  t.after(() => rmSync(results, { force: true, recursive: true }));
  const version = 2, environment = "staging", releaseId = "owned-replacement-release", sourceCommit = "a".repeat(40);
  const base = { version, qualificationTargetProfile: profile, environment };
  const targetSha256 = pin("1"), candidateSha256 = pin("2"), hostMachineId = "a".repeat(32);
  const configurationSha256 = { "runtime.json": pin("3"), "gateway.json": pin("4") };
  const hostResults = join(stagingRoot, "owned", "results");
  const host = { machineId: hostMachineId, bundle: join(stagingRoot, "owned", "bundle"), results: hostResults,
    configuration: join(hostResults, `runtime-profiled-frontend-replacement-${releaseId}`, "configuration") };
  const replacementRelease = { version: 1, kind: "frontend-replacement", qualificationTargetProfile: profile,
    reviewedPlanSha256: pin("5"), runtimeReviewSha256: pin("6"), postflightSha256: pin("7"), frontendSessionClosedSha256: pin("8"),
    frontendDatabaseReceiptSha256: pin("9"), databaseOid: "101", migrationRoleOid: "102", predecessorRuntimeRole: "owned_previous",
    administrativeLogins: [{ name: "owned_admin_a", oid: "103" }, { name: "owned_admin_z", oid: "104" }] };
  const originalReleaseReceiptSha256 = pin("a"), originalReleasePlanSha256 = replacementRelease.reviewedPlanSha256;
  const original = { plan: { ...base, releaseId, sourceCommit, targetSha256, candidateSha256, configurationSha256 },
    inventory: { ...base, actionId: releaseId, targetSha256, sourceCommit, replacementRelease } };
  const profiledRelease = { replacementRelease, receiptSha256: originalReleaseReceiptSha256, planSha256: originalReleasePlanSha256,
    configurationDirectory: host.configuration };
  const runtimeInventorySha256 = pin("b"), gatewayProcessSha256 = pin("c");
  const input = { ...base, startState: "already-closed", certificationActionId: "owned-next-certification",
    operatorSourceCommit: sourceCommit, candidateSha256, configurationSha256: hash(configurationSha256),
    gatewayConfigurationSha256: configurationSha256["gateway.json"], runtimeInventorySha256, gatewayProcessSha256,
    initialEpoch: "9007199254740994", native: { ...base, targetSha256, target: { qualificationTargetProfile: profile } } };
  const actionId = kind === "known-ack" ? "owned-prior-certification" : "owned-prior-restoration";
  const runtimeActionId = kind === "known-ack" ? "owned-prior-recovery" : actionId;
  const receipt = { ...base, status: "P2_REPLACEMENT_SUCCESSOR_RUNTIME_VERIFIED", kind, actionId, runtimeActionId,
    releaseId, sourceCommit, candidateSha256, targetSha256, hostMachineId, configurationCanonicalSha256: p2NativeHash(configurationSha256),
    replacementRelease, originalReleaseReceiptSha256, originalReleasePlanSha256,
    terminalSha256: pin("d"), runtimeReceiptSha256: pin(kind === "known-ack" ? "e" : "d"), frontendSessionClosedSha256: pin("f"),
    frontendEpoch: "9007199254740993", runtimeInventorySha256, gatewayProcessSha256 };
  const path = join(results, actionId);
  mkdirSync(path, { mode: 0o700 });
  const receiptFile = join(path, name);
  const write = (value = receipt) => {
    const raw = Buffer.isBuffer(value) ? value : serialized(value);
    writeFileSync(receiptFile, raw, { mode: 0o600 });
    return { receiptFile, receiptSha256: hash(raw) };
  };
  const context = { original, profiledRelease, host, results, input };
  return { receipt, context, results, selection: write(), write };
}

test("successor selects the exact fixed runtime directory for each replacement frontier", t => {
  for (const kind of ["known-ack", "interrupted-known-ack"]) {
    const f = fixture(t, kind);
    const { actionId, runtimeActionId } = f.receipt;
    const selected = prepareP2ReplacementSuccessor(f.selection, f.context);
    const expected = kind === "known-ack"
      ? join(stagingRoot, `p2-profiled-known-ack-${runtimeActionId}`, "runtime-known-ack", "configuration")
      : join(f.context.host.results, `p2-profiled-known-ack-restoration-${actionId}`, "runtime-interrupted", "configuration");
    assert.deepEqual(selected, { binding: { kind, actionId, runtimeActionId, receiptSha256: f.selection.receiptSha256 },
      configuration: expected, frontendEpoch: f.receipt.frontendEpoch });
    assert(Object.isFrozen(selected.binding));
    assert.deepEqual(prepareP2ReplacementSuccessor(f.selection, {
      ...f.context, input: { ...f.context.input, initialEpoch: f.receipt.frontendEpoch },
    }), selected);
  }
});

test("successor refuses a rehashed foreign release, host, runtime, epoch or closed wire shape", t => {
  const f = fixture(t);
  for (const changed of [
    { version: true }, { kind: "arbitrary" }, { runtimeActionId: f.receipt.actionId },
    { runtimeActionId: f.context.input.certificationActionId }, { runtimeActionId: f.receipt.releaseId },
    { actionId: "different-action" }, { sourceCommit: "b".repeat(40) }, { hostMachineId: "b".repeat(32) },
    { candidateSha256: pin("5") }, { targetSha256: pin("5") }, { configurationCanonicalSha256: pin("5") },
    { replacementRelease: { ...f.receipt.replacementRelease, databaseOid: "201" } },
    { originalReleaseReceiptSha256: pin("5") }, { originalReleasePlanSha256: pin("a") },
    { runtimeInventorySha256: pin("5") }, { gatewayProcessSha256: pin("5") },
    { terminalSha256: pin("0") }, { frontendSessionClosedSha256: "unreviewed" },
    { frontendEpoch: "9007199254740995" }, { frontendEpoch: 9007199254740993 },
    { status: "P2_REPLACEMENT_RUNTIME_READY" }, { configuration: "/tmp/injected" },
  ]) assert.throws(() => prepareP2ReplacementSuccessor(f.write({ ...f.receipt, ...changed }), f.context), refusal);
  const raw = Buffer.from(serialized(f.receipt).toString("utf8").replace('"version": 2', '"version": 2, "version": 2'));
  assert.throws(() => prepareP2ReplacementSuccessor(f.write(raw), f.context), refusal);
  const interrupted = fixture(t, "interrupted-known-ack");
  assert.throws(() => prepareP2ReplacementSuccessor(interrupted.write({ ...interrupted.receipt, runtimeActionId: "different-action" }),
    interrupted.context), refusal);
  assert.throws(() => prepareP2ReplacementSuccessor(interrupted.write({ ...interrupted.receipt, runtimeReceiptSha256: pin("e") }),
    interrupted.context), refusal);
});

test("successor requires the next certification input to match exact closed runtime evidence", t => {
  const f = fixture(t);
  for (const changed of [
    { certificationActionId: f.receipt.actionId }, { certificationActionId: f.receipt.runtimeActionId },
    { certificationActionId: f.receipt.releaseId }, { startState: "qualified-ready" }, { operatorSourceCommit: "b".repeat(40) },
    { configurationSha256: pin("5") }, { gatewayConfigurationSha256: pin("5") }, { candidateSha256: pin("5") },
    { runtimeInventorySha256: pin("5") }, { gatewayProcessSha256: pin("5") }, { initialEpoch: "9007199254740992" },
    { native: { ...f.context.input.native, targetSha256: pin("5") } },
  ]) assert.throws(() => prepareP2ReplacementSuccessor(f.selection, { ...f.context, input: { ...f.context.input, ...changed } }), refusal);
  assert.throws(() => prepareP2ReplacementSuccessor(f.selection, { ...f.context, profiledRelease: {
    ...f.context.profiledRelease, planSha256: pin("a"),
  } }), refusal);
  assert.throws(() => prepareP2ReplacementSuccessor(f.selection, { ...f.context, host: {
    ...f.context.host, results: join(stagingRoot, "foreign", "results"),
  } }), refusal);
});

test("successor requires private original bytes directly under the selected prior action", t => {
  const f = fixture(t);
  const { receiptFile, receiptSha256 } = f.selection;
  assert.throws(() => prepareP2ReplacementSuccessor({ ...f.selection, raw: serialized(f.receipt) }, f.context), refusal);
  assert.throws(() => prepareP2ReplacementSuccessor({ ...f.selection, receiptSha256: pin("0") }, f.context), refusal);
  const bytes = readFileSync(receiptFile);
  writeFileSync(receiptFile, Buffer.concat([bytes, Buffer.from("\n")]));
  assert.throws(() => prepareP2ReplacementSuccessor(f.selection, f.context), refusal);
  f.write();
  chmodSync(receiptFile, 0o644);
  assert.throws(() => prepareP2ReplacementSuccessor(f.selection, f.context), refusal);
  chmodSync(receiptFile, 0o600);
  const link = join(f.results, "hardlink");
  linkSync(receiptFile, link);
  assert.throws(() => prepareP2ReplacementSuccessor(f.selection, f.context), refusal);
  rmSync(link);
  const deep = join(f.results, "deep", f.receipt.actionId);
  mkdirSync(deep, { mode: 0o700, recursive: true });
  writeFileSync(join(deep, name), bytes, { mode: 0o600 });
  assert.throws(() => prepareP2ReplacementSuccessor({ receiptFile: join(deep, name), receiptSha256 }, f.context), refusal);
  const parked = join(f.results, "parked");
  writeFileSync(parked, bytes, { mode: 0o600 });
  rmSync(receiptFile);
  symlinkSync(parked, receiptFile);
  assert.throws(() => prepareP2ReplacementSuccessor(f.selection, f.context), refusal);
});
