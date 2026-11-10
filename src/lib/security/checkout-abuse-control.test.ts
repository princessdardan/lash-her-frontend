import assert from "node:assert/strict";
import test from "node:test";
import { interactiveAdmissionFixture } from "@/lib/writer-admission/interactive-fixture";
import { checkCartPreviewRateLimit } from "./checkout-abuse-control";

const input = { key: "owned-cart-preview", now: new Date("2026-11-10T00:00:00Z") };

test("cart preview holds admission across the Redis rate-limit receipt", async (t) => {
  const previousUrl = process.env.KV_REST_API_URL;
  const previousToken = process.env.KV_REST_API_TOKEN;
  process.env.KV_REST_API_URL = "https://owned-redis.invalid";
  process.env.KV_REST_API_TOKEN = "owned-cart-limiter-token";
  t.after(() => {
    if (previousUrl === undefined) delete process.env.KV_REST_API_URL;
    else process.env.KV_REST_API_URL = previousUrl;
    if (previousToken === undefined) delete process.env.KV_REST_API_TOKEN;
    else process.env.KV_REST_API_TOKEN = previousToken;
  });

  const fixture = interactiveAdmissionFixture();
  let response: "valid" | "malformed" | "lost" = "valid";
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    assert.equal(new URL(url).pathname, "/pipeline");
    assert.equal(fixture.events.at(-1), "admitted");
    fixture.events.push("redis");
    if (response === "lost") throw new Error("Synthetic response loss");
    return Response.json([{ result: response === "valid" ? [1, 1, 0] : [1] }]);
  });

  fixture.state.open = false;
  await assert.rejects(
    checkCartPreviewRateLimit(input, fixture.run),
    /Writer admission unavailable/u,
  );
  assert.deepEqual(fixture.events, []);

  fixture.state.open = true;
  assert.deepEqual(
    await checkCartPreviewRateLimit(input, fixture.run),
    { allowed: true, remaining: 59 },
  );
  assert.deepEqual(fixture.events, ["admitted", "redis", "settled"]);
  assert.equal(fixture.state.uncertain, false);

  for (const failedResponse of ["malformed", "lost"] as const) {
    response = failedResponse;
    fixture.events.length = 0;
    await assert.rejects(
      checkCartPreviewRateLimit(input, fixture.run),
      /Writer admission outcome/u,
    );
    assert.deepEqual(fixture.events, ["admitted", "redis", "settled"]);
    assert.equal(fixture.state.uncertain, true);
  }
});
