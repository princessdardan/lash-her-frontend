import "server-only";

import { createHash } from "node:crypto";

import { eq, sql } from "drizzle-orm";

import {
  COMMERCE_E2E_FDA_REQUIREMENTS_VERSION,
  COMMERCE_E2E_TARIFF_SCHEMA_VERSION,
  COMMERCE_E2E_US_CONTRACT_VERSION,
} from "@/data/commerce-e2e-catalog-fixture";
import { closePrivateDbPool, getPrivateDb } from "@/lib/private-db/client";
import {
  adminUsers,
  fulfillmentPolicyVersions,
  fulfillmentProviderCertifications,
  shippingCalendarVersions,
  shippingPackageProfiles,
  shippingPolicySettings,
} from "@/lib/private-db/schema";
import {
  expectedOntarioClosureDates,
  type ShippingCalendarClosure,
} from "@/lib/shipping/calendar-validation";
import { COMMERCE_E2E_HELCIM_CONTRACT } from "../tests/support/commerce-e2e-config";

const OWNER_EMAIL = "commerce-e2e-owner@example.invalid";
const POLICY_VERSION = "commerce-e2e-owner-policy-v1";
const US_POSTAGE_TYPE = "chit_chats_us_edge";

async function main(): Promise<void> {
  assertIsolatedFixtureDatabase();
  const now = new Date();
  const attestedAt = new Date(now.getTime() - 60_000);
  const certifiedAt = new Date(COMMERCE_E2E_HELCIM_CONTRACT.effectiveFrom);
  const usContractValidUntil = new Date(
    COMMERCE_E2E_HELCIM_CONTRACT.effectiveUntil,
  );
  if (now >= usContractValidUntil) {
    throw new Error("Commerce E2E U.S. certification fixture has expired");
  }
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

    await tx.insert(fulfillmentPolicyVersions).values({
      attestationEvidenceReference: "e2e://policy/owner-only-v1",
      attestedByAdminUserId: owner.id,
      effectiveAt: attestedAt,
      operationsAttestedAt: attestedAt,
      ownerName: "Nataliea Lavoie",
      policySnapshot: {
        ownerOnlyReview: true,
        fixture: true,
        p10TerminationNoticeDays: 350,
        p10DefaultExecutionDays: 360,
        p10HardCapDays: 365,
        p10ExecutionRationale:
          "five-day provider execution and reconciliation buffer before unconditional PII redaction",
      },
      privacyLegalAttestedAt: attestedAt,
      securityAttestedAt: attestedAt,
      status: "effective",
      version: POLICY_VERSION,
    });
    await tx
      .update(shippingPolicySettings)
      .set({ policyVersion: POLICY_VERSION, updatedAt: now })
      .where(eq(shippingPolicySettings.singletonKey, "default"));
    await tx.insert(shippingPackageProfiles).values({
      capacityUnits: 4,
      enabled: true,
      evidenceReference: "e2e://package/small-v1",
      heightCm: 6,
      lengthCm: 25,
      maxWeightGrams: 2_000,
      name: "E2E small parcel",
      packageType: "parcel",
      rank: 1,
      reviewAction: "approve_shipping_package_profile",
      reviewEvidenceHash: evidenceHash("e2e-package-small-approval-v1"),
      reviewEvidenceVersion: "e2e-package-approval-v1",
      reviewStepUpAuthenticatedAt: now,
      reviewedAt: now,
      reviewedByAdminUserId: owner.id,
      slug: "small",
      tareWeightGrams: 40,
      widthCm: 18,
    });
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

    await tx.insert(fulfillmentProviderCertifications).values([
      {
        certifiedAt,
        certificationAction: "certify_fulfillment_provider",
        certificationEvidenceHash: evidenceHash("e2e-helcim-certification-v1"),
        certificationEvidenceVersion: "e2e-provider-certification-v1",
        certificationStepUpAuthenticatedAt: certifiedAt,
        certifiedByAdminUserId: owner.id,
        certifiedByOwnerName: "Nataliea Lavoie",
        contractSnapshot: COMMERCE_E2E_HELCIM_CONTRACT,
        environment: "staging",
        evidenceReference: COMMERCE_E2E_HELCIM_CONTRACT.evidenceReference,
        provider: "helcim",
        scope: "product_payments",
        validUntil: usContractValidUntil,
        version: COMMERCE_E2E_HELCIM_CONTRACT.version,
      },
      {
        certifiedAt,
        certificationAction: "certify_fulfillment_provider",
        certificationEvidenceHash: evidenceHash(
          "e2e-chitchats-canada-certification-v1",
        ),
        certificationEvidenceVersion: "e2e-provider-certification-v1",
        certificationStepUpAuthenticatedAt: certifiedAt,
        certifiedByAdminUserId: owner.id,
        certifiedByOwnerName: "Nataliea Lavoie",
        environment: "staging",
        evidenceReference: "e2e://chitchats/canada-v1",
        provider: "chitchats",
        scope: "canada",
        validUntil: usContractValidUntil,
        version: "commerce-e2e-chitchats-canada-v1",
      },
      {
        certifiedAt,
        certificationAction: "certify_fulfillment_provider",
        certificationEvidenceHash: evidenceHash(
          "e2e-chitchats-us-certification-v1",
        ),
        certificationEvidenceVersion: "e2e-provider-certification-v1",
        certificationStepUpAuthenticatedAt: certifiedAt,
        certifiedByAdminUserId: owner.id,
        certifiedByOwnerName: "Nataliea Lavoie",
        contractSnapshot: {
          allowedServiceCodes: [US_POSTAGE_TYPE],
          disclosure: {
            text: "U.S. orders ship DDU. Duties, taxes, and brokerage may be collected from the recipient on delivery.",
            version: "commerce-e2e-ddu-notice-v1",
          },
          effectiveFrom: certifiedAt.toISOString(),
          effectiveUntil: usContractValidUntil.toISOString(),
          evidenceReference: "e2e://chitchats/us-contract-v1",
          fdaRequirements: {
            mode: "required_when_applicable",
            version: COMMERCE_E2E_FDA_REQUIREMENTS_VERSION,
          },
          importTerms: "DDU",
          insuredRequired: true,
          tariffMetadataSchema: {
            additionalTariffDetails: "required_when_applicable",
            fields: ["steel", "copper", "aluminum"],
            version: COMMERCE_E2E_TARIFF_SCHEMA_VERSION,
          },
          trackedRequired: true,
          version: COMMERCE_E2E_US_CONTRACT_VERSION,
        },
        environment: "staging",
        evidenceReference: "e2e://chitchats/us-contract-v1",
        provider: "chitchats",
        scope: "us_shipping_contract",
        validUntil: usContractValidUntil,
        version: COMMERCE_E2E_US_CONTRACT_VERSION,
      },
    ]);
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
