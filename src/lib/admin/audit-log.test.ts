import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeAdminAuditMetadata } from "./audit-metadata";

test("audit metadata recursively removes credentials and direct email fields", () => {
  assert.deepEqual(sanitizeAdminAuditMetadata({
    status: "updated",
    accessToken: "sensitive",
    nested: {
      customerEmail: "customer@example.com",
      count: 2,
    },
  }), {
    status: "updated",
    nested: { count: 2 },
  });
});
