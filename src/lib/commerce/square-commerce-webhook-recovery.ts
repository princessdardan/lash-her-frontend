import type {
  FinalizeSquareProductPaymentInput,
  FinalizeSquareProductPaymentResult,
} from "@/lib/commerce/square-product-finalizer";
import type {
  FinalizeSquareTrainingCardPaymentInput,
  FinalizeSquareTrainingCardPaymentResult,
} from "@/lib/commerce/square-training-card-finalizer";
import type {
  FinalizeSquareSupplementalObligationInput,
  FinalizeSquareSupplementalObligationResult,
} from "@/lib/commerce/square-supplemental-finalizer";

const SQUARE_COMPLETED_STATUS = "COMPLETED";

export type SquareCommerceOrderKind =
  | "product"
  | "training_card"
  | "supplemental_obligation";

export interface RecoverSquareCommercePaymentInput {
  orderReference: string;
  kind: SquareCommerceOrderKind;
  squarePaymentId: string;
  status: string;
  amountCents: number;
  currency: string;
  sourceType?: string;
}

/**
 * - recovered: the order was finalized by this event (was still pending).
 * - duplicate: already finalized; side effect re-driven idempotently.
 * - ignored: not a completed payment; nothing to do.
 * - retryable: a transient side-effect failure — the webhook should be retried.
 * - conflict: the payment did not match the order (amount/id/state); terminal.
 */
export type SquareCommerceRecoveryStatus =
  | "recovered"
  | "duplicate"
  | "ignored"
  | "retryable"
  | "conflict";

export interface SquareCommerceRecoveryResult {
  status: SquareCommerceRecoveryStatus;
  reason?: string;
}

export interface RecoverSquareCommercePaymentDependencies {
  finalizeProduct: (
    input: FinalizeSquareProductPaymentInput,
  ) => Promise<FinalizeSquareProductPaymentResult>;
  sendProductConfirmationEmail: (orderReference: string) => Promise<void>;
  finalizeTraining: (
    input: FinalizeSquareTrainingCardPaymentInput,
  ) => Promise<FinalizeSquareTrainingCardPaymentResult>;
  sendTrainingNotifications: (orderReference: string) => Promise<void>;
  finalizeSupplemental: (
    input: FinalizeSquareSupplementalObligationInput,
  ) => Promise<FinalizeSquareSupplementalObligationResult>;
  logError: (message: string, meta: Record<string, unknown>) => void;
}

/**
 * Reconcile a signature-verified Square `payment.*` event back to a product or
 * training-card order. Idempotent: re-drives the money-ledger finalizer (which
 * verifies amount/currency and dedupes on the Square payment id) and re-runs the
 * order's success side effect (confirmation email / scheduling notifications).
 * Recovers the failure modes the synchronous charge cannot: a side effect that
 * failed after payment, or a capture our request could not confirm.
 */
export async function recoverSquareCommercePayment(
  input: RecoverSquareCommercePaymentInput,
  dependencies: RecoverSquareCommercePaymentDependencies,
): Promise<SquareCommerceRecoveryResult> {
  if (input.status.toUpperCase() !== SQUARE_COMPLETED_STATUS) {
    return { status: "ignored", reason: "payment_not_completed" };
  }

  const providerType = input.sourceType ?? "CARD";

  // Supplemental top-ups (shipping / address increase) finalize an obligation,
  // not an order, and have no email/notification side effect.
  if (input.kind === "supplemental_obligation") {
    const { transition } = await dependencies.finalizeSupplemental({
      obligationId: input.orderReference,
      squarePaymentId: input.squarePaymentId,
      amountCents: input.amountCents,
      currency: input.currency,
      providerType,
      providerStatus: SQUARE_COMPLETED_STATUS,
    });
    if (transition === "applied") return { status: "recovered" };
    if (transition === "already_applied") return { status: "duplicate" };
    // Payment for a closed offer: recorded + refund reserved. Acknowledged.
    if (transition === "late_capture_refunded") return { status: "recovered" };
    dependencies.logError("[square-webhook] commerce recovery conflict", {
      orderReference: input.orderReference,
      kind: input.kind,
      transition,
      squarePaymentId: input.squarePaymentId,
    });
    return { status: "conflict", reason: transition };
  }

  const finalizeInput = {
    orderReference: input.orderReference,
    squarePaymentId: input.squarePaymentId,
    amountCents: input.amountCents,
    currency: input.currency,
    providerType,
    providerStatus: SQUARE_COMPLETED_STATUS,
  };

  const transition =
    input.kind === "product"
      ? (await dependencies.finalizeProduct(finalizeInput)).transition
      : (await dependencies.finalizeTraining(finalizeInput)).transition;

  // A captured payment that landed on a terminal (e.g. abandoned-stock-swept)
  // product order is a late capture: the product finalizer recorded the money
  // and reserved a compensating refund. Acknowledge it WITHOUT the order-success
  // side effect — the order is cancelled/refunded, so a confirmation email/
  // notification would be wrong. (Only the product finalizer emits this; the
  // training finalizer cannot.)
  if (transition === "late_capture_refunded") {
    return { status: "recovered" };
  }

  if (transition !== "applied" && transition !== "already_applied") {
    dependencies.logError("[square-webhook] commerce recovery conflict", {
      orderReference: input.orderReference,
      kind: input.kind,
      transition,
      squarePaymentId: input.squarePaymentId,
    });
    return { status: "conflict", reason: transition };
  }

  const runSideEffect =
    input.kind === "product"
      ? dependencies.sendProductConfirmationEmail
      : dependencies.sendTrainingNotifications;

  try {
    await runSideEffect(input.orderReference);
  } catch (error) {
    dependencies.logError(
      "[square-webhook] commerce side-effect recovery failed",
      {
        orderReference: input.orderReference,
        kind: input.kind,
        error: error instanceof Error ? error.message : "Unknown error",
      },
    );
    return { status: "retryable", reason: "side_effect_failed" };
  }

  return {
    status: transition === "applied" ? "recovered" : "duplicate",
  };
}
