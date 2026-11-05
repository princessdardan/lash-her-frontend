import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createAccountHandler } from "./handler";
import type { AccountLifecycleStore } from "./store";

const origin = "https://customer.example.com";
const session = { userId: randomUUID(), tokenHash: "synthetic-session-hash" };
function fixture() {
  const calls: Array<{ operation: string; input: unknown }> = [];
  const store = {
    async request(input: unknown) { calls.push({ operation: "command", input }); return { commandId: randomUUID(), userId: session.userId, accountVersion: 1, action: "export" }; },
    async updatePreferences(...input: unknown[]) { calls.push({ operation: "preferences", input }); },
    async overview(input: unknown) { calls.push({ operation: "overview", input }); return { commands: [] }; },
    async getExport(...input: unknown[]) { calls.push({ operation: "export", input }); return { private: true }; },
  } as unknown as AccountLifecycleStore;
  const handler = createAccountHandler({ enabled: () => true, origin: () => origin, session: async () => session, store: () => store, run: async (_kind, task) => { calls.push({ operation: "admission", input: null }); return task(); } });
  return { handler, calls, store };
}
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => new Request(`${origin}${path}`, { method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("customer account commands derive identity from the server session and enter admission before writing", async () => {
  const { handler, calls } = fixture();
  const idempotencyKey = randomUUID();
  const response = await handler(post("/api/account/commands", { action: "export", idempotencyKey }));
  assert.equal(response.status, 202); assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(calls.map(row => row.operation), ["admission", "command"]);
  assert.deepEqual(calls[1].input, { userId: session.userId, action: "export", idempotencyKey, requester: { kind: "customer", session } });
  assert.equal(JSON.stringify(await response.json()).includes(session.tokenHash), false);
});
test("CSRF, unexpected bodies, privileged actions and oversized input refuse before admission or data access", async () => {
  const { handler, calls } = fixture();
  for (const request of [
    post("/api/account/commands", { action: "delete", idempotencyKey: randomUUID() }, { origin: "https://attacker.example" }),
    post("/api/account/commands", { action: "delete", idempotencyKey: randomUUID() }, { "sec-fetch-site": "cross-site" }),
    post("/api/account/commands", { action: "delete", idempotencyKey: randomUUID(), userId: randomUUID() }),
    post("/api/account/commands", { action: "restore", idempotencyKey: randomUUID() }),
    post("/api/account/commands", { action: "suspend", idempotencyKey: randomUUID() }),
    post("/api/account/commands", { value: "x".repeat(5_000) }),
    post("/api/account/preferences", { learningUpdates: true, marketing: true }),
  ]) assert.ok((await handler(request)).status >= 400);
  assert.equal(calls.length, 0);
});
test("private download is bound to the authenticated UUID, uses attachment/no-store and refuses malformed paths", async () => {
  const { handler, calls } = fixture();
  const commandId = randomUUID();
  const response = await handler(new Request(`${origin}/api/account/exports/${commandId}`));
  assert.equal(response.status, 200); assert.match(response.headers.get("content-disposition") ?? "", /^attachment;/u);
  assert.deepEqual(calls[0], { operation: "export", input: [session.userId, commandId] });
  for (const path of ["/api/account/exports/not-a-uuid", `/api/account/exports/${commandId}?userId=${randomUUID()}`, "/api/account/other"]) assert.ok((await handler(new Request(`${origin}${path}`))).status >= 400);
  assert.equal(calls.length, 1);
});
test("disabled and unauthenticated routes make no store or admission calls; unexpected failures expose no private details", async () => {
  const { store } = fixture();
  for (const sessionResolver of [async () => null, async () => { throw new Error("secret-provider-body"); }]) {
    const handler = createAccountHandler({ enabled: () => true, origin: () => origin, session: sessionResolver, store: () => { throw new Error("must-not-access-store"); } });
    const response = await handler(new Request(`${origin}/api/account`));
    assert.ok(response.status >= 400); assert.equal((await response.text()).includes("secret-provider-body"), false);
  }
  const disabled = createAccountHandler({ enabled: () => false, session: async () => { throw new Error(); }, store: () => store });
  assert.equal((await disabled(new Request(`${origin}/api/account`))).status, 404);
});
