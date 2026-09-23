"use client";

import {
  useCallback,
  useSyncExternalStore,
  useId,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useRouter } from "next/navigation";
import { SquareAfterpayButton } from "@/components/payments/square-afterpay-button";
import {
  SQUARE_AFTERPAY_MAX_CENTS,
  type SquareCheckoutPayment,
} from "@/lib/payments/square/afterpay-policy";
import {
  validateTrainingSplitPayment,
  type TrainingSplitPayment,
} from "@/lib/payments/square/training-split-policy";
import { Button } from "@/components/ui/button";
import {
  SquareCommerceCardForm,
  type SquareCommerceCardFormHandle,
} from "@/components/commerce/square-commerce-card-form";

interface SquareTrainingPayButtonProps {
  disabled?: boolean;
  programSlug: string;
  clientPrice: number;
  promotionCode?: string;
  amountCents: number;
  customer: { name: string; email: string };
  onPaid: () => void;
  onBusyChange?: (busy: boolean) => void;
}
interface PendingSplit {
  reservationKey: string;
  customerEmail: string;
}
const GENERIC_ERROR =
  "Unable to complete checkout. Please review your details and try again.";
const money = (cents: number) =>
  `C$${(cents / 100).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function SquareTrainingPayButton({
  disabled = false,
  programSlug,
  clientPrice,
  promotionCode,
  amountCents,
  customer,
  onPaid,
  onBusyChange,
}: SquareTrainingPayButtonProps): ReactElement {
  const router = useRouter();
  const inputId = useId();
  const formRef = useRef<SquareCommerceCardFormHandle>(null);
  const activeCardFormRef = useRef<SquareCommerceCardFormHandle | null>(null);
  const afterpayTokenRef = useRef<SquareCheckoutPayment | null>(null);
  const reservationKeyRef = useRef<string | undefined>(undefined);
  const submissionInFlightRef = useRef(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isCardReady, setIsCardReady] = useState(false);
  const [isUnavailable, setIsUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [splitSelected, setSplitSelected] = useState(false);
  const [portion, setPortion] = useState<string | null>(null);
  const [pendingOverride, setPendingOverride] = useState<
    PendingSplit | null | undefined
  >(undefined);
  const storageKey = `lash-training-split/${programSlug}`;
  const maxPortion = Math.min(SQUARE_AFTERPAY_MAX_CENTS, amountCents - 100);
  const portionText = portion ?? (maxPortion / 100).toFixed(2);
  const afterpayCents = /^\d+(\.\d{1,2})?$/.test(portionText)
    ? Math.round(Number(portionText) * 100)
    : NaN;
  const splitError = validateTrainingSplitPayment(
    { expectedAmountCents: amountCents, afterpayAmountCents: afterpayCents },
    amountCents,
  );
  const split = splitSelected && amountCents >= 200;
  const handleConfigUnavailable = useCallback(() => setIsUnavailable(true), []);

  const savedAttempt = useSyncExternalStore(
    subscribePendingAttempt,
    () => {
      try {
        return sessionStorage.getItem(storageKey);
      } catch {
        return null;
      }
    },
    () => null,
  );
  const pendingSplit =
    pendingOverride === undefined
      ? parsePendingAttempt(savedAttempt)
      : pendingOverride;

  const rememberSplit = (attempt: PendingSplit | null) => {
    setPendingOverride(attempt);
    try {
      if (attempt) sessionStorage.setItem(storageKey, JSON.stringify(attempt));
      else sessionStorage.removeItem(storageKey);
      window.dispatchEvent(new Event("lash-training-payment"));
    } catch {
      /* Do not interrupt an already-submitted payment. */
    }
  };

  const handleResponse = async (response: Response, isSplit: boolean) => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 402 && data.retryWithNewReservation === true) {
        reservationKeyRef.current = undefined;
        if (isSplit) rememberSplit(null);
      }
      throw new Error(
        typeof data.error === "string" ? data.error : GENERIC_ERROR,
      );
    }
    if (data.status !== "paid" || !data.orderId)
      throw new Error(
        "Payment could not be verified. Please contact Lash Her before retrying.",
      );
    reservationKeyRef.current = undefined;
    if (isSplit) rememberSplit(null);
    onPaid();
    router.push(
      `/training-programs/${encodeURIComponent(programSlug)}/confirmation?order=${encodeURIComponent(data.orderId)}`,
    );
  };

  const submitPayment = async (
    payment: SquareCheckoutPayment | TrainingSplitPayment,
  ) => {
    reservationKeyRef.current ??= crypto.randomUUID();
    const isSplit = payment.method === "afterpay_card";
    // Keep uncertain attempts across retries and reloads; recovery needs no new
    // payment tokens. Never switch methods while a split outcome is unresolved.
    if (isSplit)
      rememberSplit({
        reservationKey: reservationKeyRef.current,
        customerEmail: customer.email,
      });
    const response = await fetch("/api/training-checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        programSlug,
        customerName: customer.name,
        customerEmail: customer.email,
        clientPrice,
        reservationKey: reservationKeyRef.current,
        ...(promotionCode ? { promotionCode } : {}),
        payment,
      }),
    });
    // A validation rejection happens before order reservation or payment calls.
    if (isSplit && response.status === 400) rememberSplit(null);
    await handleResponse(response, isSplit);
  };

  const handleCardTokenized = async (card: SquareCheckoutPayment) => {
    const afterpay = afterpayTokenRef.current;
    if (!split) return submitPayment(card);
    if (!afterpay || splitError) throw new Error(splitError ?? GENERIC_ERROR);
    await submitPayment({
      method: "afterpay_card",
      expectedAmountCents: amountCents,
      afterpayAmountCents: afterpayCents,
      afterpay,
      card,
    });
  };
  const startPayment = () => {
    if (disabled || submissionInFlightRef.current) return false;
    submissionInFlightRef.current = true;
    activeCardFormRef.current = formRef.current;
    setError(null);
    setIsLoading(true);
    onBusyChange?.(true);
    return true;
  };
  const endPayment = () => {
    submissionInFlightRef.current = false;
    afterpayTokenRef.current = null;
    setIsLoading(false);
    onBusyChange?.(false);
  };
  const handlePay = async () => {
    if (!startPayment()) return;
    try {
      if (!activeCardFormRef.current)
        throw new Error("Secure card form is not ready.");
      await activeCardFormRef.current.tokenize();
    } catch (err) {
      setError(err instanceof Error ? err.message : GENERIC_ERROR);
      endPayment();
    }
  };
  const resume = async () => {
    if (!pendingSplit || submissionInFlightRef.current) return;
    submissionInFlightRef.current = true;
    setError(null);
    setIsLoading(true);
    onBusyChange?.(true);
    try {
      await handleResponse(
        await fetch("/api/training-checkout/split-status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(pendingSplit),
        }),
        true,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : GENERIC_ERROR);
      endPayment();
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <div
          className="rounded-[18px] border border-lh-accent/20 bg-lh-accent-soft p-3 text-sm font-bold leading-6 text-lh-accent"
          role="alert"
        >
          {error}
        </div>
      )}
      {pendingSplit ? (
        <>
          <p className="text-sm text-lh-muted">
            A payment attempt is awaiting confirmation. Check its status before
            starting another payment.
          </p>
          <Button type="button" disabled={isLoading} onClick={resume}>
            {isLoading ? "Checking payment..." : "Check payment status"}
          </Button>
        </>
      ) : isUnavailable ? (
        <div role="alert" className="text-sm text-lh-muted">
          Card checkout is temporarily unavailable. Please refresh or{" "}
          <a href="/contact" className="underline">
            contact us
          </a>
          .
        </div>
      ) : (
        <>
          {amountCents >= 200 && (
            <label className="flex items-center gap-3 text-sm font-medium text-lh-primary">
              <input
                type="checkbox"
                checked={split}
                disabled={isLoading}
                onChange={(event) => {
                  setSplitSelected(event.target.checked);
                  setError(null);
                }}
              />
              Use Afterpay + card
            </label>
          )}
          {split && (
            <div className="space-y-3 rounded-xl border border-lh-line p-4 text-sm">
              <label htmlFor={inputId}>Afterpay amount (CAD)</label>
              <input
                id={inputId}
                type="number"
                min="1"
                max={maxPortion / 100}
                step="0.01"
                value={portionText}
                disabled={isLoading}
                onChange={(event) => setPortion(event.target.value)}
                className="block w-full rounded-lg border border-lh-line p-3"
              />
              {splitError ? (
                <p role="alert">{splitError}</p>
              ) : (
                <dl className="space-y-2">
                  <div className="flex justify-between gap-4">
                    <dt>Afterpay portion</dt>
                    <dd>{money(afterpayCents)}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt>Card payment today</dt>
                    <dd>{money(amountCents - afterpayCents)}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt>Total including tax</dt>
                    <dd>{money(amountCents)}</dd>
                  </div>
                </dl>
              )}
              <p className="text-xs leading-5 text-lh-muted">
                Only the Afterpay portion is paid in installments, subject to
                approval. The remaining balance is charged to your card today.
                Afterpay may collect its first installment today.
              </p>
            </div>
          )}
          <SquareCommerceCardForm
            ref={formRef}
            buyer={{
              amountCents:
                split && !splitError
                  ? amountCents - afterpayCents
                  : amountCents,
              email: customer.email,
              fullName: customer.name,
            }}
            disabled={disabled || isLoading}
            onError={setError}
            onReadyChange={setIsCardReady}
            onConfigUnavailable={handleConfigUnavailable}
            onTokenized={handleCardTokenized}
          />
          {!split && (
            <Button
              type="button"
              onClick={handlePay}
              disabled={disabled || !isCardReady || isLoading}
              aria-busy={isLoading}
              className="h-12 w-full rounded-full bg-lh-primary px-6 font-body text-sm font-bold uppercase tracking-[0.12em] text-lh-white hover:bg-lh-accent"
            >
              {isLoading ? "Processing..." : "Pay securely"}
            </Button>
          )}
          {(!split || !splitError) && (
            <SquareAfterpayButton
              amountCents={split ? afterpayCents : amountCents}
              title={split ? "Pay the Afterpay portion" : undefined}
              description={
                split
                  ? `Afterpay is limited to C$1–C$2,000, subject to approval. Enter your card details above, then continue with Afterpay to complete both payments.`
                  : undefined
              }
              disabled={disabled || isLoading || (split && !isCardReady)}
              onStart={startPayment}
              onEnd={endPayment}
              onError={setError}
              onTokenized={async (payment) => {
                if (!split) return submitPayment(payment);
                afterpayTokenRef.current = payment;
                if (!activeCardFormRef.current)
                  throw new Error("Secure card form is not ready.");
                await activeCardFormRef.current.tokenize();
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

function subscribePendingAttempt(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener("lash-training-payment", callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener("lash-training-payment", callback);
  };
}

function parsePendingAttempt(raw: string | null): PendingSplit | null {
  try {
    const saved = JSON.parse(raw ?? "null");
    return saved &&
      typeof saved.reservationKey === "string" &&
      typeof saved.customerEmail === "string"
      ? {
          reservationKey: saved.reservationKey,
          customerEmail: saved.customerEmail,
        }
      : null;
  } catch {
    return null;
  }
}
