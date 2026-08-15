import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveConfiguredFulfillmentOwner,
  resolveConfiguredOwnerIdentity,
} from "./configured-owner";

const duties = [
  "business_owner",
  "operations_lead",
  "finance_owner",
  "payment_fraud_owner",
  "privacy_owner",
  "security_owner",
] as const;

test("configured fulfillment owner rejects a second active owner", () => {
  const owner = {
    id: "owner-1",
    displayName: "Nataliea Lavoie",
    email: "nataliea@example.invalid",
  };
  const assignments = duties.map((duty) => ({
    adminUserId: owner.id,
    duty,
  }));

  assert.equal(
    resolveConfiguredFulfillmentOwner({
      actorAdminUserId: owner.id,
      assignments,
      configuredEmails: [owner.email],
      owners: [
        owner,
        {
          id: "owner-2",
          displayName: "Unexpected Owner",
          email: "other@example.invalid",
        },
      ],
    }),
    null,
  );
});

test("configured fulfillment owner requires every duty on the same owner", () => {
  const owner = {
    id: "owner-1",
    displayName: "Nataliea Lavoie",
    email: "nataliea@example.invalid",
  };
  assert.equal(
    resolveConfiguredFulfillmentOwner({
      actorAdminUserId: owner.id,
      assignments: duties.slice(0, -1).map((duty) => ({
        adminUserId: owner.id,
        duty,
      })),
      configuredEmails: [owner.email],
      owners: [owner],
    }),
    null,
  );
});

test("configured owner identity rejects a second owner and an email mismatch", () => {
  const owner = {
    id: "owner-1",
    displayName: "Nataliea Lavoie",
    email: "nataliea@example.invalid",
  };
  assert.equal(
    resolveConfiguredOwnerIdentity({
      actorAdminUserId: owner.id,
      configuredEmails: [owner.email],
      owners: [
        owner,
        {
          id: "owner-2",
          displayName: "Unexpected Owner",
          email: "other@example.invalid",
        },
      ],
    }),
    null,
  );
  assert.equal(
    resolveConfiguredOwnerIdentity({
      actorAdminUserId: owner.id,
      configuredEmails: ["different@example.invalid"],
      owners: [owner],
    }),
    null,
  );
});
