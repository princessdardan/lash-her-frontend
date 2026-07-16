import "server-only";

import { and, eq, isNull, or, sql } from "drizzle-orm";

import {
  bookingBusinessSettings,
  bookingProviders,
  bookingServiceOfferings,
} from "@/lib/private-db/schema";

import type { AdminWriteTransaction } from "./admin-transaction";

const SQUARE_ATTRIBUTION_INVARIANT_LOCK =
  "lash-her:booking:square-attribution-invariant";

export async function lockSquareAttributionInvariant(
  tx: AdminWriteTransaction,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${SQUARE_ATTRIBUTION_INVARIANT_LOCK}))`,
  );
}

export async function assertSquareAttributionCanBeRequired(
  tx: AdminWriteTransaction,
): Promise<void> {
  const [unready] = await tx
    .select({ id: bookingProviders.id })
    .from(bookingServiceOfferings)
    .innerJoin(
      bookingProviders,
      eq(bookingProviders.id, bookingServiceOfferings.providerId),
    )
    .where(
      and(
        eq(bookingServiceOfferings.status, "active"),
        or(
          isNull(bookingProviders.squareTeamMemberId),
          isNull(bookingProviders.squareTeamMemberVerifiedAt),
          sql`${bookingProviders.squareTeamMemberStatus} is distinct from 'active'`,
        ),
      ),
    )
    .limit(1);
  if (unready !== undefined) {
    throw new Error(
      "Square attribution cannot be required while an active offering provider lacks a verified active mapping",
    );
  }
}

export async function assertSquareMappingRemovalAllowed(
  tx: AdminWriteTransaction,
  providerId: string,
): Promise<void> {
  const [settings] = await tx
    .select({ required: bookingBusinessSettings.requireSquareTeamAttribution })
    .from(bookingBusinessSettings)
    .where(eq(bookingBusinessSettings.singletonKey, "default"))
    .limit(1);
  if (settings?.required !== true) return;

  const [activeOffering] = await tx
    .select({ id: bookingServiceOfferings.id })
    .from(bookingServiceOfferings)
    .where(
      and(
        eq(bookingServiceOfferings.providerId, providerId),
        eq(bookingServiceOfferings.status, "active"),
      ),
    )
    .limit(1);
  if (activeOffering !== undefined) {
    throw new Error(
      "Disable the provider's active offerings or assign another active Square team member before removing this mapping",
    );
  }
}

export async function assertSquareOfferingActivationAllowed(
  tx: AdminWriteTransaction,
  providerId: string,
): Promise<void> {
  const [[settings], [provider]] = await Promise.all([
    tx
      .select({ required: bookingBusinessSettings.requireSquareTeamAttribution })
      .from(bookingBusinessSettings)
      .where(eq(bookingBusinessSettings.singletonKey, "default"))
      .limit(1),
    tx
      .select({
        squareTeamMemberId: bookingProviders.squareTeamMemberId,
        squareTeamMemberStatus: bookingProviders.squareTeamMemberStatus,
        squareTeamMemberVerifiedAt: bookingProviders.squareTeamMemberVerifiedAt,
      })
      .from(bookingProviders)
      .where(eq(bookingProviders.id, providerId))
      .limit(1),
  ]);
  if (
    settings?.required === true &&
    (provider === undefined ||
      provider.squareTeamMemberId === null ||
      provider.squareTeamMemberStatus !== "active" ||
      provider.squareTeamMemberVerifiedAt === null)
  ) {
    throw new Error(
      "Assign and verify an active Square team member before activating this offering",
    );
  }
}
