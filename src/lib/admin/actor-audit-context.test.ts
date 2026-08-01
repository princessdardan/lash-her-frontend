import assert from "node:assert/strict";
import test from "node:test";

import { addAdminActorAuditContext } from "./actor-audit-context";
import type { AdminActor } from "./types";

test("developer mutations add represented and simulated roles to audit metadata", () => {
  const actor = createActor();

  assert.deepEqual(addAdminActorAuditContext(actor, { status: "active" }), {
    developerMode: true,
    representedAccountRole: "employee",
    simulatedPermissionRole: "owner",
    status: "active",
  });
});

test("normal mutations preserve their audit metadata", () => {
  const actor = createActor();
  delete actor.developerMode;
  const metadata = { status: "active" };

  assert.equal(addAdminActorAuditContext(actor, metadata), metadata);
});

function createActor(): AdminActor {
  return {
    bookingProviderResourceIds: [],
    bookingResourceIds: [],
    developerMode: {
      accountRole: "employee",
      permissionRole: "owner",
    },
    user: {
      displayName: "Contractor",
      email: "contractor@example.com",
      emailNormalized: "contractor@example.com",
      id: "4d68f682-90ab-4cdb-8f59-67f7f9414df1",
      providerUserId: "pending:contractor",
      role: "owner",
      status: "active",
    },
  };
}
