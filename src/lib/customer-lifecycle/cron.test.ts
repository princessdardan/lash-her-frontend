import assert from "node:assert/strict";
import test from "node:test";
import { createAccountLifecycleCron } from "./cron";

test("lifecycle recovery is independently disabled and authenticated before any database or receiver work", async () => {
  let calls = 0;
  const run = async () => { calls++; return { acknowledged: 1, retrying: 0, blocked: 0, exportsReady: 0, expired: 0 }; };
  const request = (authorization: string) => new Request("https://staging.example.com/api/cron/account-lifecycle", { headers: { authorization } });
  const disabled = createAccountLifecycleCron({ enabled: () => false, secret: () => "owned", run });
  assert.equal((await disabled(request("Bearer owned"))).status, 404);
  const missing = createAccountLifecycleCron({ enabled: () => true, secret: () => undefined, run });
  assert.equal((await missing(request("Bearer owned"))).status, 404);
  const handler = createAccountLifecycleCron({ enabled: () => true, secret: () => "owned", run });
  for (const value of ["", "owned", "Basic owned", "Bearer wrong"]) assert.equal((await handler(request(value))).status, 401);
  assert.equal(calls, 0);
  const response = await handler(request("Bearer owned"));
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(calls, 1);
});
test("unavailable receivers, rejected commands and unexpected errors return sanitized retryable responses", async () => {
  for (const outcome of ["retry", "blocked", "error"]) {
    const handler = createAccountLifecycleCron({ enabled: () => true, secret: () => "owned", run: async () => {
      if (outcome === "error") throw new Error("private-receiver-credentials");
      return { acknowledged: 0, retrying: outcome === "retry" ? 1 : 0, blocked: outcome === "blocked" ? 1 : 0, exportsReady: 0, expired: 0 };
    } });
    const response = await handler(new Request("https://staging.example.com/api/cron/account-lifecycle", { headers: { authorization: "Bearer owned" } }));
    assert.equal(response.status, 503); assert.equal(response.headers.get("retry-after"), "30");
    assert.equal((await response.text()).includes("private-receiver-credentials"), false);
  }
});
