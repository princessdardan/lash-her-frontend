import "server-only";

import { eq, inArray, isNotNull } from "drizzle-orm";

import {
  createSquareTeamClient,
  type SquareTeamClient,
  type SquareTeamMemberOption,
  type SquareTeamMemberVerification,
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
import {
  createSquareTeamMemberSelectionOption,
  resolveSquareTeamMemberSelection,
  type SquareTeamMemberSelectionCandidate,
  type SquareTeamMemberSelectionOption,
} from "./square-team-selection";
import { applySquareTeamMappingRefresh } from "./square-team-mapping-refresh";

export interface SquareAttributionProviderReadiness {
  displayName: string;
  providerId: string;
  ready: boolean;
  squareTeamMemberDisplayLabel: string | null;
  squareTeamMemberStatus: "active" | "inactive" | "missing" | null;
  squareTeamMemberVerifiedAt: Date | null;
}

export async function listSquareTeamMemberOptions(): Promise<
  SquareTeamMemberSelectionOption[]
> {
  await requirePermission("staff:manage");
  const context = getSquareTeamClientContext();
  const members = await context.client.listActiveLocationMembers();
  return members.map((member) =>
    createSquareTeamMemberSelectionOption(member, context.selectionSecret),
  );
}

export function createCurrentSquareTeamMemberSelectionOption(input: {
  displayLabel: string;
  id: string;
  status: "active" | "inactive" | "missing";
}): SquareTeamMemberSelectionOption | null {
  const env = getSquareServiceBookingRuntimeEnv();
  if (!env) {
    return null;
  }

  return createSquareTeamMemberSelectionOption(
    {
      displayLabel: input.displayLabel,
      id: input.id,
      isOwner: false,
      status: input.status,
    },
    env.accessToken,
  );
}

export async function refreshSquareTeamMappings(): Promise<{
  members: SquareTeamMemberSelectionOption[];
  verifiedMappings: number;
}> {
  const actor = await requirePermission("staff:manage");
  const context = getSquareTeamClientContext();
  const activeMembers = await context.client.listActiveLocationMembers();
  const mappedMemberIds = await listMappedSquareTeamMemberIds();
  const verificationById = await buildSquareTeamVerificationSnapshot({
    activeMembers,
    client: context.client,
    mappedMemberIds,
  });

  const verifiedMappings = await runAuditedAdminMutation({
    action: "square_team_mappings_refreshed",
    actor,
    domain: "square_attribution",
    metadata: {
      activeMemberCount: activeMembers.length,
      inactiveMappingCount: countVerificationStatus(
        verificationById,
        "inactive",
      ),
      missingMappingCount: countVerificationStatus(verificationById, "missing"),
    },
    mutate: async (tx) => {
      await lockSquareAttributionInvariant(tx);
      return applySquareTeamMappingRefresh(tx, {
        actorUserId: actor.user.id,
        now: new Date(),
        verificationById,
      });
    },
    targetId: "default",
    targetType: "square_team_directory",
  });

  return {
    members: activeMembers.map((member) =>
      createSquareTeamMemberSelectionOption(member, context.selectionSecret),
    ),
    verifiedMappings,
  };
}

export async function setProviderSquareTeamMember(input: {
  providerId: string;
  squareTeamMemberSelectionHandle: string | null;
}): Promise<void> {
  const actor = await requirePermission("staff:manage");
  const providerId = requireIdentifier(input.providerId, "Provider");
  const requestedSelectionHandle =
    input.squareTeamMemberSelectionHandle?.trim() || null;
  let member: SquareTeamMemberSelectionCandidate | null = null;
  if (requestedSelectionHandle) {
    const context = getSquareTeamClientContext();
    const activeMembers = await context.client.listActiveLocationMembers();
    member = resolveSquareTeamMemberSelection(
      requestedSelectionHandle,
      activeMembers,
      context.selectionSecret,
    );
  }

  if (requestedSelectionHandle && !member) {
    throw new Error(
      "The selected Square team member is not active at the configured location",
    );
  }
  const requestedMemberId = member?.id ?? null;

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
    .where(inArray(bookingProviders.id, activeProviderIds));

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

async function listMappedSquareTeamMemberIds(): Promise<string[]> {
  const rows = await getPrivateDb()
    .selectDistinct({ id: bookingProviders.squareTeamMemberId })
    .from(bookingProviders)
    .where(isNotNull(bookingProviders.squareTeamMemberId));
  return rows.flatMap((row) => (row.id ? [row.id] : []));
}

async function buildSquareTeamVerificationSnapshot(input: {
  activeMembers: SquareTeamMemberOption[];
  client: SquareTeamClient;
  mappedMemberIds: string[];
}): Promise<Map<string, SquareTeamMemberVerification>> {
  const verificationById = new Map<string, SquareTeamMemberVerification>(
    input.activeMembers.map((member) => [member.id, member]),
  );
  const absentMemberIds = [
    ...new Set(
      input.mappedMemberIds.filter(
        (memberId) => !verificationById.has(memberId),
      ),
    ),
  ];
  const absentVerifications = await Promise.all(
    absentMemberIds.map((memberId) =>
      input.client.retrieveLocationMember(memberId),
    ),
  );
  for (const verification of absentVerifications) {
    verificationById.set(verification.id, verification);
  }
  return verificationById;
}

function countVerificationStatus(
  verificationById: ReadonlyMap<string, SquareTeamMemberVerification>,
  status: "inactive" | "missing",
): number {
  let count = 0;
  for (const verification of verificationById.values()) {
    if (verification.status === status) {
      count += 1;
    }
  }
  return count;
}

function getSquareTeamClientContext(): {
  client: SquareTeamClient;
  selectionSecret: string;
} {
  const context = getOptionalSquareTeamClientContext();
  if (!context) {
    throw new Error("Square service booking is not enabled");
  }
  return context;
}

function getOptionalSquareTeamClientContext(): {
  client: SquareTeamClient;
  selectionSecret: string;
} | null {
  const env = getSquareServiceBookingRuntimeEnv();
  if (!env) {
    return null;
  }
  return {
    client: createSquareTeamClient(env),
    selectionSecret: env.accessToken,
  };
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
