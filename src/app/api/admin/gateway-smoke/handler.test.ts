import assert from "node:assert/strict";
import test from "node:test";
import { AdminAuthError } from "@/lib/admin/types";
import { createAdminGatewaySmokeHandler, createScheduledGatewaySmokeHandler } from "./handler";

test("admin smoke requires enablement and application permission before upstream work", async () => {
  let calls = 0;
  const run = async () => { calls++; return { ok: true as const, service: "course" as const, durationMs: 1 }; };
  assert.equal((await createAdminGatewaySmokeHandler({ enabled: () => false, authorize: async () => {}, run })()).status, 404);
  for (const [code, status] of [["unauthenticated", 401], ["forbidden", 403]] as const) {
    const response = await createAdminGatewaySmokeHandler({ enabled: () => true, authorize: async () => { throw new AdminAuthError(code); }, run })();
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(calls, 0);
  assert.equal((await createAdminGatewaySmokeHandler({ enabled: () => true, authorize: async () => {}, run })()).status, 200);
  assert.equal(calls, 1);
});

test("scheduled smoke fails closed without its bearer and never relays incoming credentials", async () => {
  let calls = 0;
  const handler = createScheduledGatewaySmokeHandler({ enabled: () => true, getSecret: () => "synthetic-cron-proof",
    run: async () => { calls++; return { ok: true, service: "course", durationMs: 1 }; }
  });
  assert.equal((await handler(new Request("https://example.test/"))).status, 401);
  assert.equal((await handler(new Request("https://example.test/", { headers: { authorization: "Bearer wrong", "x-lash-workload-token": "forged" } }))).status, 401);
  assert.equal(calls, 0);
  assert.equal((await handler(new Request("https://example.test/", { headers: { authorization: "Bearer synthetic-cron-proof" } }))).status, 200);
  assert.equal(calls, 1);
});

test("upstream/SDK failures are non-2xx and omit private diagnostics", async () => {
  const response = await createAdminGatewaySmokeHandler({ enabled: () => true, authorize: async () => {}, run: async () => { throw new Error("private upstream credential"); } })();
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes("private upstream credential"));
});
