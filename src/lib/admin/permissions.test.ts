import assert from "node:assert/strict";
import test from "node:test";

import { canAdmin } from "./permissions";

test("owner can export privacy data and review audit logs", () => {
  assert.equal(canAdmin({ role: "owner", action: "privacy:export" }), true);
  assert.equal(canAdmin({ role: "owner", action: "audit:view" }), true);
});

test("operator can view operations but cannot export or review audit logs", () => {
  assert.equal(canAdmin({ role: "operator", action: "orders:view" }), true);
  assert.equal(canAdmin({ role: "operator", action: "bookings:view" }), true);
  assert.equal(canAdmin({ role: "operator", action: "training:view" }), true);
  assert.equal(canAdmin({ role: "operator", action: "marketing:view" }), true);
  assert.equal(canAdmin({ role: "operator", action: "privacy:export" }), false);
  assert.equal(canAdmin({ role: "operator", action: "audit:view" }), false);
  assert.equal(canAdmin({ role: "operator", action: "privacy:decision" }), false);
});
