import assert from "node:assert/strict";
import test from "node:test";

import { getSafeAdminReturnTo } from "./redirects";

test("admin return paths stay inside the protected admin tree", () => {
  assert.equal(getSafeAdminReturnTo("/admin/audit?limit=25"), "/admin/audit?limit=25");
  assert.equal(getSafeAdminReturnTo("/admin"), "/admin");
});

test("admin return paths reject external and sign-in destinations", () => {
  assert.equal(getSafeAdminReturnTo("https://example.com/admin"), "/admin");
  assert.equal(getSafeAdminReturnTo("//example.com/admin"), "/admin");
  assert.equal(getSafeAdminReturnTo("/admin/sign-in?returnTo=/admin"), "/admin");
  assert.equal(getSafeAdminReturnTo("/admin\\example.com"), "/admin");
  assert.equal(getSafeAdminReturnTo(null), "/admin");
});
