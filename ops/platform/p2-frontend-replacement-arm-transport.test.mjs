import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

test("held replacement arm passes the managed reference and provider only for a reviewed managed plan", () => {
  const source = String.raw`
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mock } from 'node:test';
import * as pg from 'pg';
const { arm, catalog, boundary, physical } = JSON.parse(readFileSync(0));
const bytes = readFileSync(new URL(catalog));
const { id, provider, target, databaseOid, migrationRoleOid, administrativeLogins } = JSON.parse(bytes);
const hash = data => createHash('sha256').update(data).digest('hex');
const managedCatalog = { id, sha256: hash(bytes) };
const predecessorTarget = { ...target, host: 'owned-prior.invalid' };
const probe = { job: { target }, predecessorTarget, databaseOid, migrationRoleOid };
const heldProbe = { ...probe, marker: 'a'.repeat(64) };
const rawObservation = Buffer.from('{}\n');
const { default: defaultPg, ...namedPg } = pg;
const operations = [];
class Client extends EventEmitter {
  constructor(options) {
    super();
    assert.equal(options.ssl.rejectUnauthorized, true);
    assert.match(options.options, /default_transaction_read_only=on/u);
    this.connection = { stream: { encrypted: true, authorized: true } };
  }
  async connect() { operations.push('connect'); }
  async query(sql) {
    if (sql.includes('pg_try_advisory_lock')) { operations.push('lock'); return { rows: [{ held: true }] }; }
    assert.match(sql, /pg_advisory_unlock/u);
    operations.push('unlock');
    return { rows: [{ released: true }] };
  }
  async end() { operations.push('end'); }
}
mock.module('pg', { exports: { ...namedPg, Client, default: { ...defaultPg, Client } } });
mock.module(physical, { exports: {
  async createP2FrontendReplacementProbe(value, client, guard) {
    assert.equal(value, probe); assert.ok(client instanceof Client); await guard(); return heldProbe;
  },
  verifyP2FrontendReplacementObservation(value, raw) { assert.equal(value, heldProbe); assert.deepEqual(raw, rawObservation); },
  async verifyP2FrontendReplacementSession(client, value) { assert.ok(client instanceof Client); assert.equal(value, heldProbe); },
} });
let options;
mock.module(boundary, { exports: { async verifyEmptyFrontendReplacement(client, selected) {
  assert.ok(client instanceof Client); options = selected;
  await selected.verifyEnvironment(); await selected.verifySession();
  return { databaseOid, migrationRoleOid };
} } });
const { observeHeldFrontendReplacement } = await import(arm);
for (const managed of [false, true]) {
  const replacement = { target, provider, ...(managed ? { managedCatalog } : {}) };
  const selected = { probe, plan: { replacement }, administrativeLogins };
  const url = 'postgresql://' + target.user + ':owned-fixture@' + target.host + ':' + target.port + '/' + target.database + '?sslmode=verify-full';
  const result = await observeHeldFrontendReplacement(selected, url, {
    signal: new AbortController().signal, async verifyEnvironment() {}, async arm(value) {
      assert.equal(value, heldProbe); operations.push('arm');
      return { physicalObservation: rawObservation.toString('base64'), physicalObservationSha256: hash(rawObservation), armReceiptSha256: 'f'.repeat(64) };
    },
  });
  const { verifyEnvironment, verifySession, ...binding } = options;
  assert.deepEqual(binding, { target, predecessorTarget, administrativeLogins, ...(managed ? { managedCatalog, provider } : {}) });
  assert.deepEqual(result.boundary, { databaseOid, migrationRoleOid });
  assert.deepEqual(operations.splice(0), ['connect', 'lock', 'arm', 'unlock', 'unlock', 'end']);
}
`;
  const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "--eval", source], {
    encoding: "utf8", timeout: 15_000, input: JSON.stringify(Object.fromEntries(Object.entries({
      arm: "./p2-frontend-replacement-arm.mjs", catalog: "./managed-neon-replacement-catalog.json",
      boundary: "./frontend-replacement-boundary.mjs", physical: "./p2-frontend-replacement-probe.mjs",
    }).map(([name, path]) => [name, new URL(path, import.meta.url).href]))),
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

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
