"use client";

import { useState, useEffect, type ReactElement } from "react";
import Script from "next/script";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { getHelcimPayEventOutcome } from "@/lib/commerce/helcim-pay-events";
import type { HelcimPayloadValue } from "@/lib/commerce/helcim-types";

declare global {
  interface Window {
    appendHelcimPayIframe?: (checkoutToken: string, allowExit?: boolean) => void;
    removeHelcimPayIframe?: () => void;
  }
}

interface TrainingHelcimPayButtonProps {
  disabled?: boolean;
  programSlug: string;
  clientPrice: number;
  promotionCode?: string;
  customer: {
    name: string;
    email: string;
  };
  onPaid: () => void;
}

const PAYMENT_INCOMPLETE_ERROR = "Payment was not completed. Please try again or use another payment method.";
const PAYMENT_SCRIPT_ERROR = "Secure payment could not load. Please retry or contact us for help.";
const HELCIM_PAY_SCRIPT_SRC = "https://secure.helcim.app/helcim-pay/services/start.js";

function isHelcimPayloadValue(value: unknown): value is HelcimPayloadValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function parsePayloadData(value: unknown): Record<string, HelcimPayloadValue> | undefined {
  if (!value || typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  const entries = Object.entries(record);

  if (entries.some(([, entryValue]) => !isHelcimPayloadValue(entryValue))) {
    return undefined;
  }

  return Object.fromEntries(entries) as Record<string, HelcimPayloadValue>;
}

export function TrainingHelcimPayButton({
  disabled = false,
  programSlug,
  clientPrice,
  promotionCode,
  customer,
  onPaid,
}: TrainingHelcimPayButtonProps): ReactElement {
  const router = useRouter();
  const [isScriptReady, setIsScriptReady] = useState(false);
  const [scriptLoadFailed, setScriptLoadFailed] = useState(false);
  const [scriptLoadAttempt, setScriptLoadAttempt] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkoutToken, setCheckoutToken] = useState<string | null>(null);

  useEffect(() => {
    if (!checkoutToken) return;

    const handleMessage = async (event: MessageEvent) => {
      if (event.origin !== "https://secure.helcim.app") {
        return;
      }

      let parsedData: unknown;
      try {
        parsedData = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
      } catch {
        return;
      }

      if (!parsedData || typeof parsedData !== "object") return;
      const dataObj = parsedData as Record<string, unknown>;

      if (dataObj.eventName !== `helcim-pay-js-${checkoutToken}`) {
        return;
      }

      const eventOutcome = getHelcimPayEventOutcome(dataObj.eventStatus);

      if (eventOutcome === "ignored") {
        return;
      }

      if (eventOutcome === "dismissed") {
        window.removeHelcimPayIframe?.();
        setCheckoutToken(null);
        setIsLoading(false);
        return;
      }

      if (eventOutcome === "failed") {
        window.removeHelcimPayIframe?.();
        setCheckoutToken(null);
        setError(PAYMENT_INCOMPLETE_ERROR);
        setIsLoading(false);
        return;
      }

      if (eventOutcome === "success") {
        let eventMessage = dataObj.eventMessage;
        if (typeof eventMessage === "string") {
          try {
            eventMessage = JSON.parse(eventMessage);
          } catch {
            setError("Payment could not be verified. Please contact Lash Her before retrying.");
            setIsLoading(false);
            return;
          }
        }

        if (!eventMessage || typeof eventMessage !== "object") {
          setError("Payment could not be verified. Please contact Lash Her before retrying.");
          setIsLoading(false);
          return;
        }

        const msgObj = eventMessage as Record<string, unknown>;

        let payloadData: Record<string, HelcimPayloadValue> | undefined;
        let payloadHash: string | undefined;

        if (msgObj.data && typeof msgObj.data === "object" && "hash" in msgObj.data) {
          const innerData = msgObj.data as Record<string, unknown>;
          const innerPayloadData = parsePayloadData(innerData.data);
          if (innerPayloadData) {
            payloadData = innerPayloadData;
            payloadHash = typeof innerData.hash === "string" ? innerData.hash : undefined;
          }
        } else if (msgObj.data && typeof msgObj.data === "object" && typeof msgObj.hash === "string") {
          payloadData = parsePayloadData(msgObj.data);
          payloadHash = msgObj.hash;
        }

        if (!payloadData || !payloadHash) {
          setError("Payment could not be verified. Please contact Lash Her before retrying.");
          setIsLoading(false);
          return;
        }

        try {
          const res = await fetch("/api/checkout/validate-payment", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              checkoutToken,
              data: payloadData,
              hash: payloadHash,
            }),
          });

          if (!res.ok) {
            setError("Payment could not be verified. Please contact Lash Her before retrying.");
            setIsLoading(false);
            return;
          }

          const result = await res.json() as { orderId?: string; redirectUrl?: string };

          window.removeHelcimPayIframe?.();

          onPaid();

          if (result.redirectUrl) {
            router.push(result.redirectUrl);
          } else if (result.orderId) {
            router.push(`/training-programs/${encodeURIComponent(programSlug)}/confirmation?order=${encodeURIComponent(result.orderId)}`);
          } else {
            router.push(`/training-programs/${encodeURIComponent(programSlug)}/confirmation`);
          }
        } catch {
          setError("Payment could not be verified. Please contact Lash Her before retrying.");
          setIsLoading(false);
        }
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [checkoutToken, onPaid, router, programSlug]);

  const handleCheckout = async () => {
    setError(null);
    setIsLoading(true);

    try {
      const res = await fetch("/api/training-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          programSlug,
          customerName: customer.name,
          customerEmail: customer.email,
          clientPrice,
          ...(promotionCode ? { promotionCode } : {}),
        }),
      });

      if (!res.ok) {
        setError("Unable to start checkout. Please review your details and try again.");
        setIsLoading(false);
        return;
      }

      const data = await res.json() as { checkoutToken?: string };

      if (!data.checkoutToken) {
        setError("Unable to start checkout. Please review your details and try again.");
        setIsLoading(false);
        return;
      }

      setCheckoutToken(data.checkoutToken);

      if (window.appendHelcimPayIframe) {
        window.appendHelcimPayIframe(data.checkoutToken, true);
      } else {
        setError("Unable to start checkout. Please review your details and try again.");
        setCheckoutToken(null);
        setIsLoading(false);
      }
    } catch {
      setError("Unable to start checkout. Please review your details and try again.");
      setIsLoading(false);
    }
  };

  const handleRetryScript = () => {
    setError(null);
    setScriptLoadFailed(false);
    setIsScriptReady(false);
    setScriptLoadAttempt((attempt) => attempt + 1);
  };

  const buttonLabel = isLoading
    ? "Processing..."
    : scriptLoadFailed
      ? "Payment unavailable"
      : isScriptReady
        ? "Secure Payment"
        : "Loading secure payment...";

  return (
    <div className="flex flex-col gap-3">
      <Script
        key={scriptLoadAttempt}
        src={HELCIM_PAY_SCRIPT_SRC}
        strategy="afterInteractive"
        onLoad={() => {
          setIsScriptReady(true);
          setScriptLoadFailed(false);
        }}
        onError={() => {
          setIsScriptReady(false);
          setScriptLoadFailed(true);
          setError(PAYMENT_SCRIPT_ERROR);
        }}
      />

      {error ? (
        <div className="rounded-[18px] border border-lh-accent/20 bg-lh-accent-soft p-3 text-sm font-bold leading-6 text-lh-accent" role="alert">
          {error}
        </div>
      ) : null}

      {!isScriptReady && !scriptLoadFailed ? (
        <p className="text-sm font-bold leading-6 text-lh-muted" role="status">
          Loading secure payment. If this takes more than a moment, refresh or contact us for help.
        </p>
      ) : null}

      {scriptLoadFailed ? (
        <div className="flex flex-col gap-2 rounded-[18px] border border-lh-line bg-lh-neutral-2/70 p-3 text-sm font-bold leading-6 text-lh-muted sm:flex-row sm:items-center sm:justify-between">
          <span>Payment is temporarily unavailable.</span>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={handleRetryScript}>
              Retry payment
            </Button>
            <Button asChild variant="ghost" size="sm">
              <a href="/contact">Contact support</a>
            </Button>
          </div>
        </div>
      ) : null}

      <Button
        type="button"
        onClick={handleCheckout}
        disabled={disabled || !isScriptReady || isLoading}
        aria-busy={isLoading || (!isScriptReady && !scriptLoadFailed)}
        className="h-12 w-full rounded-full bg-lh-primary px-6 font-body text-sm font-bold uppercase tracking-[0.12em] text-lh-white hover:bg-lh-accent"
      >
        {buttonLabel}
      </Button>
    </div>
  );
}
