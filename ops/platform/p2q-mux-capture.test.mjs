import assert, { equal, deepEqual, ok } from "node:assert/strict";
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
const changed = (v, path, x) => { v = structuredClone(v); const keys = path.split("."), key = keys.pop(), target = keys.reduce((o, k) => o[k], v);
  if (x === undefined) delete target[key]; else target[key] = x; return v; };
const refused = fn => assert.throws(fn, e => e.code === "P2Q_MUX_COMPONENT_VALUE_REFUSED" && e.message === e.code);
function lease(caseId = "D1") {
  return { version: 2, kind: "p2q-mux-controlled-capture-v2", actionId: "fixture-case", caseId,
    qualificationTargetProfile: { version: 1, id: "fixture-unregistered", sha256: digest },
    ...Object.fromEntries("candidateSha256 operatorSourceClosureSha256 planSha256 configurationSha256 gatewayConfigurationSha256 gatewayProcessSha256 gatewayImageSha256 courseImageSha256 sourceWitnessSha256".split(" ").map(k => [k, digest])),
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
function replay(l, c) {
  const { slot, capturedAt: unused, ...rest } = c; void unused;
  const started = { version: 2, kind: "P2Q_MUX_SEND_STARTED", leaseSha256: hash("lease", l), sequence: 0, captureSlot: slot,
    captureObservationSha256: hash("safeCapture", c), createdAt: at(2000) };
  return { started, observed: { ...rest, kind: "P2Q_MUX_REPLAY_OBSERVED", sequence: 0, captureSlot: slot,
    sendStartedSha256: hash("safeSendStarted", started), observedAt: at(2500) } };
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
  equal(process.versions.node.split(".")[0], "24");
  const size = ["p2q-mux-capture.mjs", "p2q-mux-capture.test.mjs"].reduce((n, f) => n + readFileSync(new URL(f, import.meta.url)).length, 0);
  ok(size <= 32768);
});
test("canonical hashes/private refusal", () => {
  const frame = { version: 2, operation: "ARM" }, golden = '{"operation":"ARM","version":2}\n';
  equal(encode("wireFrame", frame).toString(), golden);
  equal(hash("wireFrame", frame), createHash("sha256").update(golden).digest("hex"));
  for (const kind of ["privateCommit", "privateIntent", "rawEnvelope", "__proto__", undefined, new String("lease")]) refused(() => encode(kind, {}));
});
test("seven safe kinds round trip", () => {
  const l = lease(), c = capture(l), r = replay(l, c);
  const vectors = { lease: l, safeCapture: c, safeSendStarted: r.started, replayObservation: r.observed,
    globalRequest: global(l), windowSummary: window(l), wireFrame: { version: 2, operation: "ABORT" } };
  for (const [kind, v] of Object.entries(vectors)) { const result = decode(kind, encode(kind, v)); deepEqual(result, v); ok(Object.isFrozen(result)); }
  const copy = check("lease", l); l.selection.assetId = "changed"; equal(copy.selection.assetId, "asset-fixture"); ok(Object.isFrozen(copy.selection));
});
test("noncanonical bytes refused", () => {
  for (const raw of ['{"version":2,"operation":"ARM"}\n', '{"operation":"ARM","version":2.0}\n',
    '{"operation":"ARM","version":2e0}\n', '{"operation":"ARM","version":2}', ' {"operation":"ARM","version":2}\n',
    '{"operation":"ARM","operation":"ARM","version":2}\n', String.raw`{"operation":"ARM","version":2,"\u0076ersion":2}` + "\n",
    '{"operation":"ARM","version":1e10000}\n', Buffer.from([0xc3, 0x28]), " ".repeat(16385)]) refused(() => decode("wireFrame", raw));
  const l = lease(), row = global(l); refused(() => decode("globalRequest", encode("globalRequest", row).toString().replace('"ordinal":0', '"ordinal":-0')));
});
test("closed own data", () => {
  for (const key of ["rawBody", "signature", "targetUrl", "method", "headers", "capturePath", "slotOrder", "authorizationObject", "callbacks", "callerComplete"])
    refused(() => check("wireFrame", { version: 2, operation: "ARM", [key]: "PRIVATE_CANARY" }));
  let touched = 0; const value = { version: 2, get operation() { touched++; return "ARM"; } }; refused(() => check("wireFrame", value)); equal(touched, 0);
  refused(() => check("wireFrame", Object.assign(Object.create({ hidden: true }), { version: 2, operation: "ARM" })));
  refused(() => check("wireFrame", { version: 2, operation: "ARM", [Symbol("hidden")]: true }));
  const l = lease(); for (const key of ["trackId", "Bids", "eventTypes", "slotOrder"]) refused(() => check("lease", { ...l, selection: { ...l.selection, [key]: [] } }));
  refused(() => check("safeCapture", { ...capture(l), rawEnvelopeSha256: digest }));
});
test("non-enumerable data refused", () => {
  for (const [kind, value, nested, key] of [["wireFrame", { version: 2, operation: "ARM" }, null, "version"],
    ["lease", lease(), "qualificationTargetProfile", "version"], ["lease", lease(), "selection", "generation"],
    ["windowSummary", window(lease()), "records", "0"]]) {
    const target = nested ? value[nested] : value; Object.defineProperty(target, key, { enumerable: false });
    for (const fn of [check, encode, hash]) refused(() => fn(kind, value));
  }
});
test("reference syntax only", () => {
  const l = lease(); equal(check("lease", l).qualificationTargetProfile.id, "fixture-unregistered");
  for (const [key, value] of [["sha256", "0".repeat(64)], ["sha256", "sha256:" + digest], ["id", "1bad"], ["version", true]])
    refused(() => check("lease", changed(l, "qualificationTargetProfile." + key, value)));
  refused(() => check("lease", changed(l, "qualificationTargetProfile", undefined)));
  equal(check("globalRequest", { ...global(l), leaseSha256: "0".repeat(64) }).leaseSha256, "0".repeat(64));
});
test("bounded scalar and identity types", () => {
  for (const [path, value] of [["caseId", "D2"], ["caseId", { toString() { throw Error("PRIVATE"); } }], ["maxCaptures", 2],
    ["maxReplayPosts", true], ["selection.generation", 0], ["selection.generation", 2147483648], ["actionDirectoryIdentity.inode", "0"],
    ["captureRootIdentity.device", "00"], ["selection.assetId", "https://caller.invalid"]]) refused(() => check("lease", changed(lease(), path, value)));
  const l = lease(); for (const field of ["ordinal", "upstreamStatus"]) refused(() => check("globalRequest", { ...global(l), [field]: -0 }));
  for (const v of [true, "0", -0, NaN, Infinity]) refused(() => check("windowSummary", { ...window(l), observationFailures: v }));
});
test("calendar/nanoseconds", () => {
  const l = lease(); for (const stamp of ["2026-02-30T12:00:00Z", "2026-11-06T12:00:60Z", "0000-01-01T00:00:00Z", "2026-11-06T12:00:00+24:00", "2026-11-06T12:00:00.1234567890Z"])
    refused(() => check("safeCapture", { ...capture(l), event: { ...capture(l).event, createdAt: stamp } }));
  const valid = "2026-11-06T07:00:00.123456789-05:00"; const c = capture(l); c.event.createdAt = valid;
  equal(decode("safeCapture", encode("safeCapture", c)).event.createdAt, valid);
  for (const expires of [at(0), at(120001), "2026-11-06T12:00:01Z"]) refused(() => check("lease", { ...l, expiresAt: expires }));
});
test("R1 strict event ordering; A1 no B proof", () => {
  const l = lease("R1"), rows = [capture(l, 0), capture(l, 1)]; rows[0].event.createdAt = "2026-11-06T07:00:00.000000001-05:00";
  equal(Date.parse(rows[0].event.createdAt), Date.parse(rows[1].event.createdAt)); equal(captureSet(l, rows).dataConsistent, true);
  for (const [path, value] of [["1.event.createdAt", rows[0].event.createdAt], ["1.event.id", rows[0].event.id],
    ["1.event.objectId", "other-track"], ["0.event.assetId", "other-asset"], ["1.event.generation", 2]]) refused(() => captureSet(l, changed(rows, path, value)));
  refused(() => captureSet(l, [...rows].reverse()));
  for (const id of ["D1", "A1"]) { const v = lease(id), result = captureSet(v, [capture(v)]);
    for (const key of ["actualAuthority", "providerGeneratedDuplicate", "firstDeliveryInversion", "replacementStateQualified"]) equal(result[key], false); }
});
test("lifetime budgets", () => {
  const l = lease(), c = capture(l); equal(budget(l, c, at(105000), 105000).budgetSufficient, true);
  for (const [now, elapsed] of [[at(105001), 105001], [at(10000), 105001], [at(120001), 0], [at(0), 0]]) {
    const result = budget(l, c, now, elapsed); equal(result.budgetSufficient, false); equal(result.liveSendAuthorized, false); equal(result.sourceClockQualified, false); }
  const original = { ...c, headerTimestamp: Date.parse(at(0)) / 1000 - 280 };
  equal(budget(l, original, at(5000), 5000).budgetSufficient, true); equal(budget(l, original, at(5001), 5001).budgetSufficient, false);
  equal(budget(l, { ...c, headerTimestamp: Date.parse(at(0)) / 1000 + 2 }, at(2000), 2000).budgetSufficient, false);
  refused(() => captureSet(l, [{ ...c, headerTimestamp: Date.parse(at(0)) / 1000 - 301 }]));
});
test("budget case/selection binding", () => {
  const l = lease(), c = capture(l); equal(budget(l, c, at(105000), 105000).budgetSufficient, true);
  for (const [key, value] of [["type", "video.asset.track.deleted"], ["environmentId", "foreign"], ["assetId", "foreign"],
    ["attemptId", randomUUID()], ["lessonId", randomUUID()], ["generation", 2], ["slot", 1]]) {
    const row = structuredClone(c); if (key === "slot") row.slot = value; else row.event[key] = value;
    row.managedResponse.id = row.event.attemptId; row.managedResponse.lessonId = row.event.lessonId;
    equal(check("safeCapture", row).leaseSha256, hash("lease", l));
    refused(() => budget(l, row, at(105000), 105000)); refused(() => captureSet(l, [row]));
  }
});
test("global counter consistency", () => {
  const l = lease(), w = window(l); const result = coverage(l, w); equal(result.counterLedgerConsistency, "MATCH");
  deepEqual(result.counts, { newWork: 1, recovery: 1 }); equal(result.selectiveAdmissionClaim, false);
  equal(result.actualDrainQualified, false); equal(result.providerQueueQualified, false);
  ok(Date.parse(w.records[0].finishedAt) > Date.parse(w.closedAt), "post-close work may finish");
  for (const [path, value] of [["admittedTotalsAfter.recovery", 11], ["admittedTotalsAfter.newWork", 1], ["admittedTotalsAfter", null],
    ["closedAt", null], ["observationFailures", 1]]) equal(coverage(l, changed(w, path, value)).counterLedgerConsistency, "OPEN");
  const loss = window(l); loss.records[0].finishedAt = null; loss.records[0].localResponseFinished = null; loss.records[0].upstreamStatus = null;
  equal(coverage(l, loss).actualDrainQualified, false);
});
test("count and byte limits are conjunctive", () => {
  const l = lease(); refused(() => check("windowSummary", window(l, 65)));
  refused(() => check("windowSummary", window(l, 64)));
  const duplicate = window(l); duplicate.records[1].requestId = duplicate.records[0].requestId; refused(() => check("windowSummary", duplicate));
  const hole = window(l); delete hole.records[0]; refused(() => check("windowSummary", hole));
  const size = encode("lease", l).length, n = Math.floor(P2Q_MUX_LIMITS.evidenceBytes / size);
  equal(evidenceBytes(Array(n).fill(l)), n * size); refused(() => evidenceBytes(Array(n + 1).fill(l)));
  refused(() => evidenceBytes([{ version: 2, kind: "P2Q_MUX_CAPTURE_COMMITTED", rawEnvelopeSha256: digest }]));
});
test("fixed intent bounds", () => {
  for (const id of ["D1", "R1", "A1"]) {
    const frames = intents(id); equal(frames.filter(x => x.operation === "SEND_NEXT").length, id === "R1" ? 2 : 1);
    for (let i = 0; i <= frames.length; i++) equal(prefix(id, frames.slice(0, i)).dispatchAuthorized, false);
    equal(prefix(id, frames).nextOperation, null); equal(prefix(id, [frames[0], { version: 2, operation: "ABORT" }]).nextOperation, null);
    refused(() => prefix(id, [...frames, { version: 2, operation: "SEND_NEXT" }])); refused(() => prefix(id, [frames[0], frames[0]]));
  }
});
test("public dispatch always unavailable", () => {
  let accessed = 0; const poisoned = new Proxy({}, { get() { accessed++; throw Error("PRIVATE_CANARY"); } });
  for (const value of [undefined, null, { id: "staging-current" }, lease(), { factory: true }, poisoned]) for (const operation of P2Q_MUX_OPERATIONS)
    assert.throws(() => dispatch(operation, value), e => e.code === "P2Q_MUX_SOURCE_AUTHORITY_UNAVAILABLE" && e.message === e.code);
  equal(accessed, 0);
});
test("owned child refusal", () => {
  const moduleUrl = new URL("./p2q-mux-capture.mjs", import.meta.url).href;
  const program = `import {decodeP2QMuxValue,dispatchP2QMuxCapture} from ${JSON.stringify(moduleUrl)};
    let raw='';for await(const part of process.stdin){raw+=part;if(raw.length>16384)process.exit(2);}
    try{const frame=decodeP2QMuxValue('wireFrame',raw);dispatchP2QMuxCapture(frame,new Proxy({},{get(){throw Error('PRIVATE_CANARY');}}));}
    catch(e){if(!['P2Q_MUX_COMPONENT_VALUE_REFUSED','P2Q_MUX_SOURCE_AUTHORITY_UNAVAILABLE'].includes(e.code))process.exit(3);
    process.stdout.write(JSON.stringify({componentOnly:true,code:e.code,productionDispatch:false})+'\\n');}`;
  for (const raw of [encode("wireFrame", { version: 2, operation: "ARM" }), '{"operation":"ARM","signature":"PRIVATE_CANARY","version":2}\n']) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], { input: raw, encoding: "utf8", env: { PATH: process.env.PATH }, timeout: 5000 });
    equal(result.status, 0, result.stderr); equal(result.stderr, ""); ok(!result.stdout.includes("PRIVATE_CANARY"));
    const record = JSON.parse(result.stdout); equal(record.componentOnly, true); equal(record.productionDispatch, false);
  }
});
