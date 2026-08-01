import assert from "node:assert/strict";
import test from "node:test";

import { getOfferingActivationBlockers } from "./offering-readiness";

const readyConfiguration = {
  activeAddOnsArePubliclyValid: true,
  hasActiveBookingCalendar: true,
  hasActiveWeeklySchedule: true,
  offering: {
    publicSummary: "A complete classic lash service.",
    publicTitle: "Classic lash set",
  },
  provider: {
    displayName: "Nataliea",
    primaryResourceId: "resource-1",
    publicSlug: "nataliea",
    status: "active" as const,
  },
  resource: {
    id: "resource-1",
    status: "active" as const,
  },
  requiredSecondaryResources: [],
  service: {
    publicSlug: "classic-lash-set",
    sanityDocumentId: "service-1",
    status: "active" as const,
  },
};

test("an offering is activatable only when its public booking dependencies are ready", () => {
  assert.deepEqual(getOfferingActivationBlockers(readyConfiguration), []);
});

test("offering activation reports every missing setup dependency", () => {
  const blockers = getOfferingActivationBlockers({
    ...readyConfiguration,
    activeAddOnsArePubliclyValid: false,
    hasActiveBookingCalendar: false,
    hasActiveWeeklySchedule: false,
    offering: {
      publicSummary: null,
      publicTitle: null,
    },
    provider: {
      ...readyConfiguration.provider,
      publicSlug: null,
      status: "draft",
    },
    resource: {
      id: "resource-2",
      status: "draft",
    },
    requiredSecondaryResources: [
      {
        hasActiveWeeklySchedule: false,
        name: "Treatment room",
        status: "draft",
      },
    ],
    service: {
      publicSlug: null,
      sanityDocumentId: null,
      status: "draft",
    },
  });

  assert.deepEqual(blockers, [
    "activate the provider",
    "link the provider public slug",
    "add the public offering title",
    "add the public offering summary",
    "activate the primary resource",
    "repair the provider primary-resource link",
    "activate the service",
    "link the service public slug",
    "add an active weekly schedule",
    "assign an active booking calendar",
    "activate required resource Treatment room",
    "add an active weekly schedule for required resource Treatment room",
    "complete every active add-on name, key, description, price, and duration",
  ]);
});
