import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { OperationalBookingConfigurationRepository } from "@/lib/private-db/booking-configuration-repository";

import type { OperationalBookingOffering } from "./offering";
import {
  loadPublicBookingCatalog,
  loadPublicOperationalOfferings,
} from "./public-offerings";

test("public offering loader returns only the browser-safe projection", async () => {
  const repository = createRepository([createOffering()]);

  const offerings = await loadPublicOperationalOfferings({
    now: new Date("2030-06-01T00:00:00.000Z"),
    repository,
  });

  assert.deepEqual(offerings, [
    {
      addOns: [
        {
          description: "Extended lash bath",
          durationDeltaMinutes: 15,
          key: "lash-bath",
          name: "Lash bath",
          priceCents: 1500,
        },
      ],
      depositAmountCents: 5000,
      displayOrder: 2,
      durationMinutes: 60,
      fullPriceCents: 15000,
      hasEditorialDetail: false,
      id: "00000000-0000-4000-8000-000000000001",
      offeringKey: "classic-fill-nataliea",
      provider: {
        displayName: "Nataliea",
        providerKey: "nataliea",
        publicSlug: "nataliea",
      },
      publicSummary: "A provider-specific classic fill.",
      publicTitle: "Nataliea's Classic Fill",
      serviceSlug: "classic-fill",
      serviceTitle: "Classic Fill",
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(offerings),
    /assignment-private|calendar-private|connection-private|provider-private|resource-private|service-private/,
  );
});

test("public offering loader leaves V1 active only when there is no V2 intent", async () => {
  assert.equal(
    await loadPublicOperationalOfferings({ repository: createRepository([]) }),
    undefined,
  );

  const invalid = createOffering();
  invalid.service.publicSlug = undefined;
  assert.deepEqual(
    await loadPublicOperationalOfferings({
      repository: createRepository([invalid], true),
    }),
    [],
  );
});

test("public slug resolves operational offerings independently of their Sanity link", async () => {
  const staleLinkOffering = createOffering();
  staleLinkOffering.service.sanityDocumentId = "stale-sanity-id";
  const repository = createRepository(
    [staleLinkOffering],
    new Set(["classic-fill"]),
  );

  assert.equal(
    await loadPublicOperationalOfferings({
      repository,
      sanityServiceId: "published-sanity-id",
      servicePublicSlug: "classic-fill",
    }).then((offerings) => offerings?.[0]?.offeringKey),
    "classic-fill-nataliea",
  );
  assert.equal(
    await loadPublicOperationalOfferings({
      repository: createRepository([]),
      sanityServiceId: "true-legacy-id",
      servicePublicSlug: "true-legacy",
    }),
    undefined,
  );

  const globalCatalog = await loadPublicBookingCatalog({
    mode: "dual",
    repository,
    services: [createService("published-sanity-id", "classic-fill")],
  });
  assert.deepEqual(
    globalCatalog.services.map((service) => service.slug),
    ["classic-fill"],
  );
  assert.deepEqual(
    globalCatalog.offerings?.map((offering) => offering.offeringKey),
    ["classic-fill-nataliea"],
  );
  assert.deepEqual(globalCatalog.serviceBookingModels, {
    "classic-fill": "operational",
  });
});

test("operational cutover shows configured-unavailable instead of V1", async () => {
  assert.deepEqual(
    await loadPublicOperationalOfferings({
      mode: "operational",
      repository: createRepository([]),
    }),
    [],
  );
});

test("operational read failures propagate instead of silently selecting V1", async () => {
  const repository = createRepository([]);
  repository.listActiveOfferings = async () => {
    throw new Error("database unavailable");
  };

  await assert.rejects(
    loadPublicOperationalOfferings({ repository }),
    /database unavailable/,
  );
});

test("dual-mode global catalog keeps ready V2 and true V1 paths but hides unhealthy migrated services", async () => {
  const operationalOffering = createOffering();
  operationalOffering.service.sanityDocumentId = "sanity-classic-fill";
  const services = [
    createService("sanity-classic-fill", "classic-fill"),
    createService("sanity-volume-fill", "volume-fill"),
    createService("sanity-hybrid-fill", "hybrid-fill"),
  ];
  const repository = createRepository(
    [operationalOffering],
    new Set(["sanity-classic-fill", "sanity-hybrid-fill"]),
  );

  const catalog = await loadPublicBookingCatalog({
    mode: "dual",
    now: new Date("2030-06-01T00:00:00.000Z"),
    repository,
    services,
  });

  assert.deepEqual(
    catalog.services.map((service) => service.slug),
    ["classic-fill", "volume-fill"],
  );
  assert.deepEqual(catalog.serviceBookingModels, {
    "classic-fill": "operational",
    "volume-fill": "legacy",
  });
  assert.deepEqual(
    catalog.offerings?.map((offering) => offering.offeringKey),
    ["classic-fill-nataliea"],
  );
});

test("canonical booking pages resolve operational offerings without a Sanity catalog read", () => {
  const bookingPage = readFileSync(
    new URL("../../../app/(site)/booking/page.tsx", import.meta.url),
    "utf8",
  );
  const serviceBookingPage = readFileSync(
    new URL(
      "../../../app/(site)/services/[slug]/booking/page.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(bookingPage, /loadPublicOperationalOfferings\(\{/);
  assert.match(bookingPage, /mode: "operational"/);
  assert.match(bookingPage, /servicePublicSlug: slug/);
  assert.match(bookingPage, /permanentRedirect\(resolution\.href\)/);
  assert.doesNotMatch(bookingPage, /getBookableServiceBySlug|loaders\./);
  assert.match(
    serviceBookingPage,
    /loadPublicOperationalOfferings\(\{\s*mode: "operational",\s*servicePublicSlug: slug,\s*\}\)/,
  );
  assert.match(serviceBookingPage, /offerings=\{offerings\}/);
  assert.match(serviceBookingPage, /loadOperationalBookingUiSettings\(\)/);
  assert.doesNotMatch(serviceBookingPage, /getBookingSettings|loaders\./);
  assert.match(serviceBookingPage, /export const dynamic = "force-dynamic"/);
  assert.match(serviceBookingPage, /export const revalidate = 0/);
});

function createRepository(
  offerings: OperationalBookingOffering[],
  hasActiveOfferingIntent: boolean | ReadonlySet<string> = false,
): OperationalBookingConfigurationRepository {
  return {
    findActiveOfferingById: async ({ id }) =>
      offerings.find((offering) => offering.id === id) ?? null,
    hasActiveOfferingIntent: async ({ sanityServiceId, servicePublicSlug }) =>
      typeof hasActiveOfferingIntent === "boolean"
        ? hasActiveOfferingIntent
        : sanityServiceId === undefined && servicePublicSlug === undefined
          ? hasActiveOfferingIntent.size > 0
          : (sanityServiceId !== undefined &&
              hasActiveOfferingIntent.has(sanityServiceId)) ||
            (servicePublicSlug !== undefined &&
              hasActiveOfferingIntent.has(servicePublicSlug)),
    listActiveOfferings: async () => offerings,
    listActiveOfferingsBySanityServiceId: async ({
      sanityServiceId,
      servicePublicSlug,
    }) =>
      offerings.filter(
        (offering) =>
          offering.service.sanityDocumentId === sanityServiceId &&
          (servicePublicSlug === undefined ||
            offering.service.publicSlug === servicePublicSlug),
      ),
  };
}

function createService(id: string, slug: string) {
  return {
    _id: id,
    currency: "CAD" as const,
    depositAmount: 50,
    description: `${slug} description`,
    durationMinutes: 60,
    fullPrice: 150,
    isAvailable: true,
    showDetailPage: true,
    slug,
    title: slug,
  };
}

function createOffering(): OperationalBookingOffering {
  return {
    addOns: [
      {
        description: "Extended lash bath",
        durationDeltaMinutes: 15,
        key: "lash-bath",
        name: "Lash bath",
        priceCents: 1500,
        status: "active",
      },
    ],
    bookingType: "in-person-appointment",
    bufferAfterMinutes: 15,
    bufferBeforeMinutes: 15,
    calendar: {
      assignmentId: "assignment-private",
      calendarId: "calendar-private",
      connectionId: "connection-private",
    },
    currency: "CAD",
    depositAmountCents: 5000,
    displayOrder: 2,
    durationMinutes: 60,
    fullPriceCents: 15000,
    horizonDays: 30,
    id: "00000000-0000-4000-8000-000000000001",
    minimumLeadTimeHours: 24,
    offeringKey: "classic-fill-nataliea",
    publicSummary: "A provider-specific classic fill.",
    publicTitle: "Nataliea's Classic Fill",
    provider: {
      displayName: "Nataliea",
      id: "provider-private",
      providerKey: "nataliea",
      publicSlug: "nataliea",
      status: "active",
    },
    resource: {
      id: "resource-private",
      name: "Nataliea",
      resourceKey: "nataliea",
      status: "active",
      timezone: "America/Toronto",
    },
    service: {
      displayTitle: "Classic Fill",
      id: "service-private",
      publicSlug: "classic-fill",
      serviceKey: "classic-fill",
      status: "active",
    },
    slotIntervalMinutes: 15,
    status: "active",
    version: 1,
  };
}
