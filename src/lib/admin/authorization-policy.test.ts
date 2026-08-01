import assert from "node:assert/strict";
import test from "node:test";

import {
  ADMIN_PERMISSION_DENIAL_AUDIT_EVENT,
  requirePermissionWithAudit,
} from "./authorization-policy";
import { AdminAuthError, type AdminActor } from "./types";

const owner = actor("owner");
const contractor = actor("employee");

test("successful permission checks do not record a denial", async () => {
  let denialCount = 0;

  const result = await requirePermissionWithAudit({
    action: "audit:view",
    getActor: async () => owner,
    recordDenial: async () => {
      denialCount += 1;
    },
  });

  assert.equal(result, owner);
  assert.equal(denialCount, 0);
});

test("failed denial recording cannot mask the original permission error", async () => {
  let recordedPermission: string | null = null;

  await assert.rejects(
    requirePermissionWithAudit({
      action: "marketing:view",
      getActor: async () => contractor,
      recordDenial: async ({ actor: deniedActor, requestedPermission }) => {
        assert.equal(deniedActor, contractor);
        recordedPermission = requestedPermission;
        throw new Error("Audit storage unavailable");
      },
    }),
    (error) => error instanceof AdminAuthError && error.code === "forbidden",
  );

  assert.equal(recordedPermission, "marketing:view");
});

test("identity failures do not record permission-denial activity", async () => {
  let denialCount = 0;

  await assert.rejects(
    requirePermissionWithAudit({
      action: "marketing:view",
      getActor: async () => {
        throw new AdminAuthError("unauthenticated");
      },
      recordDenial: async () => {
        denialCount += 1;
      },
    }),
    (error) =>
      error instanceof AdminAuthError && error.code === "unauthenticated",
  );

  assert.equal(denialCount, 0);
});

test("permission denial audit codes are fixed and allowlisted", () => {
  assert.deepEqual(ADMIN_PERMISSION_DENIAL_AUDIT_EVENT, {
    action: "permission_denied",
    domain: "authorization",
    outcome: "denied",
    reason: "insufficient_permission",
  });
});

function actor(role: AdminActor["user"]["role"]): AdminActor {
  return {
    bookingProviderResourceIds: [],
    bookingResourceIds: [],
    user: {
      displayName: "Staff member",
      email: "staff@example.com",
      emailNormalized: "staff@example.com",
      id: "4d68f682-90ab-4cdb-8f59-67f7f9414df1",
      providerUserId: "google-staff",
      role,
      status: "active",
    },
  };
}
