import {
  applyPromotionCode,
  cadToCents,
  centsToCad,
  normalizePromotionCode,
  type PromotionCode,
} from "@/lib/commerce/discounts";

export interface ServicePromotionSnapshot {
  code: string;
  discountType: "percentage" | "fixed";
  // Raw value from the promotion code (percentage number or fixed CAD amount).
  discountAmount: number;
  discountCents: number;
  originalBasePriceCents: number;
  discountedBasePriceCents: number;
}

export function calculateServicePromotionSnapshot(input: {
  promotionCode: PromotionCode;
  serviceIds: string[];
  basePriceCents: number;
}): ServicePromotionSnapshot | null {
  const { promotionCode, basePriceCents } = input;
  const serviceIds = Array.from(
    new Set(
      input.serviceIds.map((serviceId) => serviceId.trim()).filter(Boolean),
    ),
  );

  if (basePriceCents <= 0 || serviceIds.length === 0) return null;

  return calculatePromotionSnapshot({
    basePriceCents,
    promotionCode,
    serviceIds,
  });
}

export function calculateAuthorizedServicePromotionSnapshot(input: {
  promotionCode: PromotionCode;
  basePriceCents: number;
}): ServicePromotionSnapshot | null {
  if (
    input.basePriceCents <= 0 ||
    input.promotionCode.appliesTo !== "services"
  ) {
    return null;
  }

  return calculatePromotionSnapshot({
    basePriceCents: input.basePriceCents,
    promotionCode: input.promotionCode,
    serviceIds: [],
  });
}

function calculatePromotionSnapshot(input: {
  basePriceCents: number;
  promotionCode: PromotionCode;
  serviceIds: string[];
}): ServicePromotionSnapshot | null {
  const { basePriceCents, promotionCode, serviceIds } = input;
  const discountResult = applyPromotionCode({
    promotionCode,
    targetType: "service",
    targetIds: serviceIds,
    amount: centsToCad(basePriceCents),
  });

  if (discountResult === null) return null;

  // Service promotions may reduce the base price to zero. Over-base fixed
  // discounts are clamped to the original base so the discount never exceeds
  // the amount being discounted.
  const discountCents = Math.min(
    cadToCents(discountResult.amount),
    basePriceCents,
  );

  if (discountCents <= 0) return null;

  return {
    code: normalizePromotionCode(discountResult.code),
    discountType: promotionCode.discountType,
    discountAmount: promotionCode.amount,
    discountCents,
    originalBasePriceCents: basePriceCents,
    discountedBasePriceCents: basePriceCents - discountCents,
  };
}

export function readServicePromotionSnapshot(
  snapshot: Record<string, unknown>,
  expectedOriginalBasePriceCents?: number,
): ServicePromotionSnapshot | null {
  const promotion = isRecord(snapshot.promotionSnapshot)
    ? snapshot.promotionSnapshot
    : null;

  if (promotion === null) return null;

  const code = typeof promotion.code === "string" ? promotion.code.trim() : "";
  const discountType =
    promotion.discountType === "percentage" ||
    promotion.discountType === "fixed"
      ? promotion.discountType
      : null;
  const discountAmount = toPositiveAmount(promotion.discountAmount);
  const discountCents = toNonNegativeInteger(promotion.discountCents);
  const originalBasePriceCents = toPositiveInteger(
    promotion.originalBasePriceCents,
  );
  const discountedBasePriceCents = toNonNegativeInteger(
    promotion.discountedBasePriceCents,
  );

  if (
    code.length === 0 ||
    discountType === null ||
    discountAmount === null ||
    discountCents === null ||
    originalBasePriceCents === null ||
    discountedBasePriceCents === null ||
    discountCents <= 0 ||
    discountCents !== originalBasePriceCents - discountedBasePriceCents ||
    (expectedOriginalBasePriceCents !== undefined &&
      originalBasePriceCents !== expectedOriginalBasePriceCents) ||
    discountedBasePriceCents > originalBasePriceCents
  ) {
    return null;
  }

  return {
    code,
    discountType,
    discountAmount,
    discountCents,
    originalBasePriceCents,
    discountedBasePriceCents,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPositiveAmount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.round(value * 100) / 100;
}

function toNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return null;
  }

  return value;
}

function toPositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null;
  }

  return value;
}
