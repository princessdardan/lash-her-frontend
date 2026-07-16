import "dotenv/config";

import { createClient } from "@sanity/client";

import {
  buildLegacyBookingImportPlan,
  type LegacyBookingImportService,
  type LegacyBookingImportSettings,
} from "../src/lib/booking/operations/legacy-import-plan";
import { importLegacyBookingConfiguration } from "../src/lib/private-db/booking-legacy-import-repository";
import { closePrivateDbPool } from "../src/lib/private-db/client";
import { apiVersion, dataset, projectId } from "../src/sanity/env";

interface SanityBootstrapResult {
  services: Array<{
    _id: string;
    addOns?: Array<{
      _key: string;
      description?: string;
      name: string;
      price: number;
    }>;
    currency?: string;
    depositAmount: number;
    durationMinutes: number;
    fullPrice: number;
    slug: string;
    title: string;
  }>;
  settings: LegacyBookingImportSettings | null;
}

const QUERY = `{
  "services": *[
    _type == "service"
    && !(_id in path("drafts.**"))
    && isAvailable == true
    && defined(slug.current)
    && fullPrice > 0
    && depositAmount > 0
    && depositAmount < fullPrice
  ] | order(displayOrder asc, title asc) {
    _id,
    title,
    "slug": slug.current,
    durationMinutes,
    fullPrice,
    depositAmount,
    currency,
    addOns[]{ _key, name, description, price }
  },
  "settings": *[
    _type == "bookingSettings"
    && !(_id in path("drafts.**"))
  ] | order(select(_id == "bookingSettings" => 0, 1) asc, _updatedAt desc)[0] {
    calendarId,
    bookingHorizonDays,
    minimumLeadTimeHours,
    timezone,
    bufferMinutes,
    slotIntervalMinutes,
    hoursOfOperation[]{ day, isOpen, opensAt, closesAt }
  }
}`;

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const providerName = readArgument("--provider-name") ?? "Nataliea";
  const providerSlug = readArgument("--provider-slug") ?? "nataliea";
  const effectiveFrom =
    readArgument("--effective-from") ?? currentTorontoDate();
  const sanity = createClient({
    apiVersion,
    dataset,
    projectId,
    token: process.env.SANITY_API_READ_TOKEN,
    useCdn: false,
  });
  const source = await sanity.fetch<SanityBootstrapResult>(QUERY);

  if (!source.settings) {
    throw new Error("Published Sanity booking settings were not found");
  }

  const services = source.services.map(toLegacyService);
  const plan = buildLegacyBookingImportPlan({
    effectiveFrom,
    providerName,
    providerSlug,
    services,
    settings: source.settings,
  });

  console.log(
    `[booking-bootstrap] Prepared ${plan.offerings.length} offering record(s) for ${plan.provider.displayName}; new records will be staged as draft.`,
  );
  console.table(
    plan.offerings.map((offering) => ({
      addOns: offering.addOns.length,
      deposit: formatCad(offering.depositAmountCents),
      durationMinutes: offering.durationMinutes,
      fullPrice: formatCad(offering.fullPriceCents),
      offeringKey: offering.offeringKey,
      service: offering.service.displayTitle,
    })),
  );
  console.log(
    `[booking-bootstrap] Prepared ${plan.schedules.length} weekly schedule window(s), effective ${effectiveFrom}`,
  );
  for (const warning of plan.warnings) {
    console.warn(`[booking-bootstrap] ${warning}`);
  }

  if (!execute) {
    console.log(
      "[booking-bootstrap] Dry run only. Re-run with --execute after reviewing the plan.",
    );
    return;
  }

  assertSafeWriteTarget();
  const result = await importLegacyBookingConfiguration({ plan });
  console.log(
    `[booking-bootstrap] Staged ${result.serviceCount} service(s), ${result.offeringCount} offering(s), and ${result.scheduleCount} new schedule window(s).`,
  );
  console.log(
    "[booking-bootstrap] New records remain draft and existing activation is preserved. Connect a canonical provider calendar and activate new records from /admin/setup.",
  );
}

function toLegacyService(
  service: SanityBootstrapResult["services"][number],
): LegacyBookingImportService {
  if (service.currency && service.currency !== "CAD") {
    throw new Error(`${service.title} must use CAD before it can be imported`);
  }

  return {
    addOns: service.addOns?.map((addOn) => ({
      description: addOn.description,
      key: addOn._key,
      name: addOn.name,
      priceCad: addOn.price,
    })),
    depositCad: service.depositAmount,
    durationMinutes: service.durationMinutes,
    fullPriceCad: service.fullPrice,
    sanityDocumentId: service._id,
    slug: service.slug,
    title: service.title,
  };
}

function readArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function assertSafeWriteTarget(): void {
  const databaseUrl = process.env.DATABASE_URL;
  const target = process.env.PRIVATE_DB_MIGRATION_TARGET;
  const expectedHost = process.env.PRIVATE_DB_MIGRATION_HOST?.trim().toLowerCase();

  if (!databaseUrl) throw new Error("Missing env var: DATABASE_URL");
  if (target !== "local" && target !== "staging" && target !== "production") {
    throw new Error(
      "Set PRIVATE_DB_MIGRATION_TARGET to local, staging, or production before executing the import.",
    );
  }
  if (!expectedHost) {
    throw new Error("Set PRIVATE_DB_MIGRATION_HOST before executing the import");
  }

  const databaseHost = new URL(databaseUrl).hostname.toLowerCase();
  if (databaseHost !== expectedHost) {
    throw new Error(
      `DATABASE_URL host mismatch: expected ${expectedHost}, received ${databaseHost}.`,
    );
  }
  if (
    target === "production" &&
    process.env.BOOKING_BOOTSTRAP_CONFIRM !== "production"
  ) {
    throw new Error(
      "Production import requires BOOKING_BOOTSTRAP_CONFIRM=production after backup and review.",
    );
  }
}

function currentTorontoDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "America/Toronto",
    year: "numeric",
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value;

  return `${part("year")}-${part("month")}-${part("day")}`;
}

function formatCad(cents: number): string {
  return new Intl.NumberFormat("en-CA", {
    currency: "CAD",
    style: "currency",
  }).format(cents / 100);
}

main()
  .catch((error: unknown) => {
    console.error(
      "[booking-bootstrap] Failed",
      error instanceof Error ? error.message : "Unknown error",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePrivateDbPool();
  });
