import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import {
  requirePermission,
  requireRecentAdminAuthentication,
} from "@/lib/admin/auth";
import {
  recordAdminAudit,
  recordAdminAuditBestEffort,
} from "@/lib/admin/audit-log";
import { getPrivateDb } from "@/lib/private-db/client";
import {
  checkoutOrders,
  orderPaymentObligations,
  productManualFulfillmentEvents,
} from "@/lib/private-db/schema";
import { queueProductOrderRefundAllocationsInTransaction } from "@/lib/shipping/customer-refunds";
import {
  getManualFulfillmentConflictToken,
  getManualFulfillmentTransition,
  type ManualFulfillmentAction,
} from "@/lib/admin/manual-fulfillment-transition";
import { isManualProductCheckoutEnabled } from "@/lib/shipping/config";
import { isSquareCommerceCheckoutEnabled } from "@/lib/env/private-checkout";
import {
  assertConfiguredFulfillmentOwner,
  assertConfiguredFulfillmentOwnerInTransaction,
} from "@/lib/shipping/configured-owner";

type ManualAction = ManualFulfillmentAction | "deny_cancellation";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orderId: string }> },
): Promise<Response> {
  const actor = await requirePermission("fulfillment:manage");
  await assertConfiguredFulfillmentOwner(actor.user.id);
  if (!isManualProductCheckoutEnabled())
    return NextResponse.json(
      { error: "Manual product fulfillment is not enabled" },
      { status: 503 },
    );
  if (req.headers.get("origin") !== req.nextUrl.origin) {
    return NextResponse.json(
      { error: "Invalid request origin" },
      { status: 403 },
    );
  }

  const body = (await req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const action = parseAction(body?.action);
  const rationale = cleanText(body?.rationale, 500);
  const evidence = parseEvidence(body?.evidence);
  const expectedConflictToken = cleanText(body?.expectedConflictToken, 300);
  const { orderId } = await params;

  if (!action || rationale.length < 10 || !evidence || !expectedConflictToken) {
    return NextResponse.json(
      {
        error:
          "Action, current conflict token, rationale, and evidence are required",
      },
      { status: 400 },
    );
  }

  try {
    const initial = await loadManualOrder(orderId);
    assertConflictToken(initial, expectedConflictToken);

    const stepUpAuthenticatedAt = await requireRecentAdminAuthentication({
      action: `manual:${action}`,
      target: initial.id,
    });
    if (action === "deny_cancellation") {
      const irreversibleWorkType = parseIrreversibleWorkType(
        body?.irreversibleWorkType,
      );
      const irreversibleWorkStartedAt = parsePastInstant(
        body?.irreversibleWorkStartedAt,
      );
      const affectedAmountCents = Number(body?.affectedAmountCents);
      if (
        !irreversibleWorkType ||
        !irreversibleWorkStartedAt ||
        !Number.isInteger(affectedAmountCents) ||
        affectedAmountCents <= 0 ||
        affectedAmountCents > initial.amountCents
      ) {
        throw new Error(
          "Cancellation denial requires eligible irreversible work, its start time, and a valid affected amount",
        );
      }
      const denial = await getPrivateDb().transaction(async (tx) => {
        await assertConfiguredFulfillmentOwnerInTransaction(tx, actor.user.id);
        const [current] = await tx
          .select()
          .from(checkoutOrders)
          .where(
            and(
              eq(checkoutOrders.id, initial.id),
              eq(checkoutOrders.status, "paid"),
            ),
          )
          .for("update")
          .limit(1);
        if (
          !current ||
          !current.fulfillmentMode?.startsWith("manual_") ||
          ["cancelled", "dispatched"].includes(
            current.manualFulfillmentStatus ?? "",
          ) ||
          irreversibleWorkStartedAt < current.createdAt ||
          affectedAmountCents > current.amountCents
        ) {
          throw new Error("Cancellation denial evidence is not applicable");
        }
        assertConflictToken(current, expectedConflictToken);
        const occurredAt = nextUpdatedAt(current.updatedAt);
        const [event] = await tx
          .insert(productManualFulfillmentEvents)
          .values({
            actorAdminUserId: actor.user.id,
            evidence: {
              ...evidence,
              action: "deny_cancellation",
              irreversibleWorkType,
              irreversibleWorkStartedAt:
                irreversibleWorkStartedAt.toISOString(),
              affectedAmountCents,
              stepUpAuthenticatedAt: stepUpAuthenticatedAt.toISOString(),
            },
            method:
              current.fulfillmentMode === "manual_pickup"
                ? "pickup_handoff"
                : "manual_shipping",
            occurredAt,
            orderId: current.id,
            rationale,
            status: current.manualFulfillmentStatus ?? "paid_pending_dispatch",
          })
          .returning({ id: productManualFulfillmentEvents.id });
        if (!event) throw new Error("Cancellation denial was not recorded");
        await tx
          .update(checkoutOrders)
          .set({ updatedAt: occurredAt })
          .where(eq(checkoutOrders.id, current.id));
        return { eventId: event.id, orderDatabaseId: current.id };
      });
      await recordAdminAudit({
        action: "fulfillment.manual_cancellation_denied",
        actor,
        domain: "fulfillment",
        outcome: "denied",
        reason: rationale,
        targetId: denial.orderDatabaseId,
        targetType: "checkout_order",
        metadata: {
          eventId: denial.eventId,
          irreversibleWorkType,
          irreversibleWorkStartedAt: irreversibleWorkStartedAt.toISOString(),
          affectedAmountCents,
        },
      });
      return NextResponse.json({
        denied: true,
        eventId: denial.eventId,
        orderId,
      });
    }
    const cancellationBasis =
      body?.cancellationBasis === "customer_approved" ||
      body?.cancellationBasis === "policy_default"
        ? body.cancellationBasis
        : null;
    if (action === "approve_cancellation" && !cancellationBasis) {
      throw new Error(
        "Cancellation must identify customer approval or policy default",
      );
    }
    if (action === "approve_cancellation" && initial.status === "paid") {
      await requirePermission("payments:refund");
    }

    const result = await getPrivateDb().transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(checkoutOrders)
        .where(
          and(
            eq(checkoutOrders.orderId, orderId),
            eq(checkoutOrders.purpose, "product"),
          ),
        )
        .for("update")
        .limit(1);
      if (!current || !current.fulfillmentMode?.startsWith("manual_")) {
        throw new Error("Manual fulfillment order was not found");
      }
      assertConflictToken(current, expectedConflictToken);

      if (
        (action === "pickup_complete" ||
          action === "manual_shipping_dispatch") &&
        current.paymentRiskStatus !== "cleared"
      ) {
        throw new Error("Manual handoff is blocked until payment is cleared");
      }
      // A paid cancellation queues a Square refund that is executed by the
      // shipping worker cron only when Square commerce is enabled. Require the
      // same flag here so a refund can never be durably queued yet never drained.
      if (
        action === "approve_cancellation" &&
        current.status === "paid" &&
        !isSquareCommerceCheckoutEnabled()
      ) {
        throw new Error(
          "Square commerce must be enabled to refund a paid cancellation",
        );
      }
      const transition = getManualFulfillmentTransition({
        action,
        carrier: cleanText(body?.carrier, 120),
        currentMode: current.fulfillmentMode,
        currentManualStatus: current.manualFulfillmentStatus,
        currentPaymentStatus: current.status,
        trackingNumber: cleanText(body?.trackingNumber, 160),
      });
      const occurredAt = nextUpdatedAt(current.updatedAt);
      const cancellationRefunds =
        action === "approve_cancellation" && current.status === "paid"
          ? await queueProductOrderRefundAllocationsInTransaction(tx, {
              orderReference: orderId,
              reason: `Manual fulfillment cancellation: ${rationale}`,
              requestedByAdminUserId: actor.user.id,
            })
          : [];
      if (
        action === "approve_cancellation" &&
        current.status === "paid" &&
        cancellationRefunds.length === 0
      ) {
        throw new Error("No cancellation refund was reserved");
      }
      const [event] = await tx
        .insert(productManualFulfillmentEvents)
        .values({
          actorAdminUserId: actor.user.id,
          carrier: transition.carrier,
          evidence: {
            ...evidence,
            action,
            cancellationBasis,
            refundRequired:
              action === "approve_cancellation" && current.status === "paid",
            stepUpAuthenticatedAt: stepUpAuthenticatedAt.toISOString(),
          },
          method: transition.method,
          occurredAt,
          orderId: current.id,
          rationale,
          status: transition.eventStatus,
          trackingNumber: transition.trackingNumber,
        })
        .returning({ id: productManualFulfillmentEvents.id });
      if (!event)
        throw new Error("Manual fulfillment evidence was not recorded");

      const [updated] = await tx
        .update(checkoutOrders)
        .set({
          manualFulfillmentStatus: transition.orderStatus,
          status:
            action === "approve_cancellation" && current.status !== "paid"
              ? "cancelled"
              : current.status,
          updatedAt: occurredAt,
        })
        .where(eq(checkoutOrders.id, current.id))
        .returning({
          id: checkoutOrders.id,
          manualFulfillmentStatus: checkoutOrders.manualFulfillmentStatus,
        });
      if (!updated) throw new Error("Manual fulfillment state was not updated");
      if (action === "approve_cancellation" || action === "pickup_complete") {
        await tx
          .update(orderPaymentObligations)
          .set({ status: "cancelled", updatedAt: occurredAt })
          .where(
            and(
              eq(orderPaymentObligations.orderId, current.id),
              eq(orderPaymentObligations.status, "pending"),
            ),
          );
      }
      return {
        ...updated,
        eventId: event.id,
        refundIds: cancellationRefunds.map((refund) => refund.id),
      };
    });

    await recordAdminAuditBestEffort({
      action: `fulfillment.manual_${action}`,
      actor,
      domain: "fulfillment",
      outcome: "success",
      targetId: result.id,
      targetType: "checkout_order",
      metadata: {
        eventId: result.eventId,
        refundIds: result.refundIds,
      },
    });
    return NextResponse.json(
      { ...result },
      { status: result.refundIds.length > 0 ? 202 : 200 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Manual fulfillment action failed",
      },
      { status: 409 },
    );
  }
}

async function loadManualOrder(orderReference: string) {
  const [order] = await getPrivateDb()
    .select()
    .from(checkoutOrders)
    .where(
      and(
        eq(checkoutOrders.orderId, orderReference),
        eq(checkoutOrders.purpose, "product"),
      ),
    )
    .limit(1);
  if (!order || !order.fulfillmentMode?.startsWith("manual_")) {
    throw new Error("Manual fulfillment order was not found");
  }
  return order;
}

function assertConflictToken(
  order: { id: string; updatedAt: Date },
  expected: string,
): void {
  const current = getManualFulfillmentConflictToken(order);
  if (current !== expected) {
    throw new Error(
      "Manual fulfillment state changed; refresh before retrying",
    );
  }
}

function parseAction(value: unknown): ManualAction | null {
  return [
    "approve_cancellation",
    "deny_cancellation",
    "manual_shipping_dispatch",
    "pickup_complete",
  ].includes(String(value))
    ? (value as ManualAction)
    : null;
}

function parseIrreversibleWorkType(
  value: unknown,
): "customization" | "product_preparation" | null {
  return value === "customization" || value === "product_preparation"
    ? value
    : null;
}

function parsePastInstant(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed <= new Date()
    ? parsed
    : null;
}

function parseEvidence(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const serialized = JSON.stringify(value);
  if (serialized.length < 3 || serialized.length > 8_000) return null;
  return value as Record<string, unknown>;
}

function cleanText(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function nextUpdatedAt(current: Date): Date {
  return new Date(Math.max(Date.now(), current.getTime() + 1));
}
