import type { UnfinalizedSupplementalObligation } from "@/lib/commerce/order-store";
import type {
  FinalizeSquareSupplementalObligationInput,
  FinalizeSquareSupplementalObligationResult,
} from "@/lib/commerce/square-supplemental-finalizer";

// Don't race an in-flight webhook: only reconcile obligations whose link was
// minted longer than this ago.
const DEFAULT_GRACE_MS = 5 * 60 * 1000;
// Bound the swept backlog (and the Square payments scan) to obligations created
// within this window. Comfortably longer than the supplemental offer TTL.
const DEFAULT_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 100;
const DEFAULT_PAYMENT_PAGE_LIMIT = 100;
// Backstop on the Square list scan so a pathological window can't page forever.
const MAX_PAYMENT_PAGES = 20;

export interface SupplementalCaptureReconciliationSummary {
  checked: number;
  /** Finalized fresh (obligation moved pending -> paid). */
  finalized: number;
  /** Money was already recorded on this Square payment id (idempotent re-drive). */
  alreadyFinalized: number;
  /** Payment arrived after the offer window closed -> recorded + refund reserved. */
  lateRefunded: number;
  /** No captured Square payment found yet for the obligation reference. */
  unpaid: number;
  /** Mismatch / not-found / state conflict — needs a look, not silently dropped. */
  conflict: number;
  /** Transient errors; retried on the next sweep. */
  failed: number;
}

export interface ReconcileUnfinalizedSupplementalObligationsInput {
  now: Date;
  graceMs?: number;
  lookbackMs?: number;
  limit?: number;
}

export interface CompletedSquarePaymentRef {
  paymentId: string;
  amountCents: number;
  currency: string;
  sourceType?: string;
}

export interface SupplementalCaptureReconciliationDependencies {
  findCandidates: (input: {
    mintedBefore: Date;
    horizonAfter: Date;
    limit: number;
  }) => Promise<UnfinalizedSupplementalObligation[]>;
  findCompletedPaymentByReference: (
    reference: string,
  ) => Promise<CompletedSquarePaymentRef | null>;
  finalizeSupplemental: (
    input: FinalizeSquareSupplementalObligationInput,
  ) => Promise<FinalizeSquareSupplementalObligationResult>;
  logError: (message: string, meta: Record<string, unknown>) => void;
  logWarn: (message: string, meta: Record<string, unknown>) => void;
}

/**
 * Backstop for supplemental payment obligations (manual-shipping / address-
 * increase top-ups) that the customer paid on Square but whose `payment.updated`
 * webhook never finalized locally. For each still-`pending` obligation with a
 * minted link, find the captured Square payment by `reference_id` and re-drive
 * the supplemental finalizer. The finalizer is idempotent (deduped on the Square
 * payment id) and refunds late/closed-window captures, so this pass only ever
 * *observes* a COMPLETED payment and re-drives finalization — it never captures.
 */
export async function reconcileUnfinalizedSupplementalObligations(
  input: ReconcileUnfinalizedSupplementalObligationsInput,
  dependencies: SupplementalCaptureReconciliationDependencies,
): Promise<SupplementalCaptureReconciliationSummary> {
  const graceMs = input.graceMs ?? DEFAULT_GRACE_MS;
  const lookbackMs = input.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const limit = input.limit ?? DEFAULT_LIMIT;
  const mintedBefore = new Date(input.now.getTime() - graceMs);
  const horizonAfter = new Date(input.now.getTime() - lookbackMs);

  const candidates = await dependencies.findCandidates({
    mintedBefore,
    horizonAfter,
    limit,
  });

  const summary: SupplementalCaptureReconciliationSummary = {
    checked: candidates.length,
    finalized: 0,
    alreadyFinalized: 0,
    lateRefunded: 0,
    unpaid: 0,
    conflict: 0,
    failed: 0,
  };

  for (const candidate of candidates) {
    try {
      const payment = await dependencies.findCompletedPaymentByReference(
        candidate.id,
      );
      if (payment === null) {
        // No captured Square payment for this obligation (yet) — genuinely
        // unpaid, or not visible in the scanned window. Left for a later sweep.
        summary.unpaid += 1;
        continue;
      }

      const result = await dependencies.finalizeSupplemental({
        obligationId: candidate.id,
        squarePaymentId: payment.paymentId,
        amountCents: payment.amountCents,
        currency: payment.currency,
        providerType: payment.sourceType ?? "CARD",
        providerStatus: "COMPLETED",
      });

      switch (result.transition) {
        case "applied":
          summary.finalized += 1;
          break;
        case "already_applied":
          summary.alreadyFinalized += 1;
          break;
        case "late_capture_refunded":
          summary.lateRefunded += 1;
          break;
        default:
          // amount_or_currency_mismatch | not_found | transaction_conflict |
          // state_conflict — the finalizer already alerts on the money-relevant
          // cases; surface it here too so the sweep summary is honest.
          summary.conflict += 1;
          dependencies.logError(
            "[supplemental-capture-reconciliation] obligation did not finalize cleanly",
            {
              obligationId: candidate.id,
              squarePaymentId: payment.paymentId,
              transition: result.transition,
            },
          );
      }
    } catch (error) {
      summary.failed += 1;
      dependencies.logError(
        "[supplemental-capture-reconciliation] obligation reconciliation failed",
        {
          obligationId: candidate.id,
          error: error instanceof Error ? error.message : "Unknown error",
        },
      );
    }
  }

  return summary;
}

/**
 * Live wiring for the reconciliation cron. Returns null when Square commerce is
 * not enabled (nothing to reconcile). Pages the Square payments list ONCE per
 * sweep into a reference_id -> completed-payment map (Square offers no
 * server-side reference filter), and only when there is at least one candidate.
 */
export async function runSquareSupplementalObligationCaptureReconciliation(input: {
  now: Date;
}): Promise<SupplementalCaptureReconciliationSummary | null> {
  const [
    { getSquareCommerceEnv },
    { createSquarePaymentsClient },
    { findUnfinalizedSupplementalObligations },
    { finalizeSquareSupplementalObligation },
    { log },
  ] = await Promise.all([
    import("@/lib/env/private-checkout"),
    import("@/lib/payments/square/payments-client"),
    import("@/lib/commerce/order-store"),
    import("@/lib/commerce/square-supplemental-finalizer"),
    import("@/lib/logging/logger"),
  ]);

  const env = getSquareCommerceEnv();
  if (env === null) {
    return null;
  }

  const client = createSquarePaymentsClient(env);
  const graceMs = DEFAULT_GRACE_MS;
  const lookbackMs = DEFAULT_LOOKBACK_MS;
  const windowBegin = new Date(input.now.getTime() - lookbackMs).toISOString();
  const windowEnd = new Date(input.now.getTime() - graceMs).toISOString();

  const completedByReference = new Map<string, CompletedSquarePaymentRef>();
  let paymentsLoaded = false;

  async function ensurePaymentsLoaded(): Promise<void> {
    if (paymentsLoaded) return;
    paymentsLoaded = true;
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAYMENT_PAGES; page += 1) {
      const response = await client.listPayments({
        beginTime: windowBegin,
        endTime: windowEnd,
        sortOrder: "DESC",
        limit: DEFAULT_PAYMENT_PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      });
      for (const payment of response.payments) {
        if (payment.status.toUpperCase() !== "COMPLETED") continue;
        if (!payment.reference_id) continue;
        // Keep the first (most recent, since DESC) completed payment per ref.
        if (!completedByReference.has(payment.reference_id)) {
          completedByReference.set(payment.reference_id, {
            paymentId: payment.id,
            amountCents: payment.amount_money.amount,
            currency: payment.amount_money.currency,
            ...(payment.source_type ? { sourceType: payment.source_type } : {}),
          });
        }
      }
      if (!response.cursor) break;
      cursor = response.cursor;
    }
  }

  return reconcileUnfinalizedSupplementalObligations(
    { now: input.now, graceMs, lookbackMs },
    {
      findCandidates: findUnfinalizedSupplementalObligations,
      findCompletedPaymentByReference: async (reference) => {
        await ensurePaymentsLoaded();
        return completedByReference.get(reference) ?? null;
      },
      finalizeSupplemental: finalizeSquareSupplementalObligation,
      logError: (message, meta) => log("error", message, meta),
      logWarn: (message, meta) => log("warn", message, meta),
    },
  );
}
