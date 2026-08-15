"use client";

import Script from "next/script";
import { useEffect, useState } from "react";

import { getHelcimPayEventOutcome } from "@/lib/commerce/helcim-pay-events";
import { waitForProductPaymentOperation } from "@/lib/commerce/product-payment-operation";
import type { HelcimPayloadValue } from "@/lib/commerce/helcim-types";

declare global {
  interface Window {
    appendHelcimPayIframe?: (
      checkoutToken: string,
      allowExit?: boolean,
    ) => void;
    removeHelcimPayIframe?: () => void;
  }
}

export default function PaymentOfferClient({
  operationId,
}: {
  operationId: string;
}) {
  const [scriptReady, setScriptReady] = useState(false);
  const [checkoutToken, setCheckoutToken] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "received">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!checkoutToken) return;
    const receive = async (event: MessageEvent) => {
      if (event.origin !== "https://secure.helcim.app") return;
      let value: unknown;
      try {
        value =
          typeof event.data === "string" ? JSON.parse(event.data) : event.data;
      } catch {
        return;
      }
      if (!value || typeof value !== "object") return;
      const envelope = value as Record<string, unknown>;
      if (envelope.eventName !== `helcim-pay-js-${checkoutToken}`) return;
      const outcome = getHelcimPayEventOutcome(envelope.eventStatus);
      if (outcome === "ignored") return;
      if (outcome !== "success") {
        window.removeHelcimPayIframe?.();
        setCheckoutToken(null);
        setState("idle");
        if (outcome === "failed") setError("Payment was not completed.");
        return;
      }
      const verified = parseHelcimEvent(envelope.eventMessage);
      if (!verified) {
        setError(
          "Payment could not be verified. Contact Lash Her before retrying.",
        );
        setState("idle");
        return;
      }
      const response = await fetch("/api/checkout/validate-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checkoutToken, ...verified }),
      }).catch(() => null);
      if (!response || (!response.ok && response.status !== 202)) {
        setError(
          "Payment status could not be confirmed. Contact Lash Her before retrying.",
        );
        setState("idle");
        return;
      }
      window.removeHelcimPayIframe?.();
      setCheckoutToken(null);
      setState("received");
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [checkoutToken]);

  const start = async () => {
    setError(null);
    setState("loading");
    const operation = await waitForProductPaymentOperation({ operationId });
    if (!operation.checkoutToken || !window.appendHelcimPayIframe) {
      setError(operation.error ?? "This payment offer is no longer available.");
      setState("idle");
      return;
    }
    setCheckoutToken(operation.checkoutToken);
    window.appendHelcimPayIframe(operation.checkoutToken, true);
  };

  if (state === "received") {
    return (
      <p className="mt-8" role="status">
        Payment received; fulfillment confirmation is under review.
      </p>
    );
  }
  return (
    <div className="mt-8">
      <Script
        src="https://secure.helcim.app/helcim-pay/services/start.js"
        strategy="afterInteractive"
        onLoad={() => setScriptReady(true)}
        onError={() => setError("Secure payment could not load.")}
      />
      <button
        type="button"
        disabled={!scriptReady || state === "loading"}
        onClick={start}
        className="border border-stone-900 px-5 py-3 text-sm disabled:opacity-50"
      >
        {state === "loading" ? "Preparing secure payment…" : "Pay this offer"}
      </button>
      {error ? (
        <p className="mt-3 text-sm text-red-800" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function parseHelcimEvent(value: unknown): {
  data: Record<string, HelcimPayloadValue>;
  hash: string;
} | null {
  let message = value;
  if (typeof message === "string") {
    try {
      message = JSON.parse(message);
    } catch {
      return null;
    }
  }
  if (!message || typeof message !== "object") return null;
  const record = message as Record<string, unknown>;
  const nested =
    record.data && typeof record.data === "object"
      ? (record.data as Record<string, unknown>)
      : null;
  const dataValue = nested && "hash" in nested ? nested.data : record.data;
  const hashValue = nested && "hash" in nested ? nested.hash : record.hash;
  if (
    !dataValue ||
    typeof dataValue !== "object" ||
    typeof hashValue !== "string"
  )
    return null;
  const entries = Object.entries(dataValue as Record<string, unknown>);
  if (
    entries.some(
      ([, item]) =>
        item !== null && !["string", "number", "boolean"].includes(typeof item),
    )
  )
    return null;
  return {
    data: Object.fromEntries(entries) as Record<string, HelcimPayloadValue>,
    hash: hashValue,
  };
}
