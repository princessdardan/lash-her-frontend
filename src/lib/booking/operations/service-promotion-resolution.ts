import {
  parsePromotionCodeInput,
  type DiscountType,
  type PromotionCode,
} from "@/lib/commerce/discounts";

export interface ServicePromotionCandidate {
  code: string;
  discountType: string;
  discountValue: number;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  id: string;
  internalTitle: string;
  offeringId: string;
  status: string;
}

export interface ResolveActiveServicePromotionInput {
  code: string;
  now: Date;
  offeringId: string;
}

export interface ServicePromotionResolverDependencies {
  findCandidate: (
    input: ResolveActiveServicePromotionInput,
  ) => Promise<ServicePromotionCandidate | null>;
}

export function createActiveServicePromotionResolver(
  dependencies: ServicePromotionResolverDependencies,
): (
  input: ResolveActiveServicePromotionInput,
) => Promise<PromotionCode | null> {
  return async function resolveActiveServicePromotion(input) {
    const normalizedCode = parsePromotionCodeInput(input.code);
    const offeringId = input.offeringId.trim();

    if (
      normalizedCode === null ||
      normalizedCode === undefined ||
      offeringId.length === 0 ||
      Number.isNaN(input.now.getTime())
    ) {
      return null;
    }

    const candidate = await dependencies.findCandidate({
      code: normalizedCode,
      now: input.now,
      offeringId,
    });

    if (
      candidate === null ||
      candidate.code !== normalizedCode ||
      candidate.offeringId !== offeringId ||
      candidate.status !== "active" ||
      !isActiveAt(candidate, input.now) ||
      !isDiscountType(candidate.discountType) ||
      !isValidDiscountValue(candidate.discountType, candidate.discountValue)
    ) {
      return null;
    }

    return {
      _id: candidate.id,
      amount: candidate.discountValue / 100,
      appliesTo: "services",
      code: candidate.code,
      discountType: candidate.discountType,
      isEnabled: true,
      title: candidate.internalTitle,
    };
  };
}

function isActiveAt(
  candidate: Pick<
    ServicePromotionCandidate,
    "effectiveFrom" | "effectiveUntil"
  >,
  now: Date,
): boolean {
  return (
    (candidate.effectiveFrom === null || candidate.effectiveFrom <= now) &&
    (candidate.effectiveUntil === null || candidate.effectiveUntil > now)
  );
}

function isDiscountType(value: string): value is DiscountType {
  return value === "percentage" || value === "fixed";
}

function isValidDiscountValue(
  discountType: DiscountType,
  value: number,
): boolean {
  return (
    Number.isInteger(value) &&
    value > 0 &&
    (discountType !== "percentage" || value <= 10_000)
  );
}
