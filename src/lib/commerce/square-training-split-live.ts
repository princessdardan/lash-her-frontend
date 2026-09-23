import "server-only";

import { and, asc, eq, lt, sql } from "drizzle-orm";
import { getPrivateDb } from "@/lib/private-db/client";
import { checkoutOrders } from "@/lib/private-db/schema";
import {
  getSquareCommerceEnv,
  isPaymentMockMode,
} from "@/lib/env/private-checkout";
import {
  createSquarePaymentsClient,
  createSquareSplitOrdersClient,
  type SquarePayment,
} from "@/lib/payments/square/payments-client";
import type { TrainingSplitPayment } from "@/lib/payments/square/training-split-policy";
import {
  chargeTrainingSplit,
  trainingSplitKey,
  type TrainingSplitResult,
  type TrainingSplitState,
} from "./square-training-split";
import { notifyPaidTrainingOrder } from "./training-paid-notification";

export async function chargeLiveTrainingSplit(input: {
  orderReference: string;
  amountCents?: number;
  payment?: TrainingSplitPayment;
  origin?: string;
}): Promise<TrainingSplitResult> {
  const env = getSquareCommerceEnv();
  if (!env)
    return {
      ok: false,
      reason: "square_commerce_disabled",
      retryWithNewReservation: false,
    };
  const db = getPrivateDb();
  const payments = createSquarePaymentsClient(env);
  const orders = createSquareSplitOrdersClient(env);
  // Transaction-scoped advisory lock works through transaction poolers. State
  // writes use the base DB and commit independently, surviving request crashes.
  // No row locks are held across Square calls. Contenders fail fast and retry.
  return db.transaction(async (lock) => {
    const result = await lock.execute(
      sql`select pg_try_advisory_xact_lock(hashtextextended(${`training-split/${input.orderReference}`}, 0)) as locked`,
    );
    if (result.rows[0]?.locked !== true)
      return {
        ok: false,
        reason: "split_payment_in_progress",
        retryWithNewReservation: false,
      };
    const [order] = await db
      .select()
      .from(checkoutOrders)
      .where(
        and(
          eq(checkoutOrders.orderId, input.orderReference),
          eq(checkoutOrders.purpose, "training"),
          eq(checkoutOrders.paymentProvider, "square"),
        ),
      )
      .limit(1);
    if (
      !order ||
      order.providerMetadata?.flow !== "training_square_split" ||
      (input.amountCents !== undefined &&
        order.amountCents !== input.amountCents)
    )
      throw new Error("Training split reservation does not match");
    const initial = order.providerMetadata.splitPayment as
      | TrainingSplitState
      | undefined;
    if (
      !initial ||
      ![
        "reserved",
        "authorizing_card",
        "authorizing_afterpay",
        "capturing",
        "completing",
        "canceling",
        "canceled",
        "paid",
      ].includes(initial.stage) ||
      (order.status !== "pending" &&
        order.status !== "paid" &&
        initial.stage !== "canceled")
    )
      throw new Error("Invalid training split state");
    if (
      initial.stage === "paid" &&
      (order.status !== "paid" ||
        !initial.cardPaymentId ||
        !initial.afterpayPaymentId)
    )
      throw new Error("Incomplete training split receipt");
    let current = { ...initial };
    const save = async (state: TrainingSplitState) => {
      const updated = await db
        .update(checkoutOrders)
        .set({
          providerOrderId: state.squareOrderId ?? null,
          providerMetadata: { ...order.providerMetadata, splitPayment: state },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(checkoutOrders.id, order.id),
            eq(checkoutOrders.status, "pending"),
          ),
        )
        .returning({ id: checkoutOrders.id });
      if (!updated.length) throw new Error("Training split state changed");
      current = { ...state };
    };
    const mock = isPaymentMockMode();
    const mockPayment = (id: string, completed = false): SquarePayment => {
      const card = id.endsWith("/card");
      return {
        id,
        status:
          completed || ["capturing", "completing"].includes(current.stage)
            ? "COMPLETED"
            : "APPROVED",
        order_id: current.squareOrderId,
        reference_id: input.orderReference,
        source_type: card ? "CARD" : "BUY_NOW_PAY_LATER",
        amount_money: {
          amount: card ? current.cardAmountCents : current.afterpayAmountCents,
          currency: "CAD",
        },
      };
    };
    return chargeTrainingSplit(
      { ...input, amountCents: order.amountCents },
      {
        load: async () => ({ ...current }),
        save,
        createOrder: () =>
          mock
            ? Promise.resolve(`mock-order-${order.orderId}`)
            : orders.create(
                order.orderId,
                order.amountCents,
                trainingSplitKey(order.orderId, "order"),
              ),
        authorize: async (request) =>
          mock
            ? mockPayment(`mock-${request.idempotency_key}`)
            : (await payments.createCardOnFilePayment(request)).payment,
        getPayment: async (id) =>
          mock ? mockPayment(id) : (await payments.getPayment(id)).payment,
        payOrder: async (id, ids, key) => {
          if (!mock) await orders.pay(id, ids, key);
        },
        complete: async (id) => {
          if (!mock) await payments.completePayment(id);
        },
        cancel: async (id) => {
          if (mock) return;
          const existing = (await payments.getPayment(id)).payment;
          if (["FAILED", "CANCELED"].includes(existing.status)) return;
          const canceled = (await payments.cancelPayment(id)).payment;
          if (canceled.status !== "CANCELED")
            throw new Error("Payment cancellation unconfirmed");
        },
        cancelByKey: (key) =>
          mock
            ? Promise.resolve()
            : payments.cancelPaymentByIdempotencyKey(key),
        finalize: async (state) => {
          if (
            !state.cardPaymentId ||
            !state.afterpayPaymentId ||
            !state.squareOrderId
          )
            throw new Error("Incomplete split payment evidence");
          const updated = await db
            .update(checkoutOrders)
            .set({
              status: "paid",
              providerStatus: "COMPLETED",
              paidAt: new Date(),
              providerPaymentId: state.afterpayPaymentId,
              providerOrderId: state.squareOrderId,
              providerMetadata: {
                ...order.providerMetadata,
                splitPayment: state,
                finalizationStatus: "paid",
              },
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(checkoutOrders.id, order.id),
                eq(checkoutOrders.status, "pending"),
              ),
            )
            .returning({ id: checkoutOrders.id });
          if (!updated.length)
            throw new Error("Training split finalization conflict");
        },
        notify: () =>
          notifyPaidTrainingOrder(input.orderReference, input.origin),
        logError: (reason) =>
          console.error("[training-split] Payment needs reconciliation", {
            orderReference: input.orderReference,
            reason,
          }),
      },
    );
  });
}

/** Recover interrupted requests even when neither browser nor webhook returns. */
export async function reconcileTrainingSplits(now: Date): Promise<void> {
  if (!getSquareCommerceEnv()) return;
  const db = getPrivateDb();
  const pending = await db
    .select({ orderId: checkoutOrders.orderId })
    .from(checkoutOrders)
    .where(
      and(
        eq(checkoutOrders.paymentProvider, "square"),
        eq(checkoutOrders.purpose, "training"),
        eq(checkoutOrders.status, "pending"),
        sql`${checkoutOrders.providerMetadata}->>'flow' = 'training_square_split'`,
        sql`${checkoutOrders.providerMetadata}->'splitPayment'->>'stage' not in ('reserved', 'canceled', 'paid')`,
        lt(checkoutOrders.updatedAt, new Date(now.getTime() - 60_000)),
      ),
    )
    .orderBy(asc(checkoutOrders.updatedAt))
    .limit(20);
  for (const order of pending) {
    try {
      const result = await chargeLiveTrainingSplit({
        orderReference: order.orderId,
      });
      if (!result.ok && !result.retryWithNewReservation)
        console.error("[training-split] Reconciliation incomplete", {
          orderReference: order.orderId,
          reason: result.reason,
        });
    } catch {
      console.error("[training-split] Reconciliation failed", {
        orderReference: order.orderId,
      });
    }
  }
}
