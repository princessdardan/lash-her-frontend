import { parseCad } from "./money";

export type DiscountTargetType = "product" | "trainingProgram" | "service";
export type DiscountType = "percentage" | "fixed";

export interface ManualDiscountInput {
  price: number | string;
  discountPrice?: number | string | null;
}

export interface PromotionCode {
  _id: string;
  code: string;
  title?: string;
  isEnabled?: boolean;
  discountType: DiscountType;
  amount: number;
  appliesTo?:
    | "all"
    | "products"
    | "trainingPrograms"
    | "services"
    | "specificItems";
  products?: Array<{ _id: string }>;
  trainingPrograms?: Array<{ _id: string }>;
  services?: Array<{ _id: string }>;
}

export interface PriceSnapshot {
  price: number;
  originalPrice?: number;
}

export interface PromotionDiscountResult {
  code: string;
  amount: number;
}

export const PROMOTION_CODE_MAX_LENGTH = 32;

const PROMOTION_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;

export function normalizePromotionCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, "");
}

export function parsePromotionCodeInput(
  value: unknown,
): string | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;

  const code = normalizePromotionCode(value);
  if (code.length === 0) return undefined;

  return PROMOTION_CODE_PATTERN.test(code) ? code : null;
}

export function resolveManualDiscount(
  input: ManualDiscountInput,
): PriceSnapshot {
  const price = parseCad(input.price);
  if (input.discountPrice === undefined || input.discountPrice === null) {
    return { price };
  }

  const discountPrice = parseCad(input.discountPrice);
  if (discountPrice >= price) {
    return { price };
  }

  return { price: discountPrice, originalPrice: price };
}

export function applyPromotionCode(input: {
  promotionCode: PromotionCode | null | undefined;
  targetType: DiscountTargetType;
  targetIds: string[];
  amount: number;
}): PromotionDiscountResult | null {
  const { promotionCode, targetType, targetIds, amount } = input;
  if (!promotionCode?.isEnabled) return null;
  if (!isPromotionApplicable(promotionCode, targetType, targetIds)) return null;

  const discountAmount = getPromotionDiscountAmount(promotionCode, amount);
  if (discountAmount <= 0) return null;

  return {
    code: normalizePromotionCode(promotionCode.code),
    amount: discountAmount,
  };
}

export function isPromotionApplicable(
  promotionCode: PromotionCode,
  targetType: DiscountTargetType,
  targetIds: string[],
): boolean {
  const appliesTo = promotionCode.appliesTo ?? "all";
  // Legacy "all" intentionally excludes services so existing product/training
  // codes cannot accidentally discount service bookings.
  if (appliesTo === "all") {
    return targetType === "product" || targetType === "trainingProgram";
  }
  if (appliesTo === "products") return targetType === "product";
  if (appliesTo === "trainingPrograms") return targetType === "trainingProgram";
  if (appliesTo === "services") return targetType === "service";

  const eligibleIds =
    targetType === "product"
      ? (promotionCode.products?.map((product) => product._id) ?? [])
      : targetType === "trainingProgram"
        ? (promotionCode.trainingPrograms?.map((program) => program._id) ?? [])
        : (promotionCode.services?.map((service) => service._id) ?? []);

  return targetIds.some((targetId) => eligibleIds.includes(targetId));
}

function getPromotionDiscountAmount(
  promotionCode: PromotionCode,
  amount: number,
): number {
  if (promotionCode.amount <= 0) return 0;

  const amountCents = cadToCents(amount);
  const discountCents =
    promotionCode.discountType === "percentage"
      ? Math.round(amountCents * (promotionCode.amount / 100))
      : cadToCents(promotionCode.amount);

  return centsToCad(Math.min(discountCents, amountCents));
}

export function subtractCad(amount: number, discount: number): number {
  return centsToCad(Math.max(0, cadToCents(amount) - cadToCents(discount)));
}

export function getManualDiscountAmount(input: {
  price: number;
  originalPrice?: number;
}): number {
  if (input.originalPrice === undefined) return 0;

  return subtractCad(input.originalPrice, input.price);
}

export function cadToCents(value: number | string): number {
  return Math.round(parseCad(value) * 100);
}

export function centsToCad(cents: number): number {
  return cents / 100;
}
