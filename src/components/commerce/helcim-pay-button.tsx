"use client";

import { useState, useEffect, type ReactElement } from "react";
import Script from "next/script";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import type { CartInputItem } from "@/lib/commerce/cart";
import { getHelcimPayEventOutcome } from "@/lib/commerce/helcim-pay-events";
import type { HelcimPayloadValue } from "@/lib/commerce/helcim-types";

declare global {
  interface Window {
    appendHelcimPayIframe?: (checkoutToken: string, allowExit?: boolean) => void;
    removeHelcimPayIframe?: () => void;
  }
}

interface HelcimPayButtonProps {
  disabled?: boolean;
  items: CartInputItem[];
  customer: {
    name: string;
    email: string;
  };
  shippingAddress: ProductShippingAddress;
  onPaid: () => void;
}

const PAYMENT_INCOMPLETE_ERROR = "Payment was not completed. Please try again or use another payment method.";

export interface ProductShippingAddress {
  line1: string;
  line2?: string;
  city: string;
  province: string;
  postalCode: string;
  country: string;
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

export function HelcimPayButton({
  disabled = false,
  items,
  customer,
  shippingAddress,
  onPaid,
}: HelcimPayButtonProps): ReactElement {
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
            router.push(`/products/confirmation?order=${encodeURIComponent(result.orderId)}`);
          } else {
            router.push("/products/confirmation");
          }
        } catch {
          setError("Payment could not be verified. Please contact Lash Her before retrying.");
          setIsLoading(false);
        }
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [checkoutToken, onPaid, router]);

  const handleCheckout = async () => {
    setError(null);
    setIsLoading(true);

    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customer, items, shippingAddress }),
      });

      if (!res.ok) {
        setError("Unable to start checkout. Please review your cart and try again.");
        setIsLoading(false);
        return;
      }

      const data = await res.json() as { checkoutToken?: string };

      if (!data.checkoutToken) {
        setError("Unable to start checkout. Please review your cart and try again.");
        setIsLoading(false);
        return;
      }

      setCheckoutToken(data.checkoutToken);

      if (window.appendHelcimPayIframe) {
        window.appendHelcimPayIframe(data.checkoutToken, true);
      } else {
        setError("Unable to start checkout. Please review your cart and try again.");
        setCheckoutToken(null);
        setIsLoading(false);
      }
    } catch {
      setError("Unable to start checkout. Please review your cart and try again.");
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
        {isLoading ? "Processing..." : "Checkout"}
      </Button>
    </div>
  );
}
