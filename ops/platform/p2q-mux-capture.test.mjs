import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { P2Q_MUX_CASES, P2Q_MUX_LIMITS, P2Q_MUX_OPERATIONS, validateP2QMuxValue as check, encodeP2QMuxValue as encode,
  decodeP2QMuxValue as decode, p2qMuxValueSha256 as hash, validateP2QMuxCaptureSet as captureSet,
  assessP2QMuxSendBudget as budget, assessP2QMuxWindowSummary as coverage, fixedP2QMuxIntents as intents,
  validateP2QMuxIntentPrefix as prefix, p2qMuxEvidenceByteLength as evidenceBytes, dispatchP2QMuxCapture as dispatch } from "./p2q-mux-capture.mjs";

// These are unregistered DATA vectors, not an allocated target/test issuer.
const at = ms => new Date(Date.parse("2026-11-06T12:00:00.000Z") + ms).toISOString();
const digest = "1".repeat(64), lessonId = randomUUID(), attemptId = randomUUID();
const refused = fn => assert.throws(fn, e => e.code === "P2Q_MUX_COMPONENT_VALUE_REFUSED" && e.message === e.code);
function lease(caseId = "D1") {
  return { version: 2, kind: "p2q-mux-controlled-capture-v2", actionId: "fixture-case", caseId,
    qualificationTargetProfile: { version: 1, id: "fixture-unregistered", sha256: digest },
    candidateSha256: digest, operatorSourceClosureSha256: digest, planSha256: digest, configurationSha256: digest,
    gatewayConfigurationSha256: digest, gatewayProcessSha256: digest, gatewayImageSha256: digest, courseImageSha256: digest, sourceWitnessSha256: digest,
    issuedAt: at(0), expiresAt: at(120000), maxCaptures: P2Q_MUX_CASES[caseId].slots.length, maxReplayPosts: P2Q_MUX_CASES[caseId].slots.length,
    selection: { environmentId: "environment-fixture", lessonId, attemptId, generation: 1, assetId: "asset-fixture", uploadId: null },
    captureRootIdentity: { device: "0", inode: "1" }, actionDirectoryIdentity: { device: "0", inode: "2" } };
}
function capture(l, slot = 0) {
  return { version: 2, kind: "P2Q_MUX_CAPTURE_OBSERVED", leaseSha256: hash("lease", l), slot,
    event: { id: "event-" + slot, type: P2Q_MUX_CASES[l.caseId].events[slot], createdAt: `2026-11-06T12:00:00.00000000${slot + 1}Z`,
      environmentId: l.selection.environmentId, objectId: "track-fixture", assetId: l.selection.assetId, attemptId, lessonId, generation: 1 },
    requestId: randomUUID(), headerTimestamp: Date.parse(at(0)) / 1000 - 1, capturedAt: at(1000 + slot), monotonicNanoseconds: String(1000000000 + slot),
    managedResponse: { id: attemptId, lessonId, status: "ready" }, localResponseFinished: true };
}
function replay(l, captures, sequence = 0) {
  const slot = P2Q_MUX_CASES[l.caseId].slots[sequence], c = captures[slot];
  const started = { version: 2, kind: "P2Q_MUX_SEND_STARTED", leaseSha256: hash("lease", l), sequence, captureSlot: slot,
    captureObservationSha256: hash("safeCapture", c), createdAt: at(2000) };
  const observed = { version: 2, kind: "P2Q_MUX_REPLAY_OBSERVED", leaseSha256: started.leaseSha256, sequence, captureSlot: slot,
    sendStartedSha256: hash("safeSendStarted", started), requestId: randomUUID(), event: structuredClone(c.event), headerTimestamp: c.headerTimestamp,
    observedAt: at(2500), monotonicNanoseconds: "2500000000", managedResponse: { ...c.managedResponse, status: "processing" }, localResponseFinished: true };
  return { started, observed };
}
function global(l, ordinal = 0) {
  return { version: 2, kind: "P2Q_MUX_ADMITTED_REQUEST_OBSERVED", leaseSha256: hash("lease", l), ordinal, requestId: randomUUID(),
    category: ordinal % 2 ? "recovery" : "newWork", service: "course", method: "POST", routeTemplate: "/v1/admin/courses/{courseId}",
    startedAt: at(100), finishedAt: at(1100), upstreamAttempted: true, upstreamStatus: 200, localResponseFinished: true };
}
function window(l, count = 2) {
  const records = Array.from({ length: count }, (_, i) => global(l, i));
  return { version: 2, kind: "P2Q_MUX_GLOBAL_WINDOW_OBSERVED", leaseSha256: hash("lease", l), startedAt: at(0), closedAt: at(500),
    admittedTotalsBefore: { newWork: 7, recovery: 9 }, admittedTotalsAfter: { newWork: 7 + Math.ceil(count / 2), recovery: 9 + Math.floor(count / 2) },
    records, observationFailures: 0 };
}

test("Node24 and combined source budget", () => {
  assert.equal(process.versions.node.split(".")[0], "24");
  const size = ["p2q-mux-capture.mjs", "p2q-mux-capture.test.mjs"].reduce((n, f) => n + readFileSync(new URL(f, import.meta.url)).length, 0);
  assert.ok(size <= 32768);
});
test("canonical safe bytes/hash and unsupported private kinds", () => {
  const frame = { version: 2, operation: "ARM" }, golden = '{"operation":"ARM","version":2}\n';
  assert.equal(encode("wireFrame", frame).toString(), golden);
  assert.equal(hash("wireFrame", frame), createHash("sha256").update(golden).digest("hex"));
  for (const kind of ["privateCommit", "privateIntent", "rawEnvelope", "__proto__", undefined, new String("lease")]) refused(() => encode(kind, {}));
});
test("seven safe kinds round trip into independent frozen data", () => {
  const l = lease(), c = capture(l), r = replay(l, [c]);
  const vectors = { lease: l, safeCapture: c, safeSendStarted: r.started, replayObservation: r.observed,
    globalRequest: global(l), windowSummary: window(l), wireFrame: { version: 2, operation: "ABORT" } };
  for (const [kind, v] of Object.entries(vectors)) { const result = decode(kind, encode(kind, v)); assert.deepEqual(result, v); assert.ok(Object.isFrozen(result)); }
  const copy = check("lease", l); l.selection.assetId = "changed"; assert.equal(copy.selection.assetId, "asset-fixture"); assert.ok(Object.isFrozen(copy.selection));
});
test("noncanonical bytes, duplicates and invalid UTF8 refused", () => {
  for (const raw of ['{"version":2,"operation":"ARM"}\n', '{"operation":"ARM","version":2.0}\n',
    '{"operation":"ARM","version":2e0}\n', '{"operation":"ARM","version":2}', ' {"operation":"ARM","version":2}\n',
    '{"operation":"ARM","operation":"ARM","version":2}\n', String.raw`{"operation":"ARM","version":2,"\u0076ersion":2}` + "\n",
    '{"operation":"ARM","version":1e10000}\n', Buffer.from([0xc3, 0x28]), " ".repeat(16385)]) refused(() => decode("wireFrame", raw));
  const l = lease(), row = global(l); refused(() => decode("globalRequest", encode("globalRequest", row).toString().replace('"ordinal":0', '"ordinal":-0')));
});
test("closed own keys refuse private/unsafe data", () => {
  for (const key of ["rawBody", "signature", "targetUrl", "method", "headers", "capturePath", "slotOrder", "authorizationObject", "callbacks", "callerComplete"])
    refused(() => check("wireFrame", { version: 2, operation: "ARM", [key]: "PRIVATE_CANARY" }));
  let touched = 0; const value = { version: 2, get operation() { touched++; return "ARM"; } }; refused(() => check("wireFrame", value)); assert.equal(touched, 0);
  refused(() => check("wireFrame", Object.assign(Object.create({ hidden: true }), { version: 2, operation: "ARM" })));
  refused(() => check("wireFrame", { version: 2, operation: "ARM", [Symbol("hidden")]: true }));
  const l = lease(); for (const key of ["trackId", "Bids", "eventTypes", "slotOrder"]) refused(() => check("lease", { ...l, selection: { ...l.selection, [key]: [] } }));
  refused(() => check("safeCapture", { ...capture(l), rawEnvelopeSha256: digest }));
});
test("profile ref syntax is not registration", () => {
  const l = lease(); assert.equal(check("lease", l).qualificationTargetProfile.id, "fixture-unregistered");
  for (const change of [x => { x.qualificationTargetProfile.sha256 = "0".repeat(64); }, x => { x.qualificationTargetProfile.sha256 = "sha256:" + digest; },
    x => { x.qualificationTargetProfile.id = "1bad"; }, x => { x.qualificationTargetProfile.version = true; }, x => { delete x.qualificationTargetProfile; }]) {
    const v = lease(); change(v); refused(() => check("lease", v));
  }
  assert.equal(check("globalRequest", { ...global(l), leaseSha256: "0".repeat(64) }).leaseSha256, "0".repeat(64));
});
test("case counts, identities, generation, negative zero and scalar types are bounded", () => {
  for (const change of [x => { x.caseId = "D2"; }, x => { x.caseId = { toString() { throw Error("PRIVATE"); } }; }, x => { x.maxCaptures = 2; },
    x => { x.maxReplayPosts = true; }, x => { x.selection.generation = 0; }, x => { x.selection.generation = 2147483648; },
    x => { x.actionDirectoryIdentity.inode = "0"; }, x => { x.captureRootIdentity.device = "00"; }, x => { x.selection.assetId = "https://caller.invalid"; }]) {
    const l = lease(); change(l); refused(() => check("lease", l));
  }
  const l = lease(); for (const field of ["ordinal", "upstreamStatus"]) refused(() => check("globalRequest", { ...global(l), [field]: -0 }));
  for (const v of [true, "0", -0, NaN, Infinity]) refused(() => check("windowSummary", { ...window(l), observationFailures: v }));
});
test("calendar and nanosecond preservation", () => {
  const l = lease(); for (const stamp of ["2026-02-30T12:00:00Z", "2026-11-06T12:00:60Z", "0000-01-01T00:00:00Z", "2026-11-06T12:00:00+24:00", "2026-11-06T12:00:00.1234567890Z"])
    refused(() => check("safeCapture", { ...capture(l), event: { ...capture(l).event, createdAt: stamp } }));
  const valid = "2026-11-06T07:00:00.123456789-05:00"; const c = capture(l); c.event.createdAt = valid;
  assert.equal(decode("safeCapture", encode("safeCapture", c)).event.createdAt, valid);
  for (const expires of [at(0), at(120001), "2026-11-06T12:00:01Z"]) refused(() => check("lease", { ...l, expiresAt: expires }));
});
test("R1 strict event ordering; A1 no B proof", () => {
  const l = lease("R1"), rows = [capture(l, 0), capture(l, 1)]; rows[0].event.createdAt = "2026-11-06T07:00:00.000000001-05:00";
  assert.equal(Date.parse(rows[0].event.createdAt), Date.parse(rows[1].event.createdAt)); assert.equal(captureSet(l, rows).dataConsistent, true);
  for (const change of [r => { r[1].event.createdAt = r[0].event.createdAt; }, r => { r[1].event.id = r[0].event.id; },
    r => { r[1].event.objectId = "other-track"; }, r => { r[0].event.assetId = "other-asset"; }, r => { r[1].event.generation = 2; }, r => r.reverse()]) {
    const v = structuredClone(rows); change(v); refused(() => captureSet(l, v));
  }
  for (const id of ["D1", "A1"]) { const v = lease(id), result = captureSet(v, [capture(v)]);
    assert.equal(result.actualAuthority, false); assert.equal(result.providerGeneratedDuplicate, false); assert.equal(result.firstDeliveryInversion, false); assert.equal(result.replacementStateQualified, false); }
});
test("120s/300s wall and elapsed budgets never authorize send", () => {
  const l = lease(), c = capture(l); assert.equal(budget(l, c, at(105000), 105000).budgetSufficient, true);
  for (const [now, elapsed] of [[at(105001), 105001], [at(10000), 105001], [at(120001), 0], [at(0), 0]]) {
    const result = budget(l, c, now, elapsed); assert.equal(result.budgetSufficient, false); assert.equal(result.liveSendAuthorized, false); assert.equal(result.sourceClockQualified, false); }
  const original = { ...c, headerTimestamp: Date.parse(at(0)) / 1000 - 280 };
  assert.equal(budget(l, original, at(5000), 5000).budgetSufficient, true); assert.equal(budget(l, original, at(5001), 5001).budgetSufficient, false);
  assert.equal(budget(l, { ...c, headerTimestamp: Date.parse(at(0)) / 1000 + 2 }, at(2000), 2000).budgetSufficient, false);
  refused(() => captureSet(l, [{ ...c, headerTimestamp: Date.parse(at(0)) / 1000 - 301 }]));
});
test("global counters never qualify drain or provider queue", () => {
  const l = lease(), w = window(l); const result = coverage(l, w); assert.equal(result.counterLedgerConsistency, "MATCH");
  assert.deepEqual(result.counts, { newWork: 1, recovery: 1 }); assert.equal(result.selectiveAdmissionClaim, false);
  assert.equal(result.actualDrainQualified, false); assert.equal(result.providerQueueQualified, false);
  assert.ok(Date.parse(w.records[0].finishedAt) > Date.parse(w.closedAt), "accepted work may finish during post-close drain");
  for (const change of [v => { v.admittedTotalsAfter.recovery++; }, v => { v.admittedTotalsAfter.newWork = 1; }, v => { v.admittedTotalsAfter = null; },
    v => { v.closedAt = null; }, v => { v.observationFailures = 1; }]) { const v = window(l); change(v); assert.equal(coverage(l, v).counterLedgerConsistency, "OPEN"); }
  const loss = window(l); loss.records[0].finishedAt = null; loss.records[0].localResponseFinished = null; loss.records[0].upstreamStatus = null;
  assert.equal(coverage(l, loss).actualDrainQualified, false);
});
test("count and byte limits are conjunctive", () => {
  const l = lease(); refused(() => check("windowSummary", window(l, 65)));
  refused(() => check("windowSummary", window(l, 64)));
  const duplicate = window(l); duplicate.records[1].requestId = duplicate.records[0].requestId; refused(() => check("windowSummary", duplicate));
  const hole = window(l); delete hole.records[0]; refused(() => check("windowSummary", hole));
  const size = encode("lease", l).length, n = Math.floor(P2Q_MUX_LIMITS.evidenceBytes / size);
  assert.equal(evidenceBytes(Array(n).fill(l)), n * size); refused(() => evidenceBytes(Array(n + 1).fill(l)));
  refused(() => evidenceBytes([{ version: 2, kind: "P2Q_MUX_CAPTURE_COMMITTED", rawEnvelopeSha256: digest }]));
});
test("fixed trace bounds and terminal intents", () => {
  for (const id of ["D1", "R1", "A1"]) {
    const frames = intents(id); assert.equal(frames.filter(x => x.operation === "SEND_NEXT").length, id === "R1" ? 2 : 1);
    for (let i = 0; i <= frames.length; i++) assert.equal(prefix(id, frames.slice(0, i)).dispatchAuthorized, false);
    assert.equal(prefix(id, frames).nextOperation, null); assert.equal(prefix(id, [frames[0], { version: 2, operation: "ABORT" }]).nextOperation, null);
    refused(() => prefix(id, [...frames, { version: 2, operation: "SEND_NEXT" }])); refused(() => prefix(id, [frames[0], frames[0]]));
  }
});
test("public dispatch always unavailable", () => {
  let accessed = 0; const poisoned = new Proxy({}, { get() { accessed++; throw Error("PRIVATE_CANARY"); } });
  for (const value of [undefined, null, { id: "staging-current" }, lease(), { factory: true }, poisoned]) for (const operation of P2Q_MUX_OPERATIONS)
    assert.throws(() => dispatch(operation, value), e => e.code === "P2Q_MUX_SOURCE_AUTHORITY_UNAVAILABLE" && e.message === e.code);
  assert.equal(accessed, 0);
});
test("owned Node process refuses private wire data and ARM", () => {
  const moduleUrl = new URL("./p2q-mux-capture.mjs", import.meta.url).href;
  const program = `import {decodeP2QMuxValue,dispatchP2QMuxCapture} from ${JSON.stringify(moduleUrl)};
    let raw='';for await(const part of process.stdin){raw+=part;if(raw.length>16384)process.exit(2);}
    try{const frame=decodeP2QMuxValue('wireFrame',raw);dispatchP2QMuxCapture(frame,new Proxy({},{get(){throw Error('PRIVATE_CANARY');}}));}
    catch(e){if(!['P2Q_MUX_COMPONENT_VALUE_REFUSED','P2Q_MUX_SOURCE_AUTHORITY_UNAVAILABLE'].includes(e.code))process.exit(3);
    process.stdout.write(JSON.stringify({componentOnly:true,code:e.code,productionDispatch:false})+'\\n');}`;
  for (const raw of [encode("wireFrame", { version: 2, operation: "ARM" }), '{"operation":"ARM","signature":"PRIVATE_CANARY","version":2}\n']) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], { input: raw, encoding: "utf8", env: { PATH: process.env.PATH }, timeout: 5000 });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, ""); assert.ok(!result.stdout.includes("PRIVATE_CANARY"));
    const record = JSON.parse(result.stdout); assert.equal(record.componentOnly, true); assert.equal(record.productionDispatch, false);
  }
});
