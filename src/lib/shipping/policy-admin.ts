import "server-only";

import { and, eq, inArray, isNull } from "drizzle-orm";
import { getPrivateDb } from "@/lib/private-db/client";
import {
  adminUsers,
  checkoutOrders,
  productShipments,
  shippingCalendarExceptions,
  shippingPolicyAssignments,
  shippingPolicySettings,
  shippingServicePolicies,
  type ShippingPolicyDuty,
} from "@/lib/private-db/schema";
import { computeShippingDeadlines } from "./policy-calendar";

export async function assignShippingPolicyDuty(input: {
  actorAdminUserId: string;
  adminUserId: string;
  duty: ShippingPolicyDuty;
}) {
  return getPrivateDb().transaction(async (tx) => {
    const [actor] = await tx
      .select({ role: adminUsers.role })
      .from(adminUsers)
      .where(eq(adminUsers.id, input.actorAdminUserId))
      .limit(1);
    const [assignee] = await tx
      .select({ id: adminUsers.id })
      .from(adminUsers)
      .where(
        and(
          eq(adminUsers.id, input.adminUserId),
          eq(adminUsers.status, "active"),
        ),
      )
      .limit(1);
    if (actor?.role !== "owner" || !assignee)
      throw new Error("Only the Business Owner may assign active policy roles");
    await tx
      .update(shippingPolicyAssignments)
      .set({ active: false, updatedAt: new Date() })
      .where(
        and(
          eq(shippingPolicyAssignments.duty, input.duty),
          eq(shippingPolicyAssignments.active, true),
        ),
      );
    const [created] = await tx
      .insert(shippingPolicyAssignments)
      .values({
        duty: input.duty,
        adminUserId: input.adminUserId,
        assignedByAdminUserId: input.actorAdminUserId,
      })
      .returning();
    return created!;
  });
}

export async function upsertShippingCalendarException(input: {
  actorAdminUserId: string;
  exceptionDate: string;
  kind: "ontario_holiday" | "branch_closure";
  label: string;
}): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.exceptionDate) || !input.label.trim())
    throw new Error("Calendar exception is invalid");
  const db = getPrivateDb();
  await db
    .insert(shippingCalendarExceptions)
    .values({
      exceptionDate: input.exceptionDate,
      kind: input.kind,
      label: input.label.trim().slice(0, 160),
      createdByAdminUserId: input.actorAdminUserId,
    })
    .onConflictDoUpdate({
      target: [
        shippingCalendarExceptions.exceptionDate,
        shippingCalendarExceptions.kind,
      ],
      set: {
        label: input.label.trim().slice(0, 160),
        updatedAt: new Date(),
      },
    });
  await recalculateOpenShippingDeadlines();
}

export async function upsertShippingServicePolicy(input: {
  postageType: string;
  destinationCountryCode: "CA" | "US";
  trackingRequired: boolean;
  insuranceLimitCents: number;
  signatureCapable: boolean;
  claimWaitingDays: number;
  claimDeadlineDays: number;
  enabled: boolean;
}) {
  if (
    !input.postageType.trim() ||
    input.insuranceLimitCents <= 0 ||
    input.claimWaitingDays < 0 ||
    input.claimDeadlineDays <= input.claimWaitingDays
  )
    throw new Error("Service policy is invalid");
  const [updated] = await getPrivateDb()
    .insert(shippingServicePolicies)
    .values({
      ...input,
      postageType: input.postageType.trim(),
      reviewedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        shippingServicePolicies.postageType,
        shippingServicePolicies.destinationCountryCode,
      ],
      set: {
        trackingRequired: input.trackingRequired,
        insuranceLimitCents: input.insuranceLimitCents,
        signatureCapable: input.signatureCapable,
        claimWaitingDays: input.claimWaitingDays,
        claimDeadlineDays: input.claimDeadlineDays,
        reviewedAt: new Date(),
        enabled: input.enabled,
        updatedAt: new Date(),
      },
    })
    .returning();
  return updated!;
}

export async function updateShippingPolicySettings(input: {
  forwarderPatterns?: string[];
  pilotStartedAt?: Date;
}) {
  const [updated] = await getPrivateDb()
    .update(shippingPolicySettings)
    .set({
      ...(input.forwarderPatterns
        ? {
            forwarderPatterns: input.forwarderPatterns
              .map((value) => value.trim().toLowerCase())
              .filter(Boolean)
              .slice(0, 200),
          }
        : {}),
      ...(input.pilotStartedAt ? { pilotStartedAt: input.pilotStartedAt } : {}),
      updatedAt: new Date(),
    })
    .where(eq(shippingPolicySettings.singletonKey, "default"))
    .returning();
  if (!updated) throw new Error("Shipping policy settings were not found");
  return updated;
}

async function recalculateOpenShippingDeadlines(): Promise<void> {
  const db = getPrivateDb();
  const [settings] = await db.select().from(shippingPolicySettings).limit(1);
  if (!settings) return;
  const exceptions = await db.select().from(shippingCalendarExceptions);
  const closedDates = new Set(exceptions.map((entry) => entry.exceptionDate));
  const rows = await db
    .select({
      shipmentId: productShipments.id,
      clearedAt: checkoutOrders.fulfillmentClearedAt,
    })
    .from(productShipments)
    .innerJoin(checkoutOrders, eq(productShipments.orderId, checkoutOrders.id))
    .where(
      and(
        isNull(productShipments.acceptedAt),
        inArray(productShipments.status, [
          "ready_for_staff",
          "purchase_pending",
          "label_ready",
          "manual_review",
        ]),
      ),
    );
  for (const row of rows) {
    if (!row.clearedAt) continue;
    const deadlines = computeShippingDeadlines({
      clearedAt: row.clearedAt,
      settings,
      closedDates,
    });
    await db
      .update(productShipments)
      .set({
        originalHandoffDeadlineAt: deadlines.handoffDeadlineAt,
        autoRefundDeadlineAt: deadlines.autoRefundDeadlineAt,
        updatedAt: new Date(),
      })
      .where(eq(productShipments.id, row.shipmentId));
  }
}
