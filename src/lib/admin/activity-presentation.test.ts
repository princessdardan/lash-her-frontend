import assert from "node:assert/strict";
import test from "node:test";

import {
  getAdminActivityDomains,
  parseAdminActivityQuery,
  presentAdminActivity,
  type AdminActivitySourceRecord,
} from "./activity-presentation";

test("activity filters parse URL values with Toronto date boundaries", () => {
  const parsed = parseAdminActivityQuery({
    actor: "4d68f682-90ab-4cdb-8f59-67f7f9414df1",
    area: "services",
    from: "2026-03-08",
    page: "3",
    result: "failure",
    to: "2026-03-08",
  });

  assert.equal(parsed.dateError, null);
  assert.equal(parsed.filters.actorId, "4d68f682-90ab-4cdb-8f59-67f7f9414df1");
  assert.equal(parsed.filters.area, "services");
  assert.equal(parsed.filters.outcome, "failure");
  assert.equal(parsed.filters.page, 3);
  assert.equal(
    parsed.filters.createdFrom?.toISOString(),
    "2026-03-08T05:00:00.000Z",
  );
  assert.equal(
    parsed.filters.createdToExclusive?.toISOString(),
    "2026-03-09T04:00:00.000Z",
  );
  assert.deepEqual(getAdminActivityDomains("services"), [
    "offerings",
    "service_promotions",
  ]);
  assert.deepEqual(getAdminActivityDomains("authorization"), ["authorization"]);
});

test("activity filters reject invalid calendar dates and reversed ranges", () => {
  const invalid = parseAdminActivityQuery({
    from: "2026-02-30",
    to: "2026-03-02",
  });
  assert.equal(invalid.dateError, "Use valid From and To dates.");
  assert.equal(invalid.filters.createdFrom, undefined);
  assert.equal(invalid.filters.createdToExclusive, undefined);

  const reversed = parseAdminActivityQuery({
    from: "2026-07-20",
    to: "2026-07-10",
  });
  assert.equal(
    reversed.dateError,
    "The From date must be on or before the To date.",
  );
  assert.equal(reversed.filters.createdFrom, undefined);
  assert.equal(reversed.filters.createdToExclusive, undefined);
});

test("activity presentation uses human sentences and keeps codes in system details", () => {
  const completed = presentAdminActivity(
    record({
      action: "staff_status_changed",
      actorDisplayName: "Dardan",
      metadata: { status: "disabled" },
      targetLabel: "Taylor",
      targetType: "admin_user",
    }),
  );
  assert.equal(completed.description, "Dardan disabled Taylor's access.");
  assert.equal(completed.areaLabel, "Team");
  assert.equal(completed.result.label, "Completed");
  assert.equal(completed.targetHref, "/admin/staff");
  assert.equal(completed.systemDetails.action, "staff_status_changed");

  const denied = presentAdminActivity(
    record({
      action: "appointment_marked_no_show",
      outcome: "denied",
      targetLabel: "Appointment LH-1042",
      targetType: "appointment",
    }),
  );
  assert.equal(
    denied.description,
    "Dardan was not allowed to mark Appointment LH-1042 as a no-show.",
  );
  assert.equal(denied.result.label, "Not allowed");

  const failed = presentAdminActivity(
    record({
      action: "calendar_connection_authorized",
      outcome: "failure",
      targetLabel: "Google Calendar account",
      targetType: "calendar_connection",
    }),
  );
  assert.equal(
    failed.description,
    "An attempt by Dardan to connect Google Calendar account failed.",
  );
  assert.equal(failed.result.label, "Failed");

  const permissionDenied = presentAdminActivity(
    record({
      action: "permission_denied",
      domain: "authorization",
      metadata: { requestedPermission: "marketing:view" },
      outcome: "denied",
      targetId: null,
      targetLabel: null,
      targetType: null,
    }),
  );
  assert.equal(
    permissionDenied.description,
    "Dardan was not allowed to access a restricted admin area.",
  );
  assert.equal(permissionDenied.areaLabel, "Access control");
  assert.doesNotMatch(permissionDenied.description, /marketing:view/);
  assert.equal(
    permissionDenied.systemDetails.requestedPermission,
    "marketing:view",
  );
});

test("legacy OAuth cleanup and unknown action rows remain honest and readable", () => {
  const oauthCleanup = presentAdminActivity(
    record({
      action: "calendar_connection_authorization_failed",
      outcome: "success",
      targetLabel: "Google Calendar account",
      targetType: "calendar_connection",
    }),
  );
  assert.equal(
    oauthCleanup.description,
    "Dardan recorded a failed Google Calendar authorization for Google Calendar account.",
  );
  assert.equal(oauthCleanup.result.label, "Failed");
  assert.equal(oauthCleanup.systemDetails.outcome, "success");

  const unknown = presentAdminActivity(
    record({
      action: "future_admin_action",
      actorDisplayName: null,
      actorEmail: null,
    }),
  );
  assert.equal(
    unknown.description,
    "Former staff member performed an administrative action.",
  );
  assert.doesNotMatch(unknown.description, /future_admin_action/);
  assert.equal(unknown.systemDetails.action, "future_admin_action");
});

function record(
  overrides: Partial<AdminActivitySourceRecord>,
): AdminActivitySourceRecord {
  return {
    action: "staff_created",
    actorDisplayName: "Dardan",
    actorEmail: "dardan@example.com",
    actorRole: "owner",
    correlationId: null,
    createdAt: new Date("2026-07-29T14:00:00.000Z"),
    domain: "staff",
    id: "activity-id",
    metadata: null,
    outcome: "success",
    reason: null,
    targetId: "4d68f682-90ab-4cdb-8f59-67f7f9414df1",
    targetLabel: "Taylor",
    targetType: "admin_user",
    ...overrides,
  };
}
