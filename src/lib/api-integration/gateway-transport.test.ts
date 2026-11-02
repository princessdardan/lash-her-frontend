import assert from "node:assert/strict";
import test from "node:test";
import { createGatewayTransport, GatewayTransportError } from "./gateway-transport";

test("transport obtains workload proof per call, preserves application JWT and safe 429 envelope", async () => {
  let tokens = 0;
  const transport = createGatewayTransport({
    origin: "https://gateway.example.test",
    getWorkloadToken: async () => `proof-${++tokens}`,
    fetch: async (url, options) => {
      assert.equal(String(url), "https://gateway.example.test/course/v1/student/courses?cursor=x");
      assert.equal(options?.cache, "no-store"); assert.equal(options?.redirect, "manual");
      const headers = new Headers(options?.headers);
      assert.equal(headers.get("x-lash-workload-token"), `proof-${tokens}`);
      assert.equal(headers.get("authorization"), "Bearer application.jwt");
      assert.equal(headers.get("cookie"), null);
      return Response.json({ error: { code: "TOO_MANY_REQUESTS", message: "Retry later" } }, {
        status: 429, headers: { "retry-after": "15", "set-cookie": "private=secret" },
      });
    },
  });
  for (let i = 0; i < 2; i++) {
    const response = await transport({ method: "GET", path: "/v1/student/courses?cursor=x", applicationToken: "application.jwt" });
    assert.equal(response.status, 429); assert.equal(response.headers.get("retry-after"), "15");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal((await response.json()).error.code, "TOO_MANY_REQUESTS");
  }
  assert.equal(tokens, 2);
});

test("invalid routes and missing application authorization refuse before obtaining workload proof", async () => {
  let proofs = 0;
  const transport = createGatewayTransport({ origin: "https://gateway.example.test", getWorkloadToken: async () => { proofs++; return "proof"; } });
  for (const path of ["//attacker.test", "/v1/courses/../admin/courses", "/v1/courses/%2e%2e", "/metrics", "/v1/internal/community/entitlements/check", "/v1/webhooks/mux"]) {
    await assert.rejects(transport({ method: "GET", path }), GatewayTransportError);
  }
  await assert.rejects(transport({ method: "GET", path: "/v1/student/courses" }), GatewayTransportError);
  assert.equal(proofs, 0);
  for (const origin of ["http://gateway.test", "https://user:secret@gateway.test", "https://gateway.test/path", "https://gateway.test?secret=x"]) assert.throws(() => createGatewayTransport({ origin }), GatewayTransportError);
});

test("transport refuses redirects, cancels oversized responses and sanitizes SDK/network failures", async () => {
  for (const fetch of [
    async () => new Response(null, { status: 302, headers: { location: "https://attacker.test" } }),
    async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1)),
    async () => { throw new Error("private-credential"); },
  ]) {
    const transport = createGatewayTransport({ origin: "https://gateway.example.test", getWorkloadToken: async () => "proof", fetch });
    await assert.rejects(transport({ method: "GET", path: "/v1/courses" }), (error: unknown) => error instanceof GatewayTransportError && !error.message.includes("private-credential"));
  }
  const transport = createGatewayTransport({ origin: "https://gateway.example.test", getWorkloadToken: async () => { throw new Error("private-credential"); } });
  await assert.rejects(transport({ method: "GET", path: "/v1/courses" }), { message: "Gateway transport unavailable" });
});
