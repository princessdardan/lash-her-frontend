import "server-only";

import { createHash } from "node:crypto";

import { eq, sql } from "drizzle-orm";

import { closePrivateDbPool, getPrivateDb } from "@/lib/private-db/client";
import {
  adminUsers,
  bookingCalendarConnections,
  bookingProviders,
  bookingResourceCalendarAssignments,
  bookingResources,
  bookingServiceOfferings,
  bookingServices,
  shippingCalendarVersions,
  shippingPackageProfiles,
} from "@/lib/private-db/schema";
import {
  expectedOntarioClosureDates,
  type ShippingCalendarClosure,
} from "@/lib/shipping/calendar-validation";

const OWNER_EMAIL = "commerce-e2e-owner@example.invalid";

// Fixed identifiers for the deterministic "lash-fill" service-booking offering
// the booking E2E specs rely on. Stable UUIDs keep the seed idempotent-by-intent
// on the fresh isolated database each browser run provisions.
const BOOKING_E2E_IDS = {
  resource: "b0000000-0000-4000-8000-000000000001",
  provider: "b0000000-0000-4000-8000-000000000002",
  service: "b0000000-0000-4000-8000-000000000003",
  offering: "b0000000-0000-4000-8000-000000000004",
  calendarConnection: "b0000000-0000-4000-8000-000000000005",
  calendarAssignment: "b0000000-0000-4000-8000-000000000006",
} as const;

async function main(): Promise<void> {
  assertIsolatedFixtureDatabase();
  const now = new Date();
  const attestedAt = new Date(now.getTime() - 60_000);
  const coverageStartsOn = now.toISOString().slice(0, 10);
  const coverageEndsOn = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 22, now.getUTCDate()),
  )
    .toISOString()
    .slice(0, 10);
  const closureDates = buildClosureDates(coverageStartsOn, coverageEndsOn);
  const db = getPrivateDb();

  await db.transaction(async (tx) => {
    const existingOwner = await tx
      .select({ id: adminUsers.id })
      .from(adminUsers)
      .where(eq(adminUsers.email, OWNER_EMAIL))
      .limit(1);
    if (existingOwner.length > 0) {
      throw new Error(
        "Commerce E2E readiness seed requires a fresh isolated database",
      );
    }

    const [owner] = await tx
      .insert(adminUsers)
      .values({
        displayName: "Nataliea Lavoie",
        email: OWNER_EMAIL,
        emailNormalized: OWNER_EMAIL,
        providerUserId: "commerce-e2e-owner",
        role: "owner",
        status: "active",
      })
      .returning({ id: adminUsers.id });

    await tx.insert(shippingPackageProfiles).values([
      {
        acceptsRigid: true,
        enabled: true,
        evidenceReference: "e2e://package/mailer-box-30x22x5-v1",
        heightCm: 5,
        lengthCm: 30,
        maxWeightGrams: 2_000,
        name: "Mailer box 30 × 22 × 5 cm",
        packageType: "parcel",
        rank: 10,
        reviewAction: "approve_shipping_package_profile",
        reviewEvidenceHash: evidenceHash("e2e-package-30x22x5-approval-v1"),
        reviewEvidenceVersion: "e2e-package-approval-v1",
        reviewStepUpAuthenticatedAt: now,
        reviewedAt: now,
        reviewedByAdminUserId: owner.id,
        slug: "mailer-box-30x22x5",
        tareWeightGrams: 90,
        widthCm: 22,
      },
      {
        acceptsRigid: true,
        enabled: true,
        evidenceReference: "e2e://package/mailer-box-36x26x4-v1",
        heightCm: 4,
        lengthCm: 36,
        maxWeightGrams: 3_000,
        name: "Mailer box 36 × 26 × 4 cm",
        packageType: "parcel",
        rank: 20,
        reviewAction: "approve_shipping_package_profile",
        reviewEvidenceHash: evidenceHash("e2e-package-36x26x4-approval-v1"),
        reviewEvidenceVersion: "e2e-package-approval-v1",
        reviewStepUpAuthenticatedAt: now,
        reviewedAt: now,
        reviewedByAdminUserId: owner.id,
        slug: "mailer-box-36x26x4",
        tareWeightGrams: 120,
        widthCm: 26,
      },
    ]);
    await tx.insert(shippingCalendarVersions).values({
      attestedAt,
      attestedByAdminUserId: owner.id,
      closureDates,
      coverageEndsOn,
      coverageStartsOn,
      effectiveAt: attestedAt,
      evidenceReference: "e2e://calendar/22-months-v1",
      status: "effective",
      timezone: "America/Toronto",
      version: "commerce-e2e-calendar-v1",
    });

    // Deterministic public service-booking offering for the "lash-fill" service
    // slug the booking E2E specs exercise (booking flows + service-booking
    // payment page). Without a bookable operational offering the booking page
    // 404s. These rows satisfy the public-offering projection: active
    // service/provider/resource, a provider public slug, an active offering with
    // a positive deposit below full price, and an active calendar assignment that
    // accepts bookings (a non-"primary" calendar id, active connection).
    await tx.insert(bookingResources).values({
      id: BOOKING_E2E_IDS.resource,
      resourceKey: "lash-fill-e2e-resource",
      name: "Lash Fill E2E Provider",
      kind: "provider",
      timezone: "America/Toronto",
      status: "active",
      createdByAdminUserId: owner.id,
    });
    await tx.insert(bookingProviders).values({
      id: BOOKING_E2E_IDS.provider,
      providerKey: "lash-fill-e2e-provider",
      displayName: "Lash Fill E2E Provider",
      primaryResourceId: BOOKING_E2E_IDS.resource,
      publicSlug: "lash-fill-artist",
      status: "active",
      createdByAdminUserId: owner.id,
    });
    await tx.insert(bookingServices).values({
      id: BOOKING_E2E_IDS.service,
      serviceKey: "lash-fill-e2e-service",
      displayTitle: "Lash Fill",
      publicSlug: "lash-fill",
      status: "active",
      createdByAdminUserId: owner.id,
    });
    await tx.insert(bookingServiceOfferings).values({
      id: BOOKING_E2E_IDS.offering,
      offeringKey: "lash-fill-e2e-offering",
      serviceId: BOOKING_E2E_IDS.service,
      providerId: BOOKING_E2E_IDS.provider,
      primaryResourceId: BOOKING_E2E_IDS.resource,
      status: "active",
      bookingType: "in-person-appointment",
      currency: "CAD",
      durationMinutes: 90,
      slotIntervalMinutes: 15,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      fullPriceCents: 13_000,
      depositAmountCents: 5_000,
      publicTitle: "Lash Fill",
      version: 1,
      createdByAdminUserId: owner.id,
    });
    await tx.insert(bookingCalendarConnections).values({
      id: BOOKING_E2E_IDS.calendarConnection,
      provider: "google",
      accountEmail: "lash-fill-e2e@example.invalid",
      credentialSecretRef: "e2e://booking-calendar/lash-fill-v1",
      status: "active",
    });
    await tx.insert(bookingResourceCalendarAssignments).values({
      id: BOOKING_E2E_IDS.calendarAssignment,
      resourceId: BOOKING_E2E_IDS.resource,
      calendarConnectionId: BOOKING_E2E_IDS.calendarConnection,
      providerCalendarId: "e2e-lash-fill-calendar",
      calendarLabel: "Lash Fill E2E Calendar",
      contributesBusy: true,
      acceptsBookings: true,
      status: "active",
      createdByAdminUserId: owner.id,
    });
  });

  await db.execute(sql`select 1`);
  await closePrivateDbPool();
  console.info("[commerce-e2e] Seeded enabled checkout readiness fixtures");
}

function evidenceHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function buildClosureDates(
  coverageStartsOn: string,
  coverageEndsOn: string,
): ShippingCalendarClosure[] {
  const startYear = Number(coverageStartsOn.slice(0, 4));
  const endYear = Number(coverageEndsOn.slice(0, 4));
  return Array.from(
    { length: endYear - startYear + 1 },
    (_, index) => startYear + index,
  )
    .flatMap((year) => [...expectedOntarioClosureDates(year)])
    .filter((date) => date >= coverageStartsOn && date <= coverageEndsOn)
    .sort()
    .map((date) => ({
      date,
      kind: "ontario_holiday",
      label: `Ontario statutory/observed closure ${date}`,
    }));
}

function assertIsolatedFixtureDatabase(): void {
  const databaseUrl = process.env.DATABASE_URL;
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  if (
    process.env.COMMERCE_E2E_ENABLED_MODE !== "1" ||
    process.env.COMMERCE_E2E_ISOLATED_TEST_DATABASE !== "1" ||
    process.env.VERCEL_ENV === "production" ||
    process.env.NEXT_PUBLIC_SANITY_DATASET === "production" ||
    !databaseUrl ||
    !testDatabaseUrl ||
    databaseIdentity(databaseUrl) !== databaseIdentity(testDatabaseUrl)
  ) {
    throw new Error(
      "Commerce enabled E2E seed requires the explicit isolated non-production test database",
    );
  }
}

function databaseIdentity(value: string): string {
  const url = new URL(value);
  return `${url.protocol}//${url.username}@${url.hostname}:${url.port}${url.pathname}`;
}

void main().catch(async (error) => {
  await closePrivateDbPool().catch(() => undefined);
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
