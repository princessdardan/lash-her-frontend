import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once, EventEmitter } from "node:events";
import { request } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import { createP407CourseIngress } from "./p407-course-ingress.mjs";

test("candidate ingress forwards only the scoped offer and settlement requests", async t => {
  const proof = "a".repeat(64);
  const scope = {
    orderId: "6911c2a4-9f70-4b54-afe1-093556e816dc",
    customerId: "03dddf83-63a0-4747-a392-059ed93cfdb0",
    courseId: "d167029b-56ce-48b1-811c-ccf470440607",
    proofSha256: createHash("sha256").update(proof).digest("hex"),
    expiresAt: "2026-11-23T19:20:00.000Z",
  };
  const calls = [];
  let now = Date.parse("2026-11-23T19:10:00.000Z");
  const server = createP407CourseIngress(scope, (options, respond) => Object.assign(new EventEmitter(), {
    destroy() {},
    end(body) {
      calls.push({ options, body });
      respond(Object.assign(Readable.from(['{"ok":true}']), {
        statusCode: 200, headers: { "content-type": "application/json" },
      }));
    },
  }), () => now);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = "/course/v1/internal/";
  const offer = `${base}checkout-offer?userId=${scope.customerId}&courseId=${scope.courseId}`;
  const grants = base + "entitlements/grants";
  const revoke = base + "entitlements/revocations";
  const headers = {
    host: "api-p407.lashher.com",
    "x-lash-p407-course-proof": proof,
    "x-lash-workload-token": "fixture-oidc",
    authorization: "Bearer fixture-application",
  };
  const send = (path, { method = "GET", requestHeaders = headers, body } = {}) =>
    new Promise((resolve, reject) => {
      const outgoing = request({ hostname: "127.0.0.1", port: server.address().port,
        path, method, headers: requestHeaders }, response => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      });
      outgoing.once("error", reject);
      outgoing.end(body);
    });
  assert.equal(await send(offer, { requestHeaders: { ...headers, "x-lash-p407-course-proof": [proof, proof] } }), 401);
  assert.equal(await send(offer, { requestHeaders: { ...headers, "x-lash-p407-course-proof": "f".repeat(64) } }), 401);
  assert.equal(await send(offer, { requestHeaders: { ...headers, host: "api-staging.lashher.com" } }), 404);
  assert.equal(await send(offer, { requestHeaders: { ...headers, authorization: [] } }), 401);
  assert.equal(await send(offer + "&courseId=" + scope.courseId), 404);
  assert.equal(await send(offer.replace("checkout", "%63heckout")), 404);
  assert.equal(await send("/api/webhooks/square"), 404);
  assert.equal(await send(base + "entitlements/reconcile", { method: "POST" }), 404);
  assert.equal(calls.length, 0);

  assert.equal(await send(offer), 200);
  const payload = {
    userId: scope.customerId, courseId: scope.courseId, orderId: scope.orderId,
    idempotencyKey: "fixture-key",
  };
  const post = (path, data = payload) => send(path, {
    method: "POST", body: JSON.stringify(data),
    requestHeaders: { ...headers, "content-type": "application/json", "x-idempotency-key": payload.idempotencyKey },
  });
  assert.equal(await post(grants, { ...payload, orderId: scope.courseId }), 404);
  assert.equal(await post(grants, { ...payload, idempotencyKey: "another-key" }), 404);
  assert.equal(await post(grants), 200);
  assert.equal(await post(revoke), 200);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.servername, headers.host);
  assert.equal(calls[0].options.hostname, "gateway");
  assert.equal(calls[0].options.headers["x-lash-p407-course-proof"], undefined);
  assert.equal(calls[0].options.headers["x-lash-workload-token"], headers["x-lash-workload-token"]);
  assert.equal(calls[1].options.headers.authorization, headers.authorization);
  assert.deepEqual(JSON.parse(calls[1].body), payload);
  now = Date.parse(scope.expiresAt);
  assert.equal(await post(revoke), 401);
  assert.equal(calls.length, 3);
});
