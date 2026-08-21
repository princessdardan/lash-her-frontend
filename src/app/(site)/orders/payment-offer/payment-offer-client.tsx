"use client";

import { useState } from "react";

import { waitForProductPaymentOperation } from "@/lib/commerce/product-payment-operation";

export default function PaymentOfferClient({
  operationId,
}: {
  operationId: string;
}) {
  const [state, setState] = useState<"idle" | "loading">("idle");
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setError(null);
    setState("loading");
    const operation = await waitForProductPaymentOperation({ operationId });
    if (!operation.paymentUrl) {
      setError(operation.error ?? "This payment offer is no longer available.");
      setState("idle");
      return;
    }
    // Hand off to Square's hosted payment page; the Square webhook finalizes
    // the obligation once the payment completes.
    window.location.assign(operation.paymentUrl);
  };

  return (
    <div className="mt-8">
      <button
        type="button"
        disabled={state === "loading"}
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
