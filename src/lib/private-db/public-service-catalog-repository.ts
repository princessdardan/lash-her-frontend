import "server-only";

import { and, asc, eq, gt, isNull, lte, or } from "drizzle-orm";
import type { CatalogOffering } from "@/lib/booking/operations/public-service-catalog";
import { getPrivateDb } from "./client";
import {
  bookingProviders,
  bookingServices,
  bookingServiceOfferings,
} from "./schema";

/** Display data only. Historical booking finalizers retain their stricter queries. */
export async function loadPublicServiceCatalogOfferings(
  input: { now?: Date; db?: ReturnType<typeof getPrivateDb> } = {},
): Promise<CatalogOffering[]> {
  const db = input.db ?? getPrivateDb();
  const now = input.now ?? new Date();
  const rows = await db
    .select({
      id: bookingServiceOfferings.id,
      depositAmountCents: bookingServiceOfferings.depositAmountCents,
      displayOrder: bookingServiceOfferings.displayOrder,
      durationMinutes: bookingServiceOfferings.durationMinutes,
      fullPriceCents: bookingServiceOfferings.fullPriceCents,
      publicTitle: bookingServiceOfferings.publicTitle,
      publicSummary: bookingServiceOfferings.publicSummary,
      serviceSlug: bookingServices.publicSlug,
      serviceTitle: bookingServices.displayTitle,
      sanityDocumentId: bookingServices.sanityDocumentId,
      provider: {
        displayName: bookingProviders.displayName,
        providerKey: bookingProviders.providerKey,
        publicSlug: bookingProviders.publicSlug,
      },
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
        eq(bookingServiceOfferings.status, "active"),
        eq(bookingServices.status, "active"),
        eq(bookingProviders.status, "active"),
        eq(bookingServiceOfferings.bookingType, "in-person-appointment"),
        eq(bookingServiceOfferings.currency, "CAD"),
        gt(bookingServiceOfferings.durationMinutes, 0),
        gt(bookingServiceOfferings.fullPriceCents, 0),
        or(
          isNull(bookingServiceOfferings.effectiveFrom),
          lte(bookingServiceOfferings.effectiveFrom, now),
        ),
        or(
          isNull(bookingServiceOfferings.effectiveUntil),
          gt(bookingServiceOfferings.effectiveUntil, now),
        ),
      ),
    )
    .orderBy(
      asc(bookingServiceOfferings.displayOrder),
      asc(bookingProviders.displayOrder),
    );

  return rows.map(({ sanityDocumentId, ...row }) => ({
    ...row,
    hasEditorialDetail: Boolean(sanityDocumentId?.trim()),
    serviceSlug: row.serviceSlug ?? "",
    publicTitle: row.publicTitle ?? undefined,
    publicSummary: row.publicSummary ?? undefined,
    provider: {
      ...row.provider,
      publicSlug: row.provider.publicSlug ?? undefined,
    },
  }));
}
