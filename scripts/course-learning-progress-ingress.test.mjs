import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createOwnedProgressIngressObserver } from "./course-learning-progress-ingress.mjs";

const lessons = {
  chromium: "11111111-1111-4111-8111-111111111111",
  mobile: "22222222-2222-4222-8222-222222222222",
};
const pathFor = profile => `/api/academy/lessons/${lessons[profile]}/progress`;
const exitBody = Buffer.from('{"resumePositionSeconds":8,"maxPositionSeconds":14,"expectedProgressRevision":15}');
const marker = { bodyBytes: exitBody.length, bodySha256: createHash("sha256").update(exitBody).digest("hex") };

function requestParts(url, method = "POST") {
  return {
    request: Object.assign(new EventEmitter(), { method, url, complete: false, headers: { cookie: "fixture-private-value" } }),
    upstream: Object.assign(new EventEmitter(), { writableFinished: false }),
    response: Object.assign(new EventEmitter(), { writableFinished: false }),
  };
}

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), "owned-progress-ingress-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeMarker(root, name, value = marker) {
  const folder = join(root, "browser", name);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "document-exit-outgoing.json"), JSON.stringify(value));
}

test("joins the exact outgoing exit to complete ingress and retains early close without claiming delivery", async t => {
  const root = await directory(t), observer = createOwnedProgressIngressObserver();
  observer.selectLessons(lessons);
  for (const profile of Object.keys(lessons)) await writeMarker(root, `owned-exit-${profile}`);

  const desktop = requestParts(pathFor("chromium"));
  observer.observe(desktop.request, desktop.upstream, desktop.response);
  desktop.request.emit("data", exitBody.subarray(0, 7));
  desktop.request.emit("data", exitBody.subarray(7));
  desktop.request.complete = true;
  desktop.request.emit("end");
  desktop.request.emit("close");
  desktop.upstream.writableFinished = true;
  desktop.upstream.emit("finish");
  desktop.upstream.emit("response", { statusCode: 200, headers: { "x-request-id": "fixture-private-id" } });
  desktop.response.writableFinished = true;
  desktop.response.emit("close");
  desktop.upstream.emit("close");

  const mobile = requestParts(pathFor("mobile"));
  observer.observe(mobile.request, mobile.upstream, mobile.response);
  mobile.request.emit("data", exitBody.subarray(0, 9));
  mobile.response.emit("close");
  mobile.upstream.emit("unpipe", mobile.request);
  assert.equal(mobile.request.listenerCount("data"), 0);
  mobile.request.emit("data", exitBody.subarray(9));
  mobile.upstream.emit("error", Object.assign(new Error("fixture-private-error"), { code: "ECONNRESET" }));
  mobile.upstream.emit("close");
  mobile.request.emit("close");

  const report = await observer.report(root);
  const [received, partial] = Object.keys(lessons).map(profile => report.profiles[profile].requests[0]);
  assert.deepEqual(report.profiles.chromium.documentExit, { state: "captured", ...marker, matchedIngressOrdinals: [1] });
  assert.deepEqual(report.profiles.mobile.documentExit, { state: "captured", ...marker, matchedIngressOrdinals: [] });
  assert.equal(received.receivedBytes, marker.bodyBytes);
  assert.equal(received.bodySha256, marker.bodySha256);
  assert.deepEqual(received.events.map(event => event.type),
    ["accepted", "client-request-end", "client-request-close", "upstream-finish", "upstream-response", "client-response-close", "upstream-close"]);
  assert.equal(received.events.find(event => event.type === "upstream-response").status, 200);
  assert.equal(received.events.find(event => event.type === "client-response-close").writableFinished, true);
  assert.equal(partial.receivedBytes, 9);
  assert.equal(partial.bodySha256, null);
  assert.equal(partial.events.find(event => event.type === "client-response-close").writableFinished, false);
  assert.equal(partial.events.find(event => event.type === "client-request-close").requestComplete, false);
  assert.equal(partial.events.find(event => event.type === "upstream-error").errorCode, "ECONNRESET");
  assert.equal(partial.events.some(event => event.type === "upstream-finish"), false);
  const events = [...received.events, ...partial.events];
  assert.deepEqual(events.map(event => event.sequence), events.map((_, index) => index + 1));
  assert.ok(events.every((event, index) => index === 0 || event.elapsedMicros >= events[index - 1].elapsedMicros));
  assert.doesNotMatch(JSON.stringify(report), /fixture-private|11111111|22222222|resumePositionSeconds/u);
});

test("ignores other routes, bounds observations and refuses ambiguous or invalid exit markers", async t => {
  const root = await directory(t), observer = createOwnedProgressIngressObserver();
  assert.throws(() => observer.selectLessons({ chromium: lessons.chromium, mobile: lessons.chromium }), /distinct owned/u);
  observer.selectLessons(lessons);
  for (const [url, method] of [[pathFor("chromium"), "GET"], [pathFor("chromium") + "?x=1", "POST"], ["/api/private", "POST"]]) {
    const { request, upstream, response } = requestParts(url, method);
    observer.observe(request, upstream, response);
    assert.equal(request.eventNames().length, 0);
  }
  for (let index = 0; index < 65; index++) {
    const { request, upstream, response } = requestParts(pathFor("chromium"));
    observer.observe(request, upstream, response);
    request.emit("data", Buffer.alloc(1024));
    request.emit("data", Buffer.alloc(100));
    request.complete = true;
    request.emit("end");
  }
  const beforeMarkers = await observer.report(root);
  assert.equal(beforeMarkers.profiles.chromium.documentExit.state, "absent");
  assert.equal(beforeMarkers.profiles.mobile.documentExit.state, "absent");
  await Promise.all([
    writeMarker(root, "first-chromium"), writeMarker(root, "second-chromium"),
    writeMarker(root, "invalid-mobile", { ...marker, raw: "fixture-private-value" }),
  ]);
  const report = await observer.report(root);
  assert.equal(report.profiles.chromium.requests.length, 64);
  assert.equal(report.profiles.chromium.capped, true);
  assert.equal(report.profiles.chromium.documentExit.state, "ambiguous");
  assert.ok(report.profiles.chromium.requests.every(row => row.receivedBytes === 1025 && row.bodySha256 === null));
  assert.equal(report.profiles.mobile.documentExit.state, "invalid");
  assert.equal(report.profiles.mobile.requests.length, 0);
  assert.doesNotMatch(JSON.stringify(report), /fixture-private/u);
});
