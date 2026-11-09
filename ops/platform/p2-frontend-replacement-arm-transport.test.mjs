import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { exchangeFrontendReplacementArm } from "./p2-frontend-replacement-arm-transport.mjs";
import { STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";

const plan = { releaseId: "owned-replacement", targetSha256: "d".repeat(64) };
const initial = { qualificationTargetProfile: profile, sourceCommit: "a".repeat(40), candidateSha256: "b".repeat(64),
  reviewedPlanSha256: "c".repeat(64) };
const physicalObservationSha256 = "e".repeat(64), armReceiptSha256 = "f".repeat(64);
const refusal = /P2_FRONTEND_REPLACEMENT_HOST_ARM_REFUSED/u;
const receipt = { version: 1, qualificationTargetProfile: profile, environment: "staging", ...plan, ...initial,
  bootstrapAuthorized: false, migrationAuthorized: false, deploymentAuthorized: false, trafficAuthorized: false };
const operations = ["initial", "check", "arm-replacement", "check", "commit"];

function host({ mutate = value => value, exit = 0 } = {}) {
  const child = new EventEmitter(), calls = [];
  let closed = false;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const close = code => {
    if (closed) return;
    closed = true;
    setImmediate(() => child.emit("close", code, null));
  };
  child.kill = () => close(1);
  child.stdin = new Writable({
    write(chunk, encoding, callback) {
      const packet = JSON.parse(chunk.toString());
      const operation = packet.operation ?? "initial", id = packet.id ?? 0;
      calls.push(operation);
      let response = { id, status: "LOCKED" };
      if (operation === "arm-replacement") response = { id, status: "REPLACEMENT_ARMED", armReceiptSha256,
        receipt: { ...receipt, status: "P2_FRONTEND_REPLACEMENT_ARMED", physicalObservation: "e30K", physicalObservationSha256 } };
      if (operation === "commit") response = { id, status: "COMMITTED", receipt: { ...receipt,
        status: "P2_FRONTEND_REPLACEMENT_ARM_COMMITTED", armReceiptSha256, physicalObservationSha256, backendClosureVerified: false } };
      response = mutate(response);
      const line = typeof response === "string" ? response : JSON.stringify(response) + "\n";
      setImmediate(() => {
        child.stdout.write(line.slice(0, 4));
        child.stdout.write(line.slice(4));
        callback();
      });
    },
    final(callback) { close(exit); callback(); },
  });
  return { child, calls };
}

async function observe({ verifyEnvironment, arm, signal }) {
  assert.equal(signal.aborted, false);
  await verifyEnvironment();
  const observed = await arm({ owned: true });
  assert.deepEqual(observed, { armReceiptSha256, physicalObservationSha256, physicalObservation: "e30K" });
  await verifyEnvironment();
  return "local session closed";
}

test("replacement arm requires a bound receipt, local completion, and a clean host exit", async () => {
  const { child, calls } = host();
  const result = await exchangeFrontendReplacementArm(child, initial, plan, observe);
  assert.equal(result.result, "local session closed");
  assert.equal(result.receipt.armReceiptSha256, armReceiptSha256);
  assert.deepEqual(calls, operations);
});

test("replacement arm refuses malformed, foreign, early or uncertain host evidence", async () => {
  for (const mutate of [
    value => value.id === 0 ? '{"id":0,"id":0,"status":"LOCKED"}\n' : value,
    value => value.id === 0 ? JSON.stringify(value) + "\n" + JSON.stringify(value) + "\n" : value,
    value => value.status === "REPLACEMENT_ARMED" ? { ...value, receipt: { ...value.receipt, targetSha256: "1".repeat(64) } } : value,
    value => value.status === "REPLACEMENT_ARMED" ? { ...value, receipt: { ...value.receipt, migrationAuthorized: true } } : value,
    value => value.status === "COMMITTED" ? { ...value, receipt: { ...value.receipt, armReceiptSha256: "1".repeat(64) } } : value,
    value => value.status === "COMMITTED" ? { ...value, receipt: { ...value.receipt, backendClosureVerified: true } } : value,
  ]) {
    await assert.rejects(exchangeFrontendReplacementArm(host({ mutate }).child, initial, plan, observe), refusal);
  }
  await assert.rejects(exchangeFrontendReplacementArm(host({ exit: 1 }).child, initial, plan, observe), refusal);
  const { child, calls } = host();
  await assert.rejects(exchangeFrontendReplacementArm(child, initial, plan, async custody => {
    await observe(custody);
    throw new Error("local release failed");
  }), refusal);
  assert.deepEqual(calls, operations.slice(0, -1));
});
