import assert from "node:assert/strict";
import test from "node:test";

import { canAdmin } from "./permissions";

test("owner has all permissions regardless of resource assignment", () => {
  assert.equal(
    canAdmin({
      action: "audit:view",
      bookingProviderResourceIds: [],
      bookingResourceIds: [],
      role: "owner",
    }),
    true,
  );
  assert.equal(
    canAdmin({
      action: "payments:refund",
      bookingProviderResourceIds: [],
      bookingResourceIds: [],
      role: "owner",
    }),
    true,
  );
});

test("admin has operational access but not owner-only actions", () => {
  assert.equal(
    canAdmin({
      action: "offerings:manage",
      bookingProviderResourceIds: [],
      bookingResourceIds: [],
      role: "admin",
    }),
    true,
  );
  assert.equal(
    canAdmin({
      action: "audit:view",
      bookingProviderResourceIds: [],
      bookingResourceIds: [],
      role: "admin",
    }),
    false,
  );
  assert.equal(
    canAdmin({
      action: "setup:view",
      bookingProviderResourceIds: [],
      bookingResourceIds: [],
      role: "admin",
    }),
    true,
  );
  assert.equal(
    canAdmin({
      action: "settings:manage",
      bookingProviderResourceIds: [],
      bookingResourceIds: [],
      role: "admin",
    }),
    true,
  );
  assert.equal(
    canAdmin({
      action: "service-promotions:manage",
      bookingProviderResourceIds: [],
      bookingResourceIds: [],
      role: "admin",
    }),
    true,
  );
  assert.equal(
    canAdmin({
      action: "payments:refund",
      bookingProviderResourceIds: [],
      bookingResourceIds: [],
      role: "admin",
    }),
    false,
  );
});

test("employee access is restricted to assigned booking resources", () => {
  const base = {
    bookingProviderResourceIds: ["resource-a"],
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
  assert.equal(
    canAdmin({
      ...base,
      action: "bookings:view",
      bookingResourceId: "resource-a",
    }),
    true,
  );
  assert.equal(
    canAdmin({
      ...base,
      action: "bookings:view",
      bookingResourceId: "resource-b",
    }),
    false,
  );
  assert.equal(canAdmin({ ...base, action: "marketing:view" }), false);
  assert.equal(canAdmin({ ...base, action: "offerings:view" }), true);
  assert.equal(canAdmin({ ...base, action: "offerings:manage" }), true);
  assert.equal(
    canAdmin({
      ...base,
      action: "offerings:manage",
      bookingResourceId: "resource-a",
    }),
    true,
  );
  assert.equal(
    canAdmin({
      ...base,
      action: "offerings:manage",
      bookingResourceId: "resource-b",
    }),
    false,
  );
  assert.equal(canAdmin({ ...base, action: "setup:view" }), false);
  assert.equal(canAdmin({ ...base, action: "settings:manage" }), false);
  assert.equal(canAdmin({ ...base, action: "service-promotions:view" }), false);
  assert.equal(
    canAdmin({ ...base, action: "service-promotions:manage" }),
    false,
  );
  assert.equal(
    canAdmin({
      action: "bookings:view",
      bookingProviderResourceIds: [],
      bookingResourceIds: [],
      role: "employee",
    }),
    false,
  );
  assert.equal(
    canAdmin({
      action: "calendar-connections:self-manage",
      bookingProviderResourceIds: [],
      bookingResourceIds: [],
      role: "employee",
    }),
    false,
  );
  assert.equal(
    canAdmin({
      action: "offerings:view",
      bookingProviderResourceIds: [],
      bookingResourceIds: [],
      role: "employee",
    }),
    false,
  );
});

test("calendar self-management requires an assigned provider resource", () => {
  const nonProviderOnly = {
    bookingProviderResourceIds: [],
    bookingResourceIds: ["room-a"],
    role: "employee" as const,
  };

  assert.equal(
    canAdmin({
      ...nonProviderOnly,
      action: "calendar-connections:self-manage",
    }),
    false,
  );
  assert.equal(
    canAdmin({
      ...nonProviderOnly,
      action: "calendar-connections:self-manage",
      bookingResourceId: "room-a",
    }),
    false,
  );
  assert.equal(
    canAdmin({
      ...nonProviderOnly,
      action: "schedules:view",
      bookingResourceId: "room-a",
    }),
    true,
  );
});
