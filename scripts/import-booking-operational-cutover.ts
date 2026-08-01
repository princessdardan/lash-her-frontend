import "dotenv/config";

import { createClient } from "@sanity/client";

import type { LegacyOperationalCutoverSource } from "../src/lib/booking/operations/legacy-operational-cutover";
import { closePrivateDbPool } from "../src/lib/private-db/client";
import {
  importLegacyOperationalCutover,
  prepareLegacyOperationalCutover,
} from "../src/lib/private-db/legacy-operational-cutover-repository";
import {
  apiVersion,
  dataset,
  getSanityApiReadToken,
  projectId,
} from "../src/sanity/env";

interface SanityCutoverResult {
  promotions: LegacyOperationalCutoverSource["promotions"];
  services: LegacyOperationalCutoverSource["services"];
  settings: LegacyOperationalCutoverSource["settings"];
}

const QUERY = `{
  "settings": *[
    _type == "bookingSettings"
    && !(_id in path("drafts.**"))
  ] | order(select(_id == "bookingSettings" => 0, 1) asc, _updatedAt desc)[0] {
    "intakeQuestions": coalesce(
      intakeQuestions[]{ id, label, inputType, required, options },
      []
    ),
    marketingOptInLabel
  },
  "promotions": *[
    _type == "promotionCode"
    && !(_id in path("drafts.**"))
  ] | order(code asc) {
    _id,
    title,
    code,
    isEnabled,
    discountType,
    amount,
    appliesTo,
    "serviceIds": coalesce(services[]._ref, [])
  },
  "services": *[
    _type == "service"
    && !(_id in path("drafts.**"))
  ] | order(_id asc) {
    _id,
    title,
    shortDescription,
    description
  }
}`;

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  assertPreCutoverMode(execute);
  if (execute) assertSafeWriteTarget();
  const sanity = createClient({
    apiVersion,
    dataset,
    projectId,
    token: getSanityApiReadToken(),
    useCdn: false,
  });
  const fetched = await sanity.fetch<SanityCutoverResult>(QUERY);
  const source: LegacyOperationalCutoverSource = {
    promotions: fetched.promotions.filter(isServicePromotion),
    services: fetched.services,
    settings: fetched.settings,
  };
  const preparation = await prepareLegacyOperationalCutover({ source });
  const { counts } = preparation.plan;

  console.log("[booking-cutover] Validation plan");
  console.table([
    {
      existingImportedPromotions: preparation.existingImportedPromotionCount,
      intakeQuestions: counts.intakeQuestionCount,
      offeringCopyUpdates: counts.offeringCopyUpdateCount,
      operationalOfferings: counts.targetOfferingCount,
      promotionEligibilityRows: counts.promotionEligibilityCount,
      servicePromotions: counts.promotionCount,
      staleImportedPromotions: preparation.stalePromotionCount,
      uniqueReferencedServices: counts.referencedServiceCount,
    },
  ]);
  if (preparation.plan.promotions.length > 0) {
    console.table(
      preparation.plan.promotions.map((promotion) => ({
        code: promotion.code,
        eligibleOfferings: promotion.offeringIds.length,
        sourceSanityDocumentId: promotion.sourceSanityDocumentId,
        status: promotion.status,
      })),
    );
  }

  if (!execute) {
    console.log(
      "[booking-cutover] Dry run passed. No PostgreSQL rows were changed.",
    );
    console.log(
      "[booking-cutover] Re-run with --execute before setting SERVICE_BOOKING_MODEL_MODE=operational.",
    );
    return;
  }

  const result = await importLegacyOperationalCutover({ source });
  console.table([result]);
  console.log(
    "[booking-cutover] CUTOVER VALIDATION PASSED. Settings and exact offering promotion eligibility are now stored in PostgreSQL.",
  );
}

function isServicePromotion(
  promotion: LegacyOperationalCutoverSource["promotions"][number],
): boolean {
  return (
    promotion.appliesTo === "services" ||
    (promotion.appliesTo === "specificItems" &&
      Array.isArray(promotion.serviceIds) &&
      promotion.serviceIds.length > 0)
  );
}

function assertPreCutoverMode(execute: boolean): void {
  const mode = process.env.SERVICE_BOOKING_MODEL_MODE?.trim().toLowerCase();
  if (mode === "operational") {
    throw new Error(
      "Set SERVICE_BOOKING_MODEL_MODE=dual before validating or importing legacy cutover data",
    );
  }
  if (execute && mode !== "dual") {
    throw new Error(
      "Executing the legacy cutover import requires SERVICE_BOOKING_MODEL_MODE=dual",
    );
  }
}

function assertSafeWriteTarget(): void {
  const databaseUrl = process.env.DATABASE_URL;
  const target = process.env.PRIVATE_DB_MIGRATION_TARGET;
  const expectedHost =
    process.env.PRIVATE_DB_MIGRATION_HOST?.trim().toLowerCase();

  if (!databaseUrl) throw new Error("Missing env var: DATABASE_URL");
  if (target !== "local" && target !== "staging" && target !== "production") {
    throw new Error(
      "Set PRIVATE_DB_MIGRATION_TARGET to local, staging, or production before executing the import.",
    );
  }
  if (!expectedHost) {
    throw new Error(
      "Set PRIVATE_DB_MIGRATION_HOST before executing the import",
    );
  }

  const databaseHost = new URL(databaseUrl).hostname.toLowerCase();
  if (databaseHost !== expectedHost) {
    throw new Error(
      `DATABASE_URL host mismatch: expected ${expectedHost}, received ${databaseHost}.`,
    );
  }
  if (
    target === "production" &&
    process.env.BOOKING_CUTOVER_CONFIRM !== "production"
  ) {
    throw new Error(
      "Production import requires BOOKING_CUTOVER_CONFIRM=production after backup and dry-run review.",
    );
  }
}

main()
  .catch((error: unknown) => {
    console.error(
      "[booking-cutover] Failed",
      error instanceof Error ? error.message : "Unknown error",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePrivateDbPool();
  });
