import assert from "node:assert/strict";
import test from "node:test";
import { p2FirstOwnerDiscoveryEmailSha256 } from "../../../ops/platform/p2-first-owner-identity.mjs";
import { withWriterOperationContext, writerFirstOwnerDiscoveryWindowSha256 } from "@/lib/writer-admission/context";
import type { WriterAdmissionRunner } from "@/lib/writer-admission/runtime";
import { withAdminAuthRouteAdmission } from "./auth-route-admission";

const nonce = "8".repeat(32), email = "owner@example.invalid";
const discovery = { nonce, emailDigest: p2FirstOwnerDiscoveryEmailSha256(nonce, email)!.slice(0, 62),
  epoch: "12", startedAt: Math.floor(Date.now() / 1000) };
const run: WriterAdmissionRunner = async (_kind, task) => withWriterOperationContext(task,
  undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, discovery);

function request() {
  return new Request("https://staging.lashher.com/api/auth/session");
}

function session(overrides: Record<string, unknown> = {}) {
  return { expires: new Date(Date.now() + 60_000).toISOString(), user: {
    name: "Owner", email, image: null, providerUserId: "google-subject", isEmailVerified: true,
    authenticatedAt: discovery.startedAt, firstOwnerDiscoveryWindowSha256: writerFirstOwnerDiscoveryWindowSha256(discovery),
    ...overrides,
  } };
}

test("first-owner discovery session route admits only the fresh selected verified Google session", async () => {
  const handler = withAdminAuthRouteAdmission(async () => Response.json(session()), run);
  const response = await handler(request());
  assert.equal(response.status, 200);
});

test("first-owner discovery session route refuses wrong email, window, freshness and subject", async () => {
  for (const changed of [
    { email: "other@example.invalid" },
    { firstOwnerDiscoveryWindowSha256: "6".repeat(64) },
    { authenticatedAt: discovery.startedAt - 1 },
    { providerUserId: "" },
    { providerUserId: "ü" },
    { providerUserId: "s".repeat(256) },
    { isEmailVerified: false },
  ]) {
    const handler = withAdminAuthRouteAdmission(async () => Response.json(session(changed)), run);
    const response = await handler(request());
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), null);
  }
});

test("first-owner discovery and materialization scopes cannot coexist", async () => {
  const firstOwner = { nonce, identityDigest: "6".repeat(62), epoch: discovery.epoch, startedAt: discovery.startedAt };
  await assert.rejects(withWriterOperationContext(async () => { await Promise.resolve(); }, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, firstOwner, undefined, discovery), /WRITER_OPERATION_SCOPE_REFUSED/u);
});
