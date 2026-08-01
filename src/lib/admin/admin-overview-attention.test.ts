import assert from "node:assert/strict";
import test from "node:test";

import { buildAdminOverviewAttentionItems } from "./admin-overview-attention";
import { getAdminOverviewAttentionAccess } from "./admin-overview-model";

const allIssues = {
  appointmentAttendance: 1,
  appointmentCalendarSync: 2,
  appointmentEmailFailures: 3,
  bookingIssues: 4,
  calendarConnections: 5,
  holdEmailFailures: 6,
  marketingFailures: 7,
  serviceAvailabilityIssues: 8,
  trainingSchedulingIssues: 9,
};

test("contractor attention omits owner-only hold and booking issue records", () => {
  const items = buildAdminOverviewAttentionItems(
    getAdminOverviewAttentionAccess({
      ids: ["resource-a"],
      kind: "assigned",
    }),
    allIssues,
  );

  assert.equal(
    items.some((item) => item.kind === "booking_email"),
    false,
  );
  assert.equal(
    items.some((item) => item.kind === "booking_exception"),
    false,
  );
  assert.equal(
    items.find((item) => item.kind === "calendar_connection")?.href,
    "/admin/my-calendar",
  );
});

test("owner attention splits appointment and hold email failures", () => {
  const items = buildAdminOverviewAttentionItems(
    getAdminOverviewAttentionAccess({ kind: "all" }),
    allIssues,
  );
  const appointmentEmail = items.find((item) => item.kind === "customer_email");
  const holdEmail = items.find((item) => item.kind === "booking_email");
  const bookingIssue = items.find((item) => item.kind === "booking_exception");

  assert.deepEqual(
    {
      count: appointmentEmail?.count,
      href: appointmentEmail?.href,
    },
    {
      count: 3,
      href: "/admin/appointments?view=needs-attention",
    },
  );
  assert.deepEqual(
    { count: holdEmail?.count, href: holdEmail?.href },
    { count: 6, href: "/admin/booking-issues" },
  );
  assert.deepEqual(
    { count: bookingIssue?.count, href: bookingIssue?.href },
    { count: 4, href: "/admin/booking-issues" },
  );
  assert.equal(
    items.find((item) => item.kind === "calendar_connection")?.href,
    "/admin/calendar-connections",
  );
});
