import "server-only";

import { and, eq, inArray, ne, sql } from "drizzle-orm";

import {
  buildLegacyOperationalCutoverPlan,
  validateLegacyOperationalPromotionLineage,
  type LegacyOperationalCutoverPlan,
  type LegacyOperationalCutoverSource,
} from "@/lib/booking/operations/legacy-operational-cutover";

import { getPrivateDb } from "./client";
import {
  bookingBusinessSettings,
  bookingProviders,
  bookingServices,
  bookingServiceOfferings,
  bookingServicePromotionCodes,
  bookingServicePromotionOfferings,
} from "./schema";

type PrivateDb = ReturnType<typeof getPrivateDb>;
type PrivateDbTransaction = Parameters<
  Parameters<PrivateDb["transaction"]>[0]
>[0];

export interface LegacyOperationalCutoverPreparation {
  existingImportedPromotionCount: number;
  plan: LegacyOperationalCutoverPlan;
  stalePromotionCount: number;
}

export interface LegacyOperationalCutoverImportResult {
  intakeQuestionCount: number;
  offeringCopyUpdateCount: number;
  promotionEligibilityCount: number;
  promotionUpsertCount: number;
  stalePromotionDisableCount: number;
}

/**
 * Performs the same locked validation used by execute, without writing.
 */
export async function prepareLegacyOperationalCutover(input: {
  db?: PrivateDb;
  source: LegacyOperationalCutoverSource;
}): Promise<LegacyOperationalCutoverPreparation> {
  const db = input.db ?? getPrivateDb();
  return db.transaction(async (tx) => {
    await lockCutover(tx);
    return prepareWithinTransaction(tx, input.source);
  });
}

/**
 * Atomically imports legacy UI settings and service-promotion eligibility.
 * Every mapping and ownership collision is validated before the first write.
 */
export async function importLegacyOperationalCutover(input: {
  db?: PrivateDb;
  source: LegacyOperationalCutoverSource;
}): Promise<LegacyOperationalCutoverImportResult> {
  const db = input.db ?? getPrivateDb();
  return db.transaction(async (tx) => {
    await lockCutover(tx);
    const preparation = await prepareWithinTransaction(tx, input.source);
    const { plan } = preparation;
    const now = new Date();

    await tx
      .insert(bookingBusinessSettings)
      .values({
        intakeQuestions: plan.settings.intakeQuestions,
        marketingOptInLabel: plan.settings.marketingOptInLabel,
        singletonKey: "default",
      })
      .onConflictDoUpdate({
        target: bookingBusinessSettings.singletonKey,
        set: {
          intakeQuestions: plan.settings.intakeQuestions,
          marketingOptInLabel: plan.settings.marketingOptInLabel,
          updatedAt: now,
          version: sql`${bookingBusinessSettings.version} + 1`,
        },
      });

    for (const copy of plan.offeringCopyUpdates) {
      const copyUpdate = {
        ...(copy.publicSummary !== undefined
          ? { publicSummary: copy.publicSummary }
          : {}),
        ...(copy.publicTitle !== undefined
          ? { publicTitle: copy.publicTitle }
          : {}),
        updatedAt: now,
      };
      await tx
        .update(bookingServiceOfferings)
        .set(copyUpdate)
        .where(eq(bookingServiceOfferings.id, copy.offeringId));
    }

    const stalePromotionIds = preparation.stalePromotionIds;

    if (stalePromotionIds.length > 0) {
      await tx
        .update(bookingServicePromotionCodes)
        .set({ status: "disabled", updatedAt: now })
        .where(inArray(bookingServicePromotionCodes.id, stalePromotionIds));
      await tx
        .delete(bookingServicePromotionOfferings)
        .where(
          inArray(
            bookingServicePromotionOfferings.promotionCodeId,
            stalePromotionIds,
          ),
        );
    }

    for (const promotion of plan.promotions) {
      const [persisted] = await tx
        .insert(bookingServicePromotionCodes)
        .values({
          code: promotion.code,
          discountType: promotion.discountType,
          discountValue: promotion.discountValue,
          internalTitle: promotion.internalTitle,
          sourceSanityDocumentId: promotion.sourceSanityDocumentId,
          status: promotion.status,
        })
        .onConflictDoUpdate({
          target: bookingServicePromotionCodes.sourceSanityDocumentId,
          set: {
            code: promotion.code,
            discountType: promotion.discountType,
            discountValue: promotion.discountValue,
            internalTitle: promotion.internalTitle,
            status: promotion.status,
            updatedAt: now,
          },
        })
        .returning({ id: bookingServicePromotionCodes.id });

      if (!persisted) {
        throw new Error(`Service promotion ${promotion.code} was not imported`);
      }

      await tx
        .delete(bookingServicePromotionOfferings)
        .where(
          eq(bookingServicePromotionOfferings.promotionCodeId, persisted.id),
        );
      await tx.insert(bookingServicePromotionOfferings).values(
        promotion.offeringIds.map((offeringId) => ({
          offeringId,
          promotionCodeId: persisted.id,
        })),
      );
    }

    return {
      intakeQuestionCount: plan.counts.intakeQuestionCount,
      offeringCopyUpdateCount: plan.counts.offeringCopyUpdateCount,
      promotionEligibilityCount: plan.counts.promotionEligibilityCount,
      promotionUpsertCount: plan.counts.promotionCount,
      stalePromotionDisableCount: preparation.stalePromotionCount,
    };
  });
}

async function prepareWithinTransaction(
  tx: PrivateDbTransaction,
  source: LegacyOperationalCutoverSource,
): Promise<
  LegacyOperationalCutoverPreparation & {
    stalePromotionIds: string[];
  }
> {
  const [offerings, existingPromotions] = await Promise.all([
    tx
      .select({
        id: bookingServiceOfferings.id,
        offeringKey: bookingServiceOfferings.offeringKey,
        providerDisplayName: bookingProviders.displayName,
        publicSummary: bookingServiceOfferings.publicSummary,
        publicSummaryProvenance:
          bookingServiceOfferings.publicSummaryProvenance,
        publicTitle: bookingServiceOfferings.publicTitle,
        publicTitleProvenance: bookingServiceOfferings.publicTitleProvenance,
        serviceId: bookingServices.id,
        serviceDisplayTitle: bookingServices.displayTitle,
        serviceSanityDocumentId: bookingServices.sanityDocumentId,
      })
      .from(bookingServiceOfferings)
      .innerJoin(
        bookingServices,
        eq(bookingServices.id, bookingServiceOfferings.serviceId),
      )
      .innerJoin(
        bookingProviders,
        eq(bookingProviders.id, bookingServiceOfferings.providerId),
      )
      .where(
        and(
          ne(bookingServiceOfferings.status, "archived"),
          ne(bookingServices.status, "archived"),
        ),
      )
      .for("update", { of: bookingServiceOfferings }),
    tx
      .select({
        code: bookingServicePromotionCodes.code,
        id: bookingServicePromotionCodes.id,
        sourceSanityDocumentId:
          bookingServicePromotionCodes.sourceSanityDocumentId,
      })
      .from(bookingServicePromotionCodes),
  ]);
  const plan = buildLegacyOperationalCutoverPlan({ offerings, source });
  const lineage = validateLegacyOperationalPromotionLineage({
    existingPromotions,
    plan,
  });

  return {
    existingImportedPromotionCount: lineage.existingImportedPromotionCount,
    plan,
    stalePromotionCount: lineage.stalePromotionIds.length,
    stalePromotionIds: lineage.stalePromotionIds,
  };
}

function lockCutover(tx: PrivateDbTransaction): Promise<unknown> {
  return tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('lash-her:legacy-operational-cutover', 0))`,
  );
}
