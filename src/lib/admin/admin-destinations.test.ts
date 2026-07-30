import assert from "node:assert/strict";
import test from "node:test";

import { getVisibleAdminDestinations } from "./admin-destinations";
import type { AdminActor, AdminRole } from "./types";

function createActor(
  role: AdminRole,
  {
    bookingProviderResourceIds = [],
    bookingResourceIds = [],
  }: {
    bookingProviderResourceIds?: string[];
    bookingResourceIds?: string[];
  } = {},
): AdminActor {
  return {
    bookingProviderResourceIds,
    bookingResourceIds,
    user: {
      displayName: "Admin User",
      email: "admin@example.com",
      emailNormalized: "admin@example.com",
      id: "admin-user",
      providerUserId: "provider-user",
      role,
      status: "active",
    },
  };
}

function navigationLabels(actor: AdminActor): string[] {
  return getVisibleAdminDestinations(actor)
    .filter((destination) => destination.navigation)
    .map((destination) => destination.label);
}

test("employee destinations stay within assigned-resource permissions", () => {
  const destinations = getVisibleAdminDestinations(
    createActor("employee", {
      bookingProviderResourceIds: ["provider-resource"],
      bookingResourceIds: ["provider-resource"],
    }),
  );

  assert.deepEqual(
    destinations
      .filter((destination) => destination.navigation)
      .map((destination) => destination.label),
    [
      "Today",
      "Appointments",
      "My availability",
      "Availability",
      "Services & pricing",
    ],
  );
  assert.equal(
    destinations.some((destination) => destination.group === "Settings"),
    false,
  );
  assert.equal(
    destinations.some(
      (destination) => destination.label === "Time off and extra hours",
    ),
    true,
  );
});

test("employees without assigned resources only see the dashboard", () => {
  assert.deepEqual(navigationLabels(createActor("employee")), ["Today"]);
});

test("administrator search excludes owner-only and employee-only destinations", () => {
  const destinations = getVisibleAdminDestinations(createActor("admin"));
  const labels = destinations.map((destination) => destination.label);

  assert.equal(labels.includes("Booking settings"), true);
  assert.equal(labels.includes("Google Calendar connections"), true);
  assert.equal(labels.includes("Team"), true);
  assert.equal(labels.includes("Activity history"), false);
  assert.equal(labels.includes("My availability"), false);
  assert.equal(labels.includes("Busy calendars"), false);
  assert.equal(labels.includes("Square sales matching"), false);
  assert.equal(
    destinations.find(
      (destination) => destination.label === "Square integration",
    )?.href,
    "/admin/integrations",
  );
});

test("owner search includes the activity history destination", () => {
  const destinations = getVisibleAdminDestinations(createActor("owner"));
  const activity = destinations.find(
    (destination) => destination.label === "Activity history",
  );

  assert.equal(activity?.href, "/admin/audit");
  assert.equal(activity?.navigation, true);
});

test("curated settings and subsection results use existing deep links", () => {
  const destinations = getVisibleAdminDestinations(createActor("owner"));

  assert.deepEqual(
    destinations.find(
      (destination) => destination.label === "Client intake questions",
    ),
    {
      activePaths: undefined,
      description: "Edit the questions clients answer while booking.",
      group: "Settings",
      href: "/admin/booking-settings",
      keywords: ["booking form", "client questions", "intake form"],
      label: "Client intake questions",
      navigation: false,
    },
  );
  assert.equal(
    destinations.find(
      (destination) => destination.label === "Time off and extra hours",
    )?.href,
    "/admin/schedules?tab=exceptions#time-off",
  );
  assert.equal(
    destinations.find(
      (destination) => destination.label === "Square sales matching",
    )?.href,
    "/admin/staff?tab=square",
  );
});
