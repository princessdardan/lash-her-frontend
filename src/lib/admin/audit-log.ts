import "server-only";

import { desc } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import {
  adminAuditLogs,
  type AdminAuditAction,
  type AdminAuditMetadata,
  type AdminRole,
} from "@/lib/private-db/schema";

import type { AdminActor } from "./types";

export interface AuditLogEntryInput {
  action: AdminAuditAction;
  actor: AdminActor;
  domain: string;
  ipAddress?: string;
  metadata?: AdminAuditMetadata;
  privacyRequestId?: string;
  targetId?: string;
  targetType?: string;
  userAgent?: string;
}

interface AuditLogInsert {
  action: AdminAuditAction;
  actorAdminUserId: string;
  actorEmail: string;
  actorRole: AdminRole;
  domain: string;
  ipAddress?: string;
  metadata?: AdminAuditMetadata;
  privacyRequestId?: string;
  targetId?: string;
  targetType?: string;
  userAgent?: string;
}

export interface AuditLogRepository {
  createAuditLogEntry(entry: AuditLogInsert): Promise<{ id: string }>;
}

export function createAuditLogService(repository: AuditLogRepository) {
  return {
    async record(input: AuditLogEntryInput): Promise<{ id: string }> {
      return repository.createAuditLogEntry({
        action: input.action,
        actorAdminUserId: input.actor.user.id,
        actorEmail: input.actor.user.emailNormalized,
        actorRole: input.actor.user.role,
        domain: input.domain,
        ipAddress: input.ipAddress,
        metadata: sanitizeAuditMetadata(input.metadata),
        privacyRequestId: input.privacyRequestId,
        targetId: input.targetId,
        targetType: input.targetType,
        userAgent: input.userAgent,
      });
    },
  };
}

export function createDrizzleAuditLogRepository(): AuditLogRepository {
  const db = getPrivateDb();

  return {
    async createAuditLogEntry(entry) {
      const rows = await db.insert(adminAuditLogs).values(entry).returning({ id: adminAuditLogs.id });

      return rows[0];
    },
  };
}

export function getAuditLogService() {
  return createAuditLogService(createDrizzleAuditLogRepository());
}

export async function listRecentAuditLogEntries(limit = 50) {
  const db = getPrivateDb();

  return db.select().from(adminAuditLogs).orderBy(desc(adminAuditLogs.createdAt)).limit(limit);
}

function sanitizeAuditMetadata(metadata: AdminAuditMetadata | undefined): AdminAuditMetadata | undefined {
  if (!metadata) {
    return undefined;
  }

  return sanitizeMetadataObject(metadata);
}

function sanitizeMetadataObject(metadata: Record<string, unknown>): AdminAuditMetadata {
  const sanitized: AdminAuditMetadata = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (isSensitiveMetadataKey(key)) {
      continue;
    }

    sanitized[key] = sanitizeMetadataValue(value);
  }

  return sanitized;
}

function sanitizeMetadataValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeMetadataValue(item));
  }

  if (value !== null && typeof value === "object") {
    return sanitizeMetadataObject(value as Record<string, unknown>);
  }

  return value;
}

function isSensitiveMetadataKey(key: string): boolean {
  const lowerKey = key.toLowerCase();

  return (
    lowerKey.includes("email")
    || lowerKey.includes("payload")
    || lowerKey.includes("token")
    || lowerKey.includes("secret")
  );
}
