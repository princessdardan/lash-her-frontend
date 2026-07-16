import "server-only";

import { desc, eq } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import {
  adminAuditLogs,
  adminUsers,
  type AdminAuditMetadata,
} from "@/lib/private-db/schema";

import { requirePermission } from "./auth";
import { sanitizeAdminAuditMetadata } from "./audit-metadata";
import type { AdminActor } from "./types";

export { sanitizeAdminAuditMetadata } from "./audit-metadata";

export type AdminAuditOutcome = "denied" | "failure" | "success";

export interface AdminAuditEntryInput {
  action: string;
  actor: AdminActor;
  correlationId?: string;
  domain: string;
  ipHash?: string;
  metadata?: AdminAuditMetadata;
  outcome: AdminAuditOutcome;
  reason?: string;
  targetId?: string;
  targetType?: string;
  userAgentHash?: string;
}

export async function recordAdminAudit(
  input: AdminAuditEntryInput,
): Promise<{ id: string }> {
  const db = getPrivateDb();
  const rows = await db
    .insert(adminAuditLogs)
    .values({
      action: input.action,
      actorAdminUserId: input.actor.user.id,
      actorRole: input.actor.user.role,
      correlationId: cleanOptional(input.correlationId),
      domain: input.domain,
      ipHash: cleanOptional(input.ipHash),
      metadata: sanitizeAdminAuditMetadata(input.metadata),
      outcome: input.outcome,
      reason: cleanOptional(input.reason),
      targetId: cleanOptional(input.targetId),
      targetType: cleanOptional(input.targetType),
      userAgentHash: cleanOptional(input.userAgentHash),
    })
    .returning({ id: adminAuditLogs.id });

  if (!rows[0]) {
    throw new Error("Admin audit entry was not persisted");
  }

  return rows[0];
}

export async function listRecentAdminAuditEntries(limit = 100) {
  await requirePermission("audit:view");

  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);
  const db = getPrivateDb();

  return db
    .select({
      action: adminAuditLogs.action,
      actorEmail: adminUsers.emailNormalized,
      actorRole: adminAuditLogs.actorRole,
      createdAt: adminAuditLogs.createdAt,
      domain: adminAuditLogs.domain,
      id: adminAuditLogs.id,
      outcome: adminAuditLogs.outcome,
      reason: adminAuditLogs.reason,
      targetId: adminAuditLogs.targetId,
      targetType: adminAuditLogs.targetType,
    })
    .from(adminAuditLogs)
    .leftJoin(adminUsers, eq(adminAuditLogs.actorAdminUserId, adminUsers.id))
    .orderBy(desc(adminAuditLogs.createdAt))
    .limit(safeLimit);
}

function cleanOptional(value: string | undefined): string | undefined {
  const cleaned = value?.trim() ?? "";
  return cleaned ? cleaned : undefined;
}
