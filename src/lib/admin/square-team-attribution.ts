import "server-only";

import { eq, inArray, isNotNull } from "drizzle-orm";

import {
  createSquareTeamClient,
  type SquareTeamClient,
  type SquareTeamMemberOption,
} from "@/lib/booking/square-team-client";
import { getSquareServiceBookingRuntimeEnv } from "@/lib/booking/square-runtime";
import { getPrivateDb } from "@/lib/private-db/client";
import {
  bookingBusinessSettings,
  bookingProviders,
  bookingServiceOfferings,
} from "@/lib/private-db/schema";

import {
  runAuditedAdminMutation,
  type AdminWriteTransaction,
} from "./admin-transaction";
import { requirePermission } from "./auth";
import {
  assertSquareAttributionCanBeRequired,
  assertSquareMappingRemovalAllowed,
  lockSquareAttributionInvariant,
} from "./square-attribution-invariant";

export interface SquareAttributionProviderReadiness {
  displayName: string;
  providerId: string;
  ready: boolean;
  squareTeamMemberDisplayLabel: string | null;
  squareTeamMemberStatus: "active" | "inactive" | "missing" | null;
  squareTeamMemberVerifiedAt: Date | null;
}

export async function listSquareTeamMemberOptions(): Promise<
  SquareTeamMemberOption[]
> {
  await requirePermission("staff:manage");
  return getSquareTeamClient().listActiveLocationMembers();
}

export async function refreshSquareTeamMappings(): Promise<{
  members: SquareTeamMemberOption[];
  verifiedMappings: number;
}> {
  const actor = await requirePermission("staff:manage");
  const members = await getSquareTeamClient().listActiveLocationMembers();
  const memberById = new Map(members.map((member) => [member.id, member]));

  const verifiedMappings = await runAuditedAdminMutation({
    action: "square_team_mappings_refreshed",
    actor,
    domain: "square_attribution",
    metadata: { eligibleMemberCount: members.length },
    mutate: async (tx) => {
      await lockSquareAttributionInvariant(tx);
      const now = new Date();
      const mappedProviders = await tx
        .select({
          id: bookingProviders.id,
          squareTeamMemberDisplayLabel:
            bookingProviders.squareTeamMemberDisplayLabel,
          squareTeamMemberId: bookingProviders.squareTeamMemberId,
        })
        .from(bookingProviders)
        .where(isNotNull(bookingProviders.squareTeamMemberId));

      const [settings] = await tx
        .select({
          required: bookingBusinessSettings.requireSquareTeamAttribution,
        })
        .from(bookingBusinessSettings)
        .where(eq(bookingBusinessSettings.singletonKey, "default"))
        .limit(1);

      if (settings?.required === true) {
        const activeProviderRows = await tx
          .selectDistinct({ providerId: bookingServiceOfferings.providerId })
          .from(bookingServiceOfferings)
          .where(eq(bookingServiceOfferings.status, "active"));
        const activeProviderIds = new Set(
          activeProviderRows.map((row) => row.providerId),
        );
        const invalidatedProviders = mappedProviders.filter(
          (provider) =>
            activeProviderIds.has(provider.id) &&
            !memberById.has(provider.squareTeamMemberId!),
        );

        if (invalidatedProviders.length > 0) {
          throw new Error(
            "Square Team refresh would invalidate a required mapping for an active offering",
          );
        }
      }

      for (const provider of mappedProviders) {
        const member = memberById.get(provider.squareTeamMemberId!);
        await tx
          .update(bookingProviders)
          .set({
            squareTeamMemberDisplayLabel:
              member?.displayLabel ?? provider.squareTeamMemberDisplayLabel,
            squareTeamMemberStatus: member ? "active" : "missing",
            squareTeamMemberVerifiedAt: now,
            updatedAt: now,
            updatedByAdminUserId: actor.user.id,
          })
          .where(eq(bookingProviders.id, provider.id));
      }

      return mappedProviders.length;
    },
    targetId: "default",
    targetType: "square_team_directory",
  });

  return { members, verifiedMappings };
}

export async function setProviderSquareTeamMember(input: {
  providerId: string;
  squareTeamMemberId: string | null;
}): Promise<void> {
  const actor = await requirePermission("staff:manage");
  const providerId = requireIdentifier(input.providerId, "Provider");
  const requestedMemberId = input.squareTeamMemberId?.trim() || null;
  const member = requestedMemberId
    ? (await getSquareTeamClient().listActiveLocationMembers()).find(
        (candidate) => candidate.id === requestedMemberId,
      )
    : null;

  if (requestedMemberId && !member) {
    throw new Error(
      "The selected Square team member is not active at the configured location",
    );
  }

  try {
    await runAuditedAdminMutation({
      action: requestedMemberId
        ? "square_team_mapping_changed"
        : "square_team_mapping_removed",
      actor,
      domain: "square_attribution",
      metadata: {
        mappingPresent: requestedMemberId !== null,
      },
      mutate: async (tx) => {
        await lockSquareAttributionInvariant(tx);
        const [provider] = await tx
          .select({ id: bookingProviders.id })
          .from(bookingProviders)
          .where(eq(bookingProviders.id, providerId))
          .limit(1)
          .for("update");
        if (!provider) {
          throw new Error("Provider not found");
        }

        if (requestedMemberId === null) {
          await assertSquareMappingRemovalAllowed(tx, providerId);
        }

        const now = new Date();
        await tx
          .update(bookingProviders)
          .set({
            squareTeamMemberDisplayLabel: member?.displayLabel ?? null,
            squareTeamMemberId: requestedMemberId,
            squareTeamMemberStatus: member ? "active" : null,
            squareTeamMemberVerifiedAt: member ? now : null,
            updatedAt: now,
            updatedByAdminUserId: actor.user.id,
          })
          .where(eq(bookingProviders.id, providerId));
      },
      targetId: providerId,
      targetType: "booking_provider",
    });
  } catch (error) {
    if (getPostgresErrorCode(error) === "23505") {
      throw new Error(
        "This Square team member is already mapped to another provider",
      );
    }
    throw error;
  }
}

export async function setSquareAttributionRequirement(
  required: boolean,
): Promise<void> {
  const actor = await requirePermission("staff:manage");

  await runAuditedAdminMutation({
    action: "square_attribution_enforcement_changed",
    actor,
    domain: "square_attribution",
    metadata: { required },
    mutate: async (tx) => {
      await lockSquareAttributionInvariant(tx);
      if (required) {
        await assertSquareAttributionCanBeRequired(tx);
        const readiness = await listRequiredProviderReadiness(tx);
        const notReady = readiness.filter((provider) => !provider.ready);
        if (notReady.length > 0) {
          throw new Error(
            `Square attribution cannot be required until every active offering provider has a verified active mapping: ${notReady
              .map((provider) => provider.displayName)
              .join(", ")}`,
          );
        }
      }

      await tx
        .insert(bookingBusinessSettings)
        .values({
          requireSquareTeamAttribution: required,
          singletonKey: "default",
          updatedByAdminUserId: actor.user.id,
        })
        .onConflictDoUpdate({
          target: bookingBusinessSettings.singletonKey,
          set: {
            requireSquareTeamAttribution: required,
            updatedAt: new Date(),
            updatedByAdminUserId: actor.user.id,
          },
        });
    },
    targetId: "default",
    targetType: "booking_settings",
  });
}

export async function getSquareAttributionReadiness(): Promise<{
  providers: SquareAttributionProviderReadiness[];
  required: boolean;
}> {
  await requirePermission("staff:view");
  const db = getPrivateDb();
  const [[settings], providers] = await Promise.all([
    db
      .select({
        required: bookingBusinessSettings.requireSquareTeamAttribution,
      })
      .from(bookingBusinessSettings)
      .where(eq(bookingBusinessSettings.singletonKey, "default"))
      .limit(1),
    listRequiredProviderReadiness(db),
  ]);

  return { providers, required: settings?.required ?? false };
}

async function listRequiredProviderReadiness(
  db: ReturnType<typeof getPrivateDb> | AdminWriteTransaction,
): Promise<SquareAttributionProviderReadiness[]> {
  const activeProviderIds = db
    .selectDistinct({ providerId: bookingServiceOfferings.providerId })
    .from(bookingServiceOfferings)
    .where(eq(bookingServiceOfferings.status, "active"));

  const providers = await db
    .select({
      displayName: bookingProviders.displayName,
      providerId: bookingProviders.id,
      squareTeamMemberDisplayLabel:
        bookingProviders.squareTeamMemberDisplayLabel,
      squareTeamMemberId: bookingProviders.squareTeamMemberId,
      squareTeamMemberStatus: bookingProviders.squareTeamMemberStatus,
      squareTeamMemberVerifiedAt: bookingProviders.squareTeamMemberVerifiedAt,
    })
    .from(bookingProviders)
    .where(
      inArray(
        bookingProviders.id,
        activeProviderIds,
      ),
    );

  return providers.map((provider) => ({
    displayName: provider.displayName,
    providerId: provider.providerId,
    ready:
      provider.squareTeamMemberId !== null &&
      provider.squareTeamMemberStatus === "active" &&
      provider.squareTeamMemberVerifiedAt !== null,
    squareTeamMemberDisplayLabel: provider.squareTeamMemberDisplayLabel,
    squareTeamMemberStatus: provider.squareTeamMemberStatus,
    squareTeamMemberVerifiedAt: provider.squareTeamMemberVerifiedAt,
  }));
}

function getSquareTeamClient(): SquareTeamClient {
  const env = getSquareServiceBookingRuntimeEnv();
  if (!env) {
    throw new Error("Square service booking is not enabled");
  }
  return createSquareTeamClient(env);
}

function requireIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function getPostgresErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
