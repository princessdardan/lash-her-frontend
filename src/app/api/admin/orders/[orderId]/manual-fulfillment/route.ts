import { and, eq, inArray, sql } from "drizzle-orm";
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
  productPaymentRiskIncidents,
} from "@/lib/private-db/schema";
import { queueProductOrderRefundAllocationsInTransaction } from "@/lib/shipping/customer-refunds";
import {
  getManualFulfillmentConflictToken,
  getManualFulfillmentTransition,
  type ManualFulfillmentAction,
} from "@/lib/admin/manual-fulfillment-transition";
import { assertShippingPolicyMutationAllowed } from "@/lib/shipping/policy";
import {
  isManualProductCheckoutEnabled,
  isSupplementalProductPaymentsEnabled,
} from "@/lib/shipping/config";
import {
  assertHelcimProductPaymentsCertificationInTransaction,
  assertProductTaxPolicyApprovalInTransaction,
  type ProductTaxPolicyApprovalSnapshot,
} from "@/lib/shipping/readiness";
import {
  issueSupplementalPaymentOfferInTransaction,
  supplementalPaymentPublicOrigin,
} from "@/lib/commerce/supplemental-payment-offers";
import {
  assertConfiguredFulfillmentOwner,
  assertConfiguredFulfillmentOwnerInTransaction,
} from "@/lib/shipping/configured-owner";
import { p10TerminationBlocksOrderInTransaction } from "@/lib/shipping/p10-termination";

type ManualAction = ManualFulfillmentAction | "deny_cancellation";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orderId: string }> },
): Promise<Response> {
  const actor = await requirePermission("fulfillment:manage");
  await assertConfiguredFulfillmentOwner(actor.user.id);
  try {
    assertShippingPolicyMutationAllowed();
  } catch {
    return NextResponse.json(
      { error: "Shipping policy mutations require enforce mode" },
      { status: 409 },
    );
  }
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
  const shippingAmountCents = Number(body?.shippingAmountCents);
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
  if (
    action === "manual_shipping_agreement" &&
    (!Number.isInteger(shippingAmountCents) || shippingAmountCents <= 0)
  ) {
    return NextResponse.json(
      { error: "A positive agreed shipping amount in cents is required" },
      { status: 400 },
    );
  }
  if (
    action === "manual_shipping_agreement" &&
    (!isManualProductCheckoutEnabled() ||
      !isSupplementalProductPaymentsEnabled())
  ) {
    return NextResponse.json(
      { error: "Manual supplemental payments are disabled" },
      { status: 409 },
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
        if (
          await p10TerminationBlocksOrderInTransaction(
            tx,
            current.id,
            new Date(),
          )
        ) {
          throw new Error(
            "Cancellation denial is blocked because pre-cap order termination has begun",
          );
        }
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
        action !== "approve_cancellation" &&
        (await p10TerminationBlocksOrderInTransaction(
          tx,
          current.id,
          new Date(),
        ))
      ) {
        throw new Error(
          "Manual fulfillment is blocked because pre-cap order termination has begun",
        );
      }

      if (
        action === "pickup_complete" ||
        action === "manual_shipping_dispatch"
      ) {
        const activeIncidents = await tx
          .select({ id: productPaymentRiskIncidents.id })
          .from(productPaymentRiskIncidents)
          .where(
            and(
              eq(productPaymentRiskIncidents.orderId, current.id),
              inArray(productPaymentRiskIncidents.status, [
                "pending",
                "review_required",
              ]),
            ),
          )
          .for("update");
        if (
          current.paymentRiskStatus !== "cleared" ||
          activeIncidents.length > 0
        ) {
          throw new Error(
            "Manual handoff is blocked until every payment-risk incident is cleared",
          );
        }
      }

      if (action === "manual_shipping_dispatch") {
        const [agreement] = await tx
          .select({ id: productManualFulfillmentEvents.id })
          .from(productManualFulfillmentEvents)
          .where(
            and(
              eq(productManualFulfillmentEvents.orderId, current.id),
              sql`${productManualFulfillmentEvents.evidence}->>'action' = 'manual_shipping_agreement'`,
            ),
          )
          .limit(1);
        if (!agreement) {
          throw new Error(
            "Manual shipping dispatch requires a recorded customer agreement",
          );
        }
        const shippingObligations = await tx
          .select({
            id: orderPaymentObligations.id,
            status: orderPaymentObligations.status,
          })
          .from(orderPaymentObligations)
          .where(
            and(
              eq(orderPaymentObligations.orderId, current.id),
              eq(orderPaymentObligations.purpose, "manual_shipping"),
            ),
          );
        const currentShippingObligations = shippingObligations.filter(
          (obligation) =>
            !["cancelled", "superseded", "refunded"].includes(
              obligation.status,
            ),
        );
        if (
          currentShippingObligations.length !== 1 ||
          currentShippingObligations[0]?.status !== "paid"
        ) {
          throw new Error(
            "Manual shipping payment must be complete before dispatch",
          );
        }
      }

      if (action === "manual_shipping_agreement") {
        if (!current.shippingPolicyVersion || !current.taxPolicyVersion) {
          throw new Error(
            "Manual shipping payment requires immutable policy and tax snapshots",
          );
        }
        const currentObligations = await tx
          .select({ status: orderPaymentObligations.status })
          .from(orderPaymentObligations)
          .where(
            and(
              eq(orderPaymentObligations.orderId, current.id),
              eq(orderPaymentObligations.purpose, "manual_shipping"),
            ),
          )
          .for("update");
        if (
          currentObligations.some(
            (obligation) =>
              !["cancelled", "superseded", "refunded"].includes(
                obligation.status,
              ),
          )
        ) {
          throw new Error(
            "A current manual shipping obligation already exists",
          );
        }
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
      const helcimContract =
        action === "manual_shipping_agreement"
          ? await assertHelcimProductPaymentsCertificationInTransaction(
              tx,
              occurredAt,
            )
          : null;
      const taxPolicyApproval =
        action === "manual_shipping_agreement"
          ? await loadAndAssertPrimaryTaxPolicyApproval(
              tx,
              current.id,
              occurredAt,
            )
          : null;
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

      const [supplementalObligation] =
        action === "manual_shipping_agreement"
          ? await tx
              .insert(orderPaymentObligations)
              .values({
                orderId: current.id,
                purpose: "manual_shipping",
                status: "pending",
                merchandiseAmountCents: 0,
                shippingAmountCents,
                taxAmountCents: 0,
                totalAmountCents: shippingAmountCents,
                currency: current.currency,
                sourceWorkflow: `manual_shipping/${event.id}`,
                sourceReferenceId: event.id,
                disclosureSnapshot: {
                  helcimContract,
                  taxPolicyApproval,
                  agreementEvidence: evidence,
                  agreedAmountCents: shippingAmountCents,
                  agreedAt: occurredAt.toISOString(),
                },
                taxPolicyVersion: current.taxPolicyVersion!,
                policyVersion: current.shippingPolicyVersion!,
                expiresAt: new Date(occurredAt.getTime() + 24 * 60 * 60_000),
                idempotencyKey: `manual-shipping/${current.id}/${event.id}`,
                initializationStatus: "initializing",
              })
              .returning({ id: orderPaymentObligations.id })
          : [];
      if (action === "manual_shipping_agreement" && !supplementalObligation) {
        throw new Error("Manual shipping obligation was not reserved");
      }
      const paymentOffer = supplementalObligation
        ? await issueSupplementalPaymentOfferInTransaction(tx, {
            obligationId: supplementalObligation.id,
            notificationOrigin: supplementalPaymentPublicOrigin(),
            now: occurredAt,
          })
        : null;

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
        supplementalObligationId: supplementalObligation?.id ?? null,
        paymentOfferDecisionId: paymentOffer?.decisionId ?? null,
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
        paymentOfferDecisionId: result.paymentOfferDecisionId,
      },
    });
    return NextResponse.json(
      {
        ...result,
        operationId: result.supplementalObligationId,
        operationStatus: result.supplementalObligationId ? "queued" : null,
      },
      {
        status:
          result.refundIds.length > 0 || result.supplementalObligationId
            ? 202
            : 200,
      },
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

async function loadAndAssertPrimaryTaxPolicyApproval(
  tx: Parameters<
    Parameters<ReturnType<typeof getPrivateDb>["transaction"]>[0]
  >[0],
  orderId: string,
  now: Date,
): Promise<ProductTaxPolicyApprovalSnapshot> {
  const [primary] = await tx
    .select({ disclosure: orderPaymentObligations.disclosureSnapshot })
    .from(orderPaymentObligations)
    .where(
      and(
        eq(orderPaymentObligations.orderId, orderId),
        eq(orderPaymentObligations.purpose, "primary"),
      ),
    )
    .limit(1);
  const expected = primary?.disclosure?.taxPolicyApproval;
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
    throw new Error(
      "Manual shipping requires the immutable tax approval snapshot",
    );
  }
  return assertProductTaxPolicyApprovalInTransaction(
    tx,
    expected as unknown as ProductTaxPolicyApprovalSnapshot,
    now,
  );
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
    "manual_shipping_agreement",
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
