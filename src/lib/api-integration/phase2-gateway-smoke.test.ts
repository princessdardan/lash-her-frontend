import assert from "node:assert/strict";
import test from "node:test";
import { runPhase2GatewaySmoke } from "./phase2-gateway-smoke";

const course = {
  id: "11111111-1111-4111-8111-111111111111", slug: "fixture", title: "Fixture", description: null,
  priceCents: 0, currency: "CAD", accessMode: "free", introduction: null, cover: null, seo: null,
};

test("P2 gateway smoke validates the current paginated catalog and metadata", async () => {
  for (const value of [{ courses: [], nextCursor: null }, { courses: [course], nextCursor: "next-page" }]) {
    const result = await runPhase2GatewaySmoke(async input => {
      assert.deepEqual(input, { method: "GET", path: "/v1/courses" });
      return Response.json(value);
    });
    assert.equal(result.ok, true);
  }
});

test("P2 gateway smoke refuses legacy, malformed, private and undocumented catalog fields", async () => {
  for (const value of [
    { courses: [] }, { courses: [], nextCursor: 1 }, { courses: [{ ...course, accessMode: "other" }], nextCursor: null },
    { courses: [{ ...course, cover: { url: "https://example.test/cover", alt: 1 } }], nextCursor: null },
    { courses: [{ ...course, email: "private" }], nextCursor: null }, { courses: [], nextCursor: null, private: true },
  ]) await assert.rejects(runPhase2GatewaySmoke(async () => Response.json(value)));
  for (const response of [Response.json({}, { status: 401 }), Response.json({}, { status: 500 }), new Response("{}")]) {
    await assert.rejects(runPhase2GatewaySmoke(async () => response), { message: "Gateway transport unavailable" });
  }
});
