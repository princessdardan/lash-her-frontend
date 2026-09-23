"use client";

import { useEffect, useId, useRef, useState } from "react";

import { loadSquareScript } from "@/components/booking/square-card-on-file-form";
import {
  isSquareAfterpayAmountEligible,
  SQUARE_AFTERPAY_LIMIT_MESSAGE,
  type SquareCheckoutPayment,
} from "@/lib/payments/square/afterpay-policy";

interface Afterpay {
  attach(selector: string): Promise<void>;
  destroy(): Promise<boolean>;
  tokenize(): Promise<{
    status: string;
    token?: string;
    errors?: Array<{ message?: string }>;
  }>;
}

interface AfterpayPayments {
  setLocale?(locale: string): void | Promise<void>;
  paymentRequest(options: {
    countryCode: "CA";
    currencyCode: "CAD";
    requestShippingContact: false;
    total: { amount: string; label: string };
  }): unknown;
  afterpayClearpay(request: unknown): Promise<Afterpay>;
}

interface SquareAfterpayButtonProps {
  amountCents: number;
  configUrl?: string;
  title?: string;
  description?: string;
  disabled: boolean;
  /** Synchronous lock shared with the card button. Keeps popup user activation. */
  onStart: () => boolean;
  onEnd: () => void;
  onError: (message: string) => void;
  onTokenized: (payment: SquareCheckoutPayment) => Promise<void>;
}

/** Shared by products, training, bookings, and future digital-course checkout. */
export function SquareAfterpayButton({
  amountCents,
  configUrl = "/api/checkout/square/config",
  title = "Buy now, pay later with Afterpay",
  description = SQUARE_AFTERPAY_LIMIT_MESSAGE,
  disabled,
  onStart,
  onEnd,
  onError,
  onTokenized,
}: SquareAfterpayButtonProps) {
  const id = `square-afterpay-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const methodRef = useRef<Afterpay | null>(null);
  const busyRef = useRef(false);
  const [availability, setAvailability] = useState<{
    amountCents: number;
    configUrl: string;
    status: "ready" | "unavailable";
  } | null>(null);
  const status =
    availability?.amountCents === amountCents &&
    availability.configUrl === configUrl
      ? availability.status
      : "loading";
  const eligible = isSquareAfterpayAmountEligible(amountCents);

  useEffect(() => {
    if (!eligible) return;
    let cancelled = false;
    let method: Afterpay | null = null;
    async function initialize() {
      try {
        const response = await fetch(configUrl, { cache: "no-store" });
        if (!response.ok) throw new Error("Configuration unavailable");
        const config = await response.json();
        await loadSquareScript(config.scriptUrl);
        if (cancelled) return;
        const square = (
          window as unknown as {
            Square?: {
              payments(
                appId: string,
                locationId: string,
              ): AfterpayPayments | Promise<AfterpayPayments>;
            };
          }
        ).Square;
        if (!square) throw new Error("Square unavailable");
        const payments = await square.payments(
          config.applicationId,
          config.locationId,
        );
        await payments.setLocale?.(config.locale);
        const request = payments.paymentRequest({
          countryCode: "CA",
          currencyCode: "CAD",
          // Shipping is selected and priced by our checkout before this sheet.
          requestShippingContact: false,
          total: { amount: (amountCents / 100).toFixed(2), label: "Total" },
        });
        // Square rejects ineligible sellers/amounts here. Card entry stays usable.
        method = await payments.afterpayClearpay(request);
        if (cancelled) {
          await method.destroy();
          return;
        }
        await method.attach(`#${id}`);
        if (cancelled) {
          await method.destroy();
          return;
        }
        methodRef.current = method;
        setAvailability({ amountCents, configUrl, status: "ready" });
      } catch {
        if (method) await method.destroy().catch(() => false);
        if (!cancelled)
          setAvailability({ amountCents, configUrl, status: "unavailable" });
      }
    }
    void initialize();
    return () => {
      cancelled = true;
      methodRef.current = null;
      if (method) void method.destroy().catch(() => false);
    };
  }, [amountCents, configUrl, eligible, id]);

  async function pay() {
    const method = methodRef.current;
    if (
      disabled ||
      busyRef.current ||
      !method ||
      status !== "ready" ||
      !onStart()
    )
      return;
    busyRef.current = true;
    let completed = false;
    try {
      // Must be invoked directly from the click, before any asynchronous work.
      const result = await method.tokenize();
      if (result.status === "Cancel") return;
      if (result.status !== "OK" || !result.token) {
        throw new Error(
          result.errors
            ?.map((error) => error.message)
            .filter(Boolean)
            .join("; ") ||
            "Afterpay could not approve this payment. Try again or pay by card.",
        );
      }
      if (methodRef.current !== method)
        throw new Error("Your total changed. Please try Afterpay again.");
      await onTokenized({
        sourceId: result.token,
        method: "afterpay",
        expectedAmountCents: amountCents,
      });
      completed = true;
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Afterpay payment could not be completed.",
      );
    } finally {
      // Keep both payment buttons locked until success navigation unmounts us.
      if (!completed) {
        busyRef.current = false;
        onEnd();
      }
    }
  }

  return (
    <div className="space-y-3 border-t border-lh-line pt-4">
      <p className="font-body text-sm font-medium text-lh-primary">{title}</p>
      <p className="text-xs leading-5 text-lh-muted">{description}</p>
      {eligible ? (
        <>
          <fieldset
            disabled={disabled || status !== "ready"}
            aria-label="Pay with Afterpay"
            className="min-w-0 disabled:opacity-60"
          >
            <div id={id} onClick={pay} />
          </fieldset>
          {status === "loading" && (
            <p role="status" className="text-xs text-lh-muted">
              Checking Afterpay availability...
            </p>
          )}
          {status === "unavailable" && (
            <p role="status" className="text-xs text-lh-muted">
              Afterpay is unavailable for this checkout. You can pay by card.
            </p>
          )}
        </>
      ) : null}
    </div>
  );
}
