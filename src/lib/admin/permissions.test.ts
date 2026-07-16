import assert from "node:assert/strict";
import test from "node:test";

import { canAdmin } from "./permissions";

test("owner has all permissions regardless of resource assignment", () => {
  assert.equal(canAdmin({
    action: "audit:view",
    bookingResourceIds: [],
    role: "owner",
  }), true);
  assert.equal(canAdmin({
    action: "payments:refund",
    bookingResourceIds: [],
    role: "owner",
  }), true);
});

test("admin has operational access but not owner-only actions", () => {
  assert.equal(canAdmin({
    action: "offerings:manage",
    bookingResourceIds: [],
    role: "admin",
  }), true);
  assert.equal(canAdmin({
    action: "audit:view",
    bookingResourceIds: [],
    role: "admin",
  }), false);
  assert.equal(canAdmin({
    action: "payments:refund",
    bookingResourceIds: [],
    role: "admin",
  }), false);
});

test("employee access is restricted to assigned booking resources", () => {
  const base = {
    bookingResourceIds: ["resource-a"],
    role: "employee" as const,
  };

  assert.equal(canAdmin({ ...base, action: "bookings:view" }), true);
  assert.equal(
    canAdmin({ ...base, action: "calendar-connections:self-manage" }),
    true,
  );
  assert.equal(
    canAdmin({
      ...base,
      action: "calendar-connections:self-manage",
      bookingResourceId: "resource-a",
    }),
    true,
  );
  assert.equal(
    canAdmin({
      ...base,
      action: "calendar-connections:self-manage",
      bookingResourceId: "resource-b",
    }),
    false,
  );
  assert.equal(canAdmin({
    ...base,
    action: "bookings:view",
    bookingResourceId: "resource-a",
  }), true);
  assert.equal(canAdmin({
    ...base,
    action: "bookings:view",
    bookingResourceId: "resource-b",
  }), false);
  assert.equal(canAdmin({ ...base, action: "marketing:view" }), false);
  assert.equal(canAdmin({
    action: "bookings:view",
    bookingResourceIds: [],
    role: "employee",
  }), false);
  assert.equal(canAdmin({
    action: "calendar-connections:self-manage",
    bookingResourceIds: [],
    role: "employee",
  }), false);
});
