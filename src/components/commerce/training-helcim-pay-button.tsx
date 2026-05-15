"use client";

import { useState, useEffect, type ReactElement } from "react";
import Script from "next/script";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
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
  customer: {
    name: string;
    email: string;
  };
  onPaid: () => void;
}

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
  customer,
  onPaid,
}: TrainingHelcimPayButtonProps): ReactElement {
  const router = useRouter();
  const [isScriptReady, setIsScriptReady] = useState(false);
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

      if (dataObj.eventStatus === "ABORTED" || dataObj.eventStatus === "HIDE") {
        if (window.removeHelcimPayIframe) {
          window.removeHelcimPayIframe();
        }
        setCheckoutToken(null);
        setIsLoading(false);
        return;
      }

      if (dataObj.eventStatus === "SUCCESS") {
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

          if (window.removeHelcimPayIframe) {
            window.removeHelcimPayIframe();
          }

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
        setIsLoading(false);
      }
    } catch {
      setError("Unable to start checkout. Please review your details and try again.");
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <Script
        src="https://secure.helcim.app/helcim-pay/services/start.js"
        strategy="afterInteractive"
        onLoad={() => setIsScriptReady(true)}
      />

      {error ? (
        <div className="text-brand-red text-sm font-medium p-3 bg-red-50 rounded-md" role="alert">
          {error}
        </div>
      ) : null}

      <Button
        onClick={handleCheckout}
        disabled={disabled || !isScriptReady || isLoading}
        className="btn-primary-red w-full"
      >
        {isLoading ? "Processing..." : "Secure Payment"}
      </Button>
    </div>
  );
}
