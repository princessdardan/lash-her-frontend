import "server-only";

import { and, asc, eq, inArray, ne } from "drizzle-orm";

import {
  bookingProviders,
  bookingServices,
  bookingServiceOfferings,
  bookingServicePromotionCodes,
  bookingServicePromotionOfferings,
  type BookingConfigurationStatus,
} from "@/lib/private-db/schema";
import { getPrivateDb } from "@/lib/private-db/client";
import {
  parsePromotionCodeInput,
  type DiscountType,
} from "@/lib/commerce/discounts";

import {
  runAuditedAdminMutation,
  type AdminWriteTransaction,
} from "./admin-transaction";
import { requirePermission } from "./auth";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ServicePromotionMutationInput {
  code: string;
  discountType: DiscountType;
  discountValue: number;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  internalTitle: string;
  offeringIds: string[];
}

export async function listAdminServicePromotions() {
  await requirePermission("service-promotions:view");
  const db = getPrivateDb();
  const [promotions, eligibility, offerings] = await Promise.all([
    db
      .select()
      .from(bookingServicePromotionCodes)
      .orderBy(asc(bookingServicePromotionCodes.code)),
    db
      .select({
        offeringId: bookingServicePromotionOfferings.offeringId,
        promotionCodeId: bookingServicePromotionOfferings.promotionCodeId,
      })
      .from(bookingServicePromotionOfferings),
    db
      .select({
        id: bookingServiceOfferings.id,
        offeringKey: bookingServiceOfferings.offeringKey,
        providerName: bookingProviders.displayName,
        publicTitle: bookingServiceOfferings.publicTitle,
        serviceTitle: bookingServices.displayTitle,
        status: bookingServiceOfferings.status,
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
      .where(ne(bookingServiceOfferings.status, "archived"))
      .orderBy(
        asc(bookingProviders.displayName),
        asc(bookingServices.displayTitle),
      ),
  ]);

  const offeringIdsByPromotion = new Map<string, string[]>();
  for (const row of eligibility) {
    const ids = offeringIdsByPromotion.get(row.promotionCodeId) ?? [];
    ids.push(row.offeringId);
    offeringIdsByPromotion.set(row.promotionCodeId, ids);
  }

  return {
    offerings,
    promotions: promotions.map((promotion) => ({
      ...promotion,
      offeringIds: offeringIdsByPromotion.get(promotion.id) ?? [],
    })),
  };
}

export async function createServicePromotion(
  input: ServicePromotionMutationInput,
) {
  const actor = await requirePermission("service-promotions:manage");
  const promotion = normalizePromotionMutation(input);

  return runAuditedAdminMutation({
    action: "service_promotion_created",
    actor,
    domain: "service_promotions",
    metadata: { offeringCount: promotion.offeringIds.length },
    mutate: async (tx) => {
      await assertEligibleOfferingsExist(tx, promotion.offeringIds);
      const [created] = await tx
        .insert(bookingServicePromotionCodes)
        .values({
          code: promotion.code,
          createdByAdminUserId: actor.user.id,
          discountType: promotion.discountType,
          discountValue: promotion.discountValue,
          effectiveFrom: promotion.effectiveFrom,
          effectiveUntil: promotion.effectiveUntil,
          internalTitle: promotion.internalTitle,
          status: "draft",
          updatedByAdminUserId: actor.user.id,
        })
        .returning({ id: bookingServicePromotionCodes.id });

      await tx.insert(bookingServicePromotionOfferings).values(
        promotion.offeringIds.map((offeringId) => ({
          offeringId,
          promotionCodeId: created.id,
        })),
      );

      return created;
    },
    targetId: (created) => created.id,
    targetType: "service_promotion_code",
  });
}

export async function updateServicePromotion(
  input: ServicePromotionMutationInput & { promotionId: string },
) {
  const actor = await requirePermission("service-promotions:manage");
  const promotionId = requireUuid(input.promotionId, "Promotion");
  const promotion = normalizePromotionMutation(input);

  await runAuditedAdminMutation({
    action: "service_promotion_updated",
    actor,
    domain: "service_promotions",
    metadata: { offeringCount: promotion.offeringIds.length },
    mutate: async (tx) => {
      const current = await lockPromotion(tx, promotionId);
      if (current.status === "archived") {
        throw new Error("Archived promotion codes cannot be edited");
      }

      await assertEligibleOfferingsExist(tx, promotion.offeringIds);
      await tx
        .update(bookingServicePromotionCodes)
        .set({
          code: promotion.code,
          discountType: promotion.discountType,
          discountValue: promotion.discountValue,
          effectiveFrom: promotion.effectiveFrom,
          effectiveUntil: promotion.effectiveUntil,
          internalTitle: promotion.internalTitle,
          updatedAt: new Date(),
          updatedByAdminUserId: actor.user.id,
        })
        .where(eq(bookingServicePromotionCodes.id, promotionId));
      await tx
        .delete(bookingServicePromotionOfferings)
        .where(
          eq(bookingServicePromotionOfferings.promotionCodeId, promotionId),
        );
      await tx.insert(bookingServicePromotionOfferings).values(
        promotion.offeringIds.map((offeringId) => ({
          offeringId,
          promotionCodeId: promotionId,
        })),
      );
    },
    targetId: promotionId,
    targetType: "service_promotion_code",
  });
}

export async function setServicePromotionStatus(input: {
  promotionId: string;
  status: BookingConfigurationStatus;
}) {
  const actor = await requirePermission("service-promotions:manage");
  const promotionId = requireUuid(input.promotionId, "Promotion");
  if (
    input.status !== "draft" &&
    input.status !== "active" &&
    input.status !== "disabled" &&
    input.status !== "archived"
  ) {
    throw new Error("Invalid promotion status");
  }

  await runAuditedAdminMutation({
    action: "service_promotion_status_changed",
    actor,
    domain: "service_promotions",
    metadata: { status: input.status },
    mutate: async (tx) => {
      const current = await lockPromotion(tx, promotionId);
      if (current.status === "archived") {
        throw new Error("Archived promotion codes cannot be changed");
      }
      if (input.status === "active") {
        const [eligibility] = await tx
          .select({ id: bookingServicePromotionOfferings.id })
          .from(bookingServicePromotionOfferings)
          .innerJoin(
            bookingServiceOfferings,
            and(
              eq(
                bookingServiceOfferings.id,
                bookingServicePromotionOfferings.offeringId,
              ),
              ne(bookingServiceOfferings.status, "archived"),
            ),
          )
          .where(
            eq(bookingServicePromotionOfferings.promotionCodeId, promotionId),
          )
          .limit(1);
        if (!eligibility) {
          throw new Error(
            "Select at least one provider offering before activation",
          );
        }
      }

      await tx
        .update(bookingServicePromotionCodes)
        .set({
          status: input.status,
          updatedAt: new Date(),
          updatedByAdminUserId: actor.user.id,
        })
        .where(eq(bookingServicePromotionCodes.id, promotionId));
    },
    targetId: promotionId,
    targetType: "service_promotion_code",
  });
}

function normalizePromotionMutation(input: ServicePromotionMutationInput) {
  const code = parsePromotionCodeInput(input.code);
  const internalTitle = input.internalTitle.trim();
  const offeringIds = Array.from(
    new Set(
      input.offeringIds.map((offeringId) =>
        requireUuid(offeringId, "Provider offering"),
      ),
    ),
  );

  if (code === null || code === undefined) {
    throw new Error("Use a valid promotion code");
  }
  if (internalTitle.length === 0 || internalTitle.length > 120) {
    throw new Error("Internal title must be between 1 and 120 characters");
  }
  if (input.discountType !== "percentage" && input.discountType !== "fixed") {
    throw new Error("Invalid discount type");
  }
  if (
    !Number.isInteger(input.discountValue) ||
    input.discountValue <= 0 ||
    (input.discountType === "percentage" && input.discountValue > 10_000)
  ) {
    throw new Error("Invalid discount amount");
  }
  if (offeringIds.length === 0) {
    throw new Error("Select at least one provider offering");
  }
  if (
    input.effectiveFrom !== null &&
    Number.isNaN(input.effectiveFrom.getTime())
  ) {
    throw new Error("Invalid promotion start date");
  }
  if (
    input.effectiveUntil !== null &&
    Number.isNaN(input.effectiveUntil.getTime())
  ) {
    throw new Error("Invalid promotion end date");
  }
  if (
    input.effectiveFrom !== null &&
    input.effectiveUntil !== null &&
    input.effectiveUntil <= input.effectiveFrom
  ) {
    throw new Error("Promotion end date must be after its start date");
  }

  return {
    code,
    discountType: input.discountType,
    discountValue: input.discountValue,
    effectiveFrom: input.effectiveFrom,
    effectiveUntil: input.effectiveUntil,
    internalTitle,
    offeringIds,
  };
}

async function assertEligibleOfferingsExist(
  tx: AdminWriteTransaction,
  offeringIds: string[],
): Promise<void> {
  const rows = await tx
    .select({ id: bookingServiceOfferings.id })
    .from(bookingServiceOfferings)
    .where(
      and(
        inArray(bookingServiceOfferings.id, offeringIds),
        ne(bookingServiceOfferings.status, "archived"),
      ),
    )
    .for("update");

  if (rows.length !== offeringIds.length) {
    throw new Error("One or more selected provider offerings are unavailable");
  }
}

async function lockPromotion(tx: AdminWriteTransaction, promotionId: string) {
  const [promotion] = await tx
    .select({ status: bookingServicePromotionCodes.status })
    .from(bookingServicePromotionCodes)
    .where(eq(bookingServicePromotionCodes.id, promotionId))
    .limit(1)
    .for("update");
  if (!promotion) throw new Error("Promotion code not found");
  return promotion;
}

function requireUuid(value: string, label: string): string {
  const normalized = value.trim();
  if (!UUID_PATTERN.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}
