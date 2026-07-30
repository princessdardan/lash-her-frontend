import assert from "node:assert/strict";
import test from "node:test";

import {
  getAdminOverviewAttentionAccess,
  getAdminOverviewResourceScope,
  settleAdminOverviewSections,
} from "./admin-overview-model";
import type { AdminActor } from "./types";

test("contractor overview scope never widens an empty assignment to all resources", () => {
  assert.deepEqual(getAdminOverviewResourceScope(actor("employee", [])), {
    kind: "none",
  });
  assert.deepEqual(
    getAdminOverviewResourceScope(
      actor("employee", ["resource-a", "resource-a", "resource-b"]),
    ),
    {
      ids: ["resource-a", "resource-b"],
      kind: "assigned",
    },
  );
});

test("owner and administrator overview scope is business-wide", () => {
  assert.deepEqual(getAdminOverviewResourceScope(actor("owner", [])), {
    kind: "all",
  });
  assert.deepEqual(getAdminOverviewResourceScope(actor("admin", [])), {
    kind: "all",
  });
});

test("contractor attention links stay within contractor workspaces", () => {
  assert.deepEqual(
    getAdminOverviewAttentionAccess({ ids: ["resource-a"], kind: "assigned" }),
    {
      bookingIssuesHref: null,
      calendarHref: "/admin/my-calendar",
    },
  );
  assert.deepEqual(getAdminOverviewAttentionAccess({ kind: "none" }), {
    bookingIssuesHref: null,
    calendarHref: "/admin/my-calendar",
  });
});

test("business-wide attention links include owner workspaces", () => {
  assert.deepEqual(getAdminOverviewAttentionAccess({ kind: "all" }), {
    bookingIssuesHref: "/admin/booking-issues",
    calendarHref: "/admin/calendar-connections",
  });
});

test("overview section failures remain explicit without discarding healthy data", async () => {
  const result = await settleAdminOverviewSections({
    healthy: async () => ({ count: 3 }),
    unavailable: async () => {
      throw new Error("database timeout");
    },
  });

  assert.deepEqual(result.values.healthy, { count: 3 });
  assert.equal(result.values.unavailable, null);
  assert.deepEqual(
    result.failures.map((failure) => failure.key),
    ["unavailable"],
  );
});

function actor(
  role: AdminActor["user"]["role"],
  bookingResourceIds: string[],
): AdminActor {
  return {
    bookingProviderResourceIds: bookingResourceIds,
    bookingResourceIds,
    user: {
      displayName: "Test staff",
      email: "staff@example.com",
      emailNormalized: "staff@example.com",
      id: "admin-user",
      providerUserId: "provider-user",
      role,
      status: "active",
    },
  };
}
