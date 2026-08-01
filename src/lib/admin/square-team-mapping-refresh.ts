import "server-only";

import { eq, isNotNull } from "drizzle-orm";

import type { SquareTeamMemberVerification } from "@/lib/booking/square-team-client";
import { bookingProviders } from "@/lib/private-db/schema";

import type { AdminWriteTransaction } from "./admin-transaction";

export async function applySquareTeamMappingRefresh(
  tx: AdminWriteTransaction,
  input: {
    actorUserId: string | null;
    now: Date;
    verificationById: ReadonlyMap<string, SquareTeamMemberVerification>;
  },
): Promise<number> {
  const mappedProviders = await tx
    .select({
      id: bookingProviders.id,
      squareTeamMemberDisplayLabel:
        bookingProviders.squareTeamMemberDisplayLabel,
      squareTeamMemberId: bookingProviders.squareTeamMemberId,
    })
    .from(bookingProviders)
    .where(isNotNull(bookingProviders.squareTeamMemberId));

  for (const provider of mappedProviders) {
    const memberId = provider.squareTeamMemberId;
    const verification = memberId
      ? input.verificationById.get(memberId)
      : undefined;
    if (!verification) {
      throw new Error(
        "Square team mappings changed during refresh; refresh again",
      );
    }

    await tx
      .update(bookingProviders)
      .set({
        squareTeamMemberDisplayLabel:
          verification.displayLabel ?? provider.squareTeamMemberDisplayLabel,
        squareTeamMemberStatus: verification.status,
        squareTeamMemberVerifiedAt: input.now,
        updatedAt: input.now,
        updatedByAdminUserId: input.actorUserId,
      })
      .where(eq(bookingProviders.id, provider.id));
  }

  return mappedProviders.length;
}
