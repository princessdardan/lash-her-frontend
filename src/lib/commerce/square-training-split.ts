import type {
  SquareCreatePaymentRequest,
  SquarePayment,
} from "@/lib/payments/square/payments-client";
import {
  validateTrainingSplitPayment,
  type TrainingSplitPayment,
} from "@/lib/payments/square/training-split-policy";

export interface TrainingSplitState {
  afterpayAmountCents: number;
  cardAmountCents: number;
  squareOrderId?: string;
  cardPaymentId?: string;
  afterpayPaymentId?: string;
  stage:
    | "reserved"
    | "authorizing_card"
    | "authorizing_afterpay"
    | "capturing"
    | "completing"
    | "canceling"
    | "canceled"
    | "paid";
}

export type TrainingSplitResult =
  | { ok: true; squarePaymentId: string; transition: string }
  | { ok: false; reason: string; retryWithNewReservation: boolean };

export interface TrainingSplitDependencies {
  // The caller serializes the whole operation per order. Saves are durable even
  // if the request exits before releasing that lock. Payment tokens are not stored.
  load(): Promise<TrainingSplitState>;
  save(state: TrainingSplitState): Promise<void>;
  createOrder(): Promise<string>;
  authorize(request: SquareCreatePaymentRequest): Promise<SquarePayment>;
  getPayment(id: string): Promise<SquarePayment>;
  payOrder(orderId: string, paymentIds: string[], key: string): Promise<void>;
  complete(id: string): Promise<void>;
  cancel(id: string): Promise<void>;
  cancelByKey(key: string): Promise<void>;
  finalize(state: TrainingSplitState): Promise<void>;
  notify(): Promise<void>;
  logError(reason: string): void;
}

export function trainingSplitKey(reference: string, step: string): string {
  return `training-split/${reference}/${step}`;
}

/** One enrollment, two authorized tenders, one PayOrder. Never finalize a portion. */
export async function chargeTrainingSplit(
  input: {
    orderReference: string;
    amountCents: number;
    payment?: TrainingSplitPayment;
  },
  deps: TrainingSplitDependencies,
): Promise<TrainingSplitResult> {
  const state = await deps.load();
  const failure = (
    reason: string,
    retryWithNewReservation = false,
  ): TrainingSplitResult => ({ ok: false, reason, retryWithNewReservation });
  if (
    input.payment &&
    (validateTrainingSplitPayment(input.payment, input.amountCents) ||
      input.payment.afterpayAmountCents !== state.afterpayAmountCents)
  )
    return failure("split_amount_mismatch");
  if (
    validateTrainingSplitPayment(
      {
        expectedAmountCents: input.amountCents,
        afterpayAmountCents: state.afterpayAmountCents,
      },
      input.amountCents,
    ) ||
    state.cardAmountCents + state.afterpayAmountCents !== input.amountCents
  )
    return failure("split_amount_mismatch");

  const saveStage = async (stage: TrainingSplitState["stage"]) => {
    state.stage = stage;
    await deps.save({ ...state });
  };
  const notify = async () => {
    await deps.notify();
  };
  const paid = async (): Promise<TrainingSplitResult> => {
    await deps.finalize({ ...state, stage: "paid" });
    await notify();
    return {
      ok: true,
      squarePaymentId: state.afterpayPaymentId!,
      transition: "applied",
    };
  };
  const matches = (p: SquarePayment, leg: "card" | "afterpay") =>
    p.id === (leg === "card" ? state.cardPaymentId : state.afterpayPaymentId) &&
    p.order_id === state.squareOrderId &&
    p.reference_id === input.orderReference &&
    p.amount_money.currency === "CAD" &&
    p.amount_money.amount ===
      (leg === "card" ? state.cardAmountCents : state.afterpayAmountCents) &&
    p.source_type === (leg === "card" ? "CARD" : "BUY_NOW_PAY_LATER");

  const cancel = async (): Promise<TrainingSplitResult> => {
    await saveStage("canceling");
    // Try both even when one cancellation fails. Never rotate the reservation
    // until BOTH authorizations (including unknown outcomes) are cancelled.
    const results = await Promise.allSettled(
      (["card", "afterpay"] as const).map(async (leg) => {
        const id =
          leg === "card" ? state.cardPaymentId : state.afterpayPaymentId;
        if (id) await deps.cancel(id);
        else
          await deps.cancelByKey(trainingSplitKey(input.orderReference, leg));
      }),
    );
    if (results.some((r) => r.status === "rejected"))
      return failure("split_cancellation_pending");
    await saveStage("canceled");
    return failure("split_payment_canceled", true);
  };

  if (state.stage === "paid") {
    await notify();
    return {
      ok: true,
      squarePaymentId: state.afterpayPaymentId!,
      transition: "already_applied",
    };
  }
  if (state.stage === "canceled")
    return failure("split_payment_canceled", true);

  try {
    if (state.stage === "canceling") return await cancel();
    // An interrupted authorization may have succeeded without returning its ID.
    // Do not reuse a new nonce against that payment key; cancel by key first.
    if (
      (state.stage === "authorizing_card" && !state.cardPaymentId) ||
      (state.stage === "authorizing_afterpay" && !state.afterpayPaymentId)
    )
      return await cancel();

    if (!state.squareOrderId) {
      if (!input.payment) return await cancel();
      state.squareOrderId = await deps.createOrder();
      await deps.save({ ...state });
    }
    for (const leg of ["card", "afterpay"] as const) {
      const field = leg === "card" ? "cardPaymentId" : "afterpayPaymentId";
      if (state[field]) continue;
      if (!input.payment) return await cancel();
      await saveStage(
        leg === "card" ? "authorizing_card" : "authorizing_afterpay",
      );
      const source = input.payment[leg];
      const payment = await deps.authorize({
        idempotency_key: trainingSplitKey(input.orderReference, leg),
        source_id: source.sourceId,
        ...(source.verificationToken
          ? { verification_token: source.verificationToken }
          : {}),
        reference_id: input.orderReference,
        order_id: state.squareOrderId,
        autocomplete: false,
        amount_money: {
          amount:
            leg === "card" ? state.cardAmountCents : state.afterpayAmountCents,
          currency: "CAD",
        },
      });
      state[field] = payment.id;
      await deps.save({ ...state });
      if (
        !matches(payment, leg) ||
        !["APPROVED", "AUTHORIZED"].includes(payment.status)
      )
        return await cancel();
    }

    const readPayments = () =>
      Promise.all([
        deps.getPayment(state.cardPaymentId!),
        deps.getPayment(state.afterpayPaymentId!),
      ]);
    let [card, afterpay] = await readPayments();
    if (!matches(card, "card") || !matches(afterpay, "afterpay"))
      throw new Error("split_provider_mismatch");
    if (card.status === "COMPLETED" && afterpay.status === "COMPLETED") {
      await saveStage("capturing");
      return await paid();
    }
    if (
      [card, afterpay].some((p) => ["CANCELED", "FAILED"].includes(p.status))
    ) {
      if ([card, afterpay].some((p) => p.status === "COMPLETED")) {
        deps.logError("split_payment_requires_review");
        return failure("split_payment_requires_review");
      }
      return await cancel();
    }
    if (
      [card, afterpay].some(
        (p) => !["APPROVED", "AUTHORIZED", "COMPLETED"].includes(p.status),
      )
    )
      return failure("split_capture_pending");
    if (state.stage !== "completing") {
      await saveStage("capturing");
      await deps.payOrder(
        state.squareOrderId,
        [state.cardPaymentId!, state.afterpayPaymentId!],
        trainingSplitKey(input.orderReference, "pay"),
      );
      // Square Sandbox can report a completed order while its Payment records
      // remain APPROVED. Complete those same IDs; never mint new payments.
      await saveStage("completing");
    }
    [card, afterpay] = await readPayments();
    for (const [leg, payment] of [
      ["card", card],
      ["afterpay", afterpay],
    ] as const) {
      if (!matches(payment, leg)) throw new Error("split_provider_mismatch");
      if (["APPROVED", "AUTHORIZED"].includes(payment.status))
        await deps.complete(payment.id);
    }
    [card, afterpay] = await readPayments();
    if (
      !matches(card, "card") ||
      !matches(afterpay, "afterpay") ||
      card.status !== "COMPLETED" ||
      afterpay.status !== "COMPLETED"
    )
      return failure("split_capture_pending");
    return await paid();
  } catch {
    deps.logError(`split_${state.stage}_failed`);
    // PayOrder or local finalization may have succeeded. Preserve both IDs and
    // the reservation for webhook/retry recovery; never re-authorize here.
    if (state.stage === "capturing" || state.stage === "completing")
      return failure("split_capture_pending");
    try {
      return await cancel();
    } catch {
      return failure("split_cancellation_pending");
    }
  }
}
