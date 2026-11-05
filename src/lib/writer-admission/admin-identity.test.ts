import assert from "node:assert/strict";
import test from "node:test";
import {
  withAdminUserWriterAdmission,
  runAdminIdentityWriter,
} from "@/lib/admin/user-writer-admission";
import { withAdminAuthRouteAdmission } from "@/lib/admin/auth-route-admission";
import type { AdminUserRepository } from "@/lib/admin/admin-user-store";
import { WriterAdmissionError } from "./config";
import { withWriterAdmission } from "./route";
import { interactiveAdmissionFixture } from "./interactive-fixture";
import type { WriterAdmissionRunner } from "./runtime";

function identityRepository(effects: string[]): AdminUserRepository {
  const user = {
    id: "owned",
    displayName: "Owned",
    email: "owned@example.invalid",
    emailNormalized: "owned@example.invalid",
    providerUserId: "owned-provider",
    role: "admin" as const,
    status: "active" as const,
  };
  return {
    bindIdentity: async () => {
      effects.push("bind");
      return user;
    },
    createBootstrapOwner: async () => {
      effects.push("bootstrap");
      return user;
    },
    recordSignIn: async () => {
      effects.push("refresh");
      return user;
    },
    findByEmailNormalized: async () => user,
    findByProviderUserId: async () => user,
    listBookingProviderResourceIds: async () => [],
    listBookingResourceIds: async () => [],
  };
}
const identity = {
  adminUserId: "owned",
  displayName: "Owned",
  email: "owned@example.invalid",
  providerUserId: "owned-provider",
  emailVerified: true,
};

test("admin identity bootstrap/binding require new work, while known-user heartbeat may recover", async () => {
  const kinds: string[] = [],
    effects: string[] = [];
  const run: WriterAdmissionRunner = async (kind, task) => {
    kinds.push(kind);
    if (kind === "new-work") throw new WriterAdmissionError("unavailable");
    return task();
  };
  const store = withAdminUserWriterAdmission(identityRepository(effects), run);
  await assert.rejects(store.bindIdentity(identity), WriterAdmissionError);
  await assert.rejects(
    store.createBootstrapOwner(identity),
    WriterAdmissionError,
  );
  await store.recordSignIn(identity);
  assert.deepEqual(kinds, ["new-work", "new-work", "recovery"]);
  assert.deepEqual(effects, ["refresh"]);
});

test("an inner writer failure caught by authentication policy still leaves parent admission uncertain", async () => {
  const parent = interactiveAdmissionFixture(),
    child = interactiveAdmissionFixture();
  const response = await withWriterAdmission(
    "recovery",
    async () => {
      try {
        await runAdminIdentityWriter(
          "recovery",
          async () => {
            throw new Error("owned-private-marker");
          },
          child.run,
        );
      } catch {
        /* existing auth policy preserves a denial/fallback */
      }
      return Response.json({ ok: true });
    },
    parent.run,
  )();
  assert.equal(response.status, 503);
  assert.equal(child.state.uncertain, true);
  assert.equal(parent.state.uncertain, true);
});

test("admin authentication routes classify provider initiation separately from callback/session/sign-out recovery", async () => {
  const kinds: string[] = [];
  const run: WriterAdmissionRunner = async (kind, task) => {
    kinds.push(kind);
    if (kind === "new-work") throw new WriterAdmissionError("unavailable");
    return task();
  };
  let calls = 0;
  const handler = withAdminAuthRouteAdmission(async (request: Request) => {
    calls++;
    await request.text();
    return Response.json({ ok: true });
  }, run);
  const signin = new Request("https://owned.invalid/api/auth/signin/google", {
    method: "POST",
    body: "untouched",
  });
  assert.equal((await handler(signin)).status, 503);
  assert.equal(signin.bodyUsed, false);
  for (const action of ["callback/google", "session", "signout"])
    assert.equal(
      (await handler(new Request(`https://owned.invalid/api/auth/${action}`)))
        .status,
      200,
    );
  assert.deepEqual(kinds, ["new-work", "recovery", "recovery", "recovery"]);
  assert.equal(calls, 3);
});

test("admin sign-out awaits the installed Auth.js raw-response shape before returning its fixed redirect", async () => {
  const { completeAdminSignOut } = await import("@/lib/admin/sign-out");
  for (const developer of [false, true]) {
    const events: string[] = [];
    const result = await completeAdminSignOut({
      hasDeveloperSession: async () => developer,
      clearDeveloperSession: async () => {
        events.push("clear");
      },
      signOut: async () => {
        events.push("authjs");
        return { redirect: "/admin/sign-in", cookies: [], status: 302 };
      },
    });
    assert.equal(result, "/admin/sign-in");
    assert.equal(typeof result, "string");
    assert.deepEqual(events, developer ? ["clear"] : ["clear", "authjs"]);
  }
});
