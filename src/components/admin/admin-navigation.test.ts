import assert from "node:assert/strict";
import test from "node:test";

import { isActiveAdminPath } from "./admin-navigation";

test("admin root is active only for the dashboard", () => {
  assert.equal(isActiveAdminPath("/admin", "/admin"), true);
  assert.equal(isActiveAdminPath("/admin/appointments", "/admin"), false);
});

test("admin sections remain active for nested detail routes", () => {
  assert.equal(
    isActiveAdminPath(
      "/admin/appointments/appointment-id",
      "/admin/appointments",
    ),
    true,
  );
  assert.equal(
    isActiveAdminPath("/admin/booking-settings", "/admin/setup"),
    false,
  );
});
