import "server-only";

import { and, eq, gt, isNull, lte, or } from "drizzle-orm";

import {
  createActiveServicePromotionResolver,
  type ResolveActiveServicePromotionInput,
} from "@/lib/booking/operations/service-promotion-resolution";
import type { PromotionCode } from "@/lib/commerce/discounts";

import { getPrivateDb } from "./client";
import {
  bookingServicePromotionCodes,
  bookingServicePromotionOfferings,
} from "./schema";

const defaultResolver = createActiveServicePromotionResolver({
  async findCandidate(input) {
    const db = getPrivateDb();
    const [candidate] = await db
      .select({
        code: bookingServicePromotionCodes.code,
        discountType: bookingServicePromotionCodes.discountType,
        discountValue: bookingServicePromotionCodes.discountValue,
        effectiveFrom: bookingServicePromotionCodes.effectiveFrom,
        effectiveUntil: bookingServicePromotionCodes.effectiveUntil,
        id: bookingServicePromotionCodes.id,
        internalTitle: bookingServicePromotionCodes.internalTitle,
        offeringId: bookingServicePromotionOfferings.offeringId,
        status: bookingServicePromotionCodes.status,
      })
      .from(bookingServicePromotionCodes)
      .innerJoin(
        bookingServicePromotionOfferings,
        and(
          eq(
            bookingServicePromotionOfferings.promotionCodeId,
            bookingServicePromotionCodes.id,
          ),
          eq(bookingServicePromotionOfferings.offeringId, input.offeringId),
        ),
      )
      .where(
        and(
          eq(bookingServicePromotionCodes.code, input.code),
          eq(bookingServicePromotionCodes.status, "active"),
          or(
            isNull(bookingServicePromotionCodes.effectiveFrom),
            lte(bookingServicePromotionCodes.effectiveFrom, input.now),
          ),
          or(
            isNull(bookingServicePromotionCodes.effectiveUntil),
            gt(bookingServicePromotionCodes.effectiveUntil, input.now),
          ),
        ),
      )
      .limit(1);

    return candidate ?? null;
  },
});

export function resolveActiveServicePromotionCode(
  input: ResolveActiveServicePromotionInput,
): Promise<PromotionCode | null> {
  return defaultResolver(input);
}
