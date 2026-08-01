import "server-only";

import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  lt,
  sql,
  type SQL,
} from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import {
  adminAuditLogs,
  adminUsers,
  appointments,
  bookingCalendarConnections,
  bookingProviders,
  bookingResourceCalendarAssignments,
  bookingResourceScheduleExceptions,
  bookingResourceSchedules,
  bookingResources,
  bookingServiceOfferingAddOns,
  bookingServiceOfferings,
  bookingServicePromotionCodes,
  bookingServices,
  type AdminAuditMetadata,
} from "@/lib/private-db/schema";

import {
  getAdminActivityDomains,
  presentAdminActivity,
  type AdminActivityPresentation,
  type AdminActivityQueryFilters,
} from "./activity-presentation";
import { addAdminActorAuditContext } from "./actor-audit-context";
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

export interface AdminActivityActorOption {
  id: string;
  label: string;
}

export interface AdminActivityHistoryResult {
  actors: AdminActivityActorOption[];
  page: number;
  pageCount: number;
  pageSize: number;
  rows: AdminActivityPresentation[];
  total: number;
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
      metadata: sanitizeAdminAuditMetadata(
        addAdminActorAuditContext(input.actor, input.metadata),
      ),
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

export async function recordAdminAuditBestEffort(
  input: AdminAuditEntryInput,
): Promise<void> {
  try {
    await recordAdminAudit(input);
  } catch {
    console.error(
      "[admin:audit] Activity history entry could not be persisted",
      {
        action: input.action,
        outcome: input.outcome,
      },
    );
  }
}

export async function listAdminActivityHistory(
  filters: AdminActivityQueryFilters,
): Promise<AdminActivityHistoryResult> {
  await requirePermission("audit:view");

  const db = getPrivateDb();
  const conditions: SQL[] = [];
  if (filters.actorId) {
    conditions.push(eq(adminAuditLogs.actorAdminUserId, filters.actorId));
  }
  if (filters.area) {
    conditions.push(
      inArray(adminAuditLogs.domain, getAdminActivityDomains(filters.area)),
    );
  }
  if (filters.outcome) {
    conditions.push(eq(adminAuditLogs.outcome, filters.outcome));
  }
  if (filters.createdFrom) {
    conditions.push(gte(adminAuditLogs.createdAt, filters.createdFrom));
  }
  if (filters.createdToExclusive) {
    conditions.push(lt(adminAuditLogs.createdAt, filters.createdToExclusive));
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const requestedPage = clampInteger(filters.page, 1, 100_000);
  const pageSize = clampInteger(filters.pageSize, 1, 100);

  const [[totalRow], actorRows] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(adminAuditLogs)
      .where(where),
    db
      .select({
        displayName: adminUsers.displayName,
        email: adminUsers.emailNormalized,
        id: adminUsers.id,
      })
      .from(adminUsers)
      .orderBy(asc(adminUsers.displayName), asc(adminUsers.emailNormalized)),
  ]);
  const total = Number(totalRow?.count ?? 0);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, pageCount);

  const rawRows = await db
    .select({
      action: adminAuditLogs.action,
      actorDisplayName: adminUsers.displayName,
      actorEmail: adminUsers.emailNormalized,
      actorRole: adminAuditLogs.actorRole,
      correlationId: adminAuditLogs.correlationId,
      createdAt: adminAuditLogs.createdAt,
      domain: adminAuditLogs.domain,
      id: adminAuditLogs.id,
      metadata: adminAuditLogs.metadata,
      outcome: adminAuditLogs.outcome,
      reason: adminAuditLogs.reason,
      targetId: adminAuditLogs.targetId,
      targetType: adminAuditLogs.targetType,
    })
    .from(adminAuditLogs)
    .leftJoin(adminUsers, eq(adminAuditLogs.actorAdminUserId, adminUsers.id))
    .where(where)
    .orderBy(desc(adminAuditLogs.createdAt), desc(adminAuditLogs.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const targetLabels = await resolveAdminActivityTargetLabels(db, rawRows);
  const rows = rawRows.map((row) =>
    presentAdminActivity({
      ...row,
      targetLabel:
        row.targetType && row.targetId
          ? (targetLabels.get(targetKey(row.targetType, row.targetId)) ?? null)
          : null,
    }),
  );

  return {
    actors: actorRows.map((actor) => ({
      id: actor.id,
      label: formatActorOptionLabel(actor),
    })),
    page,
    pageCount,
    pageSize,
    rows,
    total,
  };
}

type PrivateDb = ReturnType<typeof getPrivateDb>;

async function resolveAdminActivityTargetLabels(
  db: PrivateDb,
  rows: Array<{
    targetId: string | null;
    targetType: string | null;
  }>,
): Promise<Map<string, string>> {
  const idsByType = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.targetId || !row.targetType || !isUuid(row.targetId)) {
      continue;
    }
    const ids = idsByType.get(row.targetType) ?? [];
    ids.push(row.targetId);
    idsByType.set(row.targetType, ids);
  }

  const tasks: Array<Promise<Array<[string, string]>>> = [];
  const adminUserIds = uniqueIds(idsByType.get("admin_user"));
  if (adminUserIds.length > 0) {
    tasks.push(
      db
        .select({
          displayName: adminUsers.displayName,
          email: adminUsers.emailNormalized,
          id: adminUsers.id,
        })
        .from(adminUsers)
        .where(inArray(adminUsers.id, adminUserIds))
        .then((targetRows) =>
          targetRows.map((row) => [
            targetKey("admin_user", row.id),
            cleanOptional(row.displayName) ??
              cleanOptional(row.email) ??
              "Team member",
          ]),
        ),
    );
  }

  const resourceIds = uniqueIds(idsByType.get("booking_resource"));
  if (resourceIds.length > 0) {
    tasks.push(
      db
        .select({ id: bookingResources.id, name: bookingResources.name })
        .from(bookingResources)
        .where(inArray(bookingResources.id, resourceIds))
        .then((targetRows) =>
          targetRows.map((row) => [
            targetKey("booking_resource", row.id),
            row.name,
          ]),
        ),
    );
  }

  const providerIds = uniqueIds(idsByType.get("booking_provider"));
  if (providerIds.length > 0) {
    tasks.push(
      db
        .select({
          displayName: bookingProviders.displayName,
          id: bookingProviders.id,
        })
        .from(bookingProviders)
        .where(inArray(bookingProviders.id, providerIds))
        .then((targetRows) =>
          targetRows.map((row) => [
            targetKey("booking_provider", row.id),
            row.displayName,
          ]),
        ),
    );
  }

  const serviceIds = uniqueIds(idsByType.get("booking_service"));
  if (serviceIds.length > 0) {
    tasks.push(
      db
        .select({
          displayTitle: bookingServices.displayTitle,
          id: bookingServices.id,
        })
        .from(bookingServices)
        .where(inArray(bookingServices.id, serviceIds))
        .then((targetRows) =>
          targetRows.map((row) => [
            targetKey("booking_service", row.id),
            row.displayTitle,
          ]),
        ),
    );
  }

  const offeringIds = uniqueIds(idsByType.get("service_offering"));
  if (offeringIds.length > 0) {
    tasks.push(
      db
        .select({
          id: bookingServiceOfferings.id,
          providerName: bookingProviders.displayName,
          publicTitle: bookingServiceOfferings.publicTitle,
          serviceTitle: bookingServices.displayTitle,
        })
        .from(bookingServiceOfferings)
        .innerJoin(
          bookingProviders,
          eq(bookingProviders.id, bookingServiceOfferings.providerId),
        )
        .innerJoin(
          bookingServices,
          eq(bookingServices.id, bookingServiceOfferings.serviceId),
        )
        .where(inArray(bookingServiceOfferings.id, offeringIds))
        .then((targetRows) =>
          targetRows.map((row) => [
            targetKey("service_offering", row.id),
            cleanOptional(row.publicTitle) ??
              `${row.serviceTitle} with ${row.providerName}`,
          ]),
        ),
    );
  }

  const addOnIds = uniqueIds(idsByType.get("offering_add_on"));
  if (addOnIds.length > 0) {
    tasks.push(
      db
        .select({
          id: bookingServiceOfferingAddOns.id,
          name: bookingServiceOfferingAddOns.name,
        })
        .from(bookingServiceOfferingAddOns)
        .where(inArray(bookingServiceOfferingAddOns.id, addOnIds))
        .then((targetRows) =>
          targetRows.map((row) => [
            targetKey("offering_add_on", row.id),
            row.name,
          ]),
        ),
    );
  }

  const scheduleIds = uniqueIds(idsByType.get("resource_schedule"));
  if (scheduleIds.length > 0) {
    tasks.push(
      db
        .select({
          id: bookingResourceSchedules.id,
          resourceName: bookingResources.name,
        })
        .from(bookingResourceSchedules)
        .innerJoin(
          bookingResources,
          eq(bookingResources.id, bookingResourceSchedules.resourceId),
        )
        .where(inArray(bookingResourceSchedules.id, scheduleIds))
        .then((targetRows) =>
          targetRows.map((row) => [
            targetKey("resource_schedule", row.id),
            row.resourceName,
          ]),
        ),
    );
  }

  const exceptionIds = uniqueIds(idsByType.get("schedule_exception"));
  if (exceptionIds.length > 0) {
    tasks.push(
      db
        .select({
          id: bookingResourceScheduleExceptions.id,
          resourceName: bookingResources.name,
        })
        .from(bookingResourceScheduleExceptions)
        .innerJoin(
          bookingResources,
          eq(bookingResources.id, bookingResourceScheduleExceptions.resourceId),
        )
        .where(inArray(bookingResourceScheduleExceptions.id, exceptionIds))
        .then((targetRows) =>
          targetRows.map((row) => [
            targetKey("schedule_exception", row.id),
            row.resourceName,
          ]),
        ),
    );
  }

  const connectionIds = uniqueIds(idsByType.get("calendar_connection"));
  if (connectionIds.length > 0) {
    tasks.push(
      db
        .select({
          accountEmail: bookingCalendarConnections.accountEmail,
          id: bookingCalendarConnections.id,
        })
        .from(bookingCalendarConnections)
        .where(inArray(bookingCalendarConnections.id, connectionIds))
        .then((targetRows) =>
          targetRows.map((row) => [
            targetKey("calendar_connection", row.id),
            cleanOptional(row.accountEmail)
              ? `Google Calendar account ${row.accountEmail}`
              : "Google Calendar account",
          ]),
        ),
    );
  }

  const assignmentIds = uniqueIds(idsByType.get("calendar_assignment"));
  if (assignmentIds.length > 0) {
    tasks.push(
      db
        .select({
          calendarLabel: bookingResourceCalendarAssignments.calendarLabel,
          id: bookingResourceCalendarAssignments.id,
          resourceName: bookingResources.name,
        })
        .from(bookingResourceCalendarAssignments)
        .innerJoin(
          bookingResources,
          eq(
            bookingResources.id,
            bookingResourceCalendarAssignments.resourceId,
          ),
        )
        .where(inArray(bookingResourceCalendarAssignments.id, assignmentIds))
        .then((targetRows) =>
          targetRows.map((row) => [
            targetKey("calendar_assignment", row.id),
            cleanOptional(row.calendarLabel)
              ? `${row.calendarLabel} for ${row.resourceName}`
              : `Calendar sync for ${row.resourceName}`,
          ]),
        ),
    );
  }

  const appointmentIds = uniqueIds(idsByType.get("appointment"));
  if (appointmentIds.length > 0) {
    tasks.push(
      db
        .select({
          id: appointments.id,
          publicReference: appointments.publicReference,
        })
        .from(appointments)
        .where(inArray(appointments.id, appointmentIds))
        .then((targetRows) =>
          targetRows.map((row) => [
            targetKey("appointment", row.id),
            `Appointment ${row.publicReference}`,
          ]),
        ),
    );
  }

  const promotionIds = uniqueIds(idsByType.get("service_promotion_code"));
  if (promotionIds.length > 0) {
    tasks.push(
      db
        .select({
          id: bookingServicePromotionCodes.id,
          internalTitle: bookingServicePromotionCodes.internalTitle,
        })
        .from(bookingServicePromotionCodes)
        .where(inArray(bookingServicePromotionCodes.id, promotionIds))
        .then((targetRows) =>
          targetRows.map((row) => [
            targetKey("service_promotion_code", row.id),
            row.internalTitle,
          ]),
        ),
    );
  }

  const groups = await Promise.all(tasks);
  return new Map(groups.flat());
}

function uniqueIds(ids: string[] | undefined): string[] {
  return [...new Set(ids ?? [])];
}

function targetKey(targetType: string, targetId: string): string {
  return `${targetType}:${targetId}`;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.min(Math.max(Math.trunc(value), minimum), maximum);
}

function formatActorOptionLabel(actor: {
  displayName: string | null;
  email: string;
}): string {
  const displayName = cleanOptional(actor.displayName);
  const email = cleanOptional(actor.email);
  if (displayName && email) {
    return `${displayName} (${email})`;
  }
  return displayName ?? email ?? "Staff account";
}

function cleanOptional(value: string | null | undefined): string | undefined {
  const cleaned = value?.trim() ?? "";
  return cleaned ? cleaned : undefined;
}
