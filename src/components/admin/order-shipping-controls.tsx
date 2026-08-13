"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function OrderShippingControls({
  orderId,
  status,
  defaultWeightGrams,
  trackingNumber,
  trackingUrl,
}: {
  orderId: string;
  status: string;
  defaultWeightGrams: number;
  trackingNumber: string | null;
  trackingUrl: string | null;
}) {
  const router = useRouter();
  const [weight, setWeight] = useState(String(defaultWeightGrams || ""));
  const [shipDate, setShipDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [alternateRates, setAlternateRates] = useState<
    Array<{ id: string; title: string; amountCents: number }>
  >([]);
  const [alternatePostageType, setAlternatePostageType] = useState("");
  const [alternateReason, setAlternateReason] = useState("");

  const buy = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/admin/orders/${encodeURIComponent(orderId)}/shipping/buy`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            measuredWeightGrams: Number(weight),
            shipDate,
            ...(alternatePostageType
              ? { alternatePostageType, alternateReason }
              : {}),
          }),
        },
      );
      const result = (await response.json()) as {
        error?: string;
        rates?: Array<{ id: string; title: string; amountCents: number }>;
      };
      if (!response.ok) {
        setError(result.error ?? "Postage could not be purchased");
        if (result.rates?.length) {
          setAlternateRates(result.rates);
          setAlternatePostageType(result.rates[0]?.id ?? "");
        }
        return;
      }
      router.refresh();
    } catch {
      setError("Postage could not be purchased");
    } finally {
      setBusy(false);
    }
  };

  const refundPostage = async () => {
    if (
      !window.confirm(
        "Request a Chit Chats postage refund? This does not refund the customer's Helcim payment.",
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/admin/orders/${encodeURIComponent(orderId)}/shipping/refund`,
        { method: "POST" },
      );
      const result = (await response.json()) as { error?: string };
      if (!response.ok)
        setError(result.error ?? "Postage refund could not be requested");
      else router.refresh();
    } catch {
      setError("Postage refund could not be requested");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 border-t border-lh-line pt-3">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-lh-muted">
        Fulfillment: {status.replaceAll("_", " ")}
      </p>
      {status === "ready_for_staff" ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <Input
            aria-label="Measured package weight in grams"
            inputMode="numeric"
            min={1}
            max={50000}
            type="number"
            value={weight}
            onChange={(event) => setWeight(event.target.value)}
          />
          <Input
            aria-label="Ship date"
            type="date"
            value={shipDate}
            onChange={(event) => setShipDate(event.target.value)}
          />
          <Button
            type="button"
            size="sm"
            disabled={busy || Number(weight) <= 0 || !shipDate}
            onClick={buy}
          >
            {busy ? "Buying..." : "Buy label"}
          </Button>
        </div>
      ) : null}
      {status === "ready_for_staff" && alternateRates.length > 0 ? (
        <div className="mt-3 grid gap-2">
          <label
            className="text-xs font-semibold text-lh-muted"
            htmlFor={`alternate-rate-${orderId}`}
          >
            Insured tracked alternative
          </label>
          <select
            id={`alternate-rate-${orderId}`}
            className="h-11 rounded-md border border-lh-line bg-white px-3 text-sm"
            value={alternatePostageType}
            onChange={(event) => setAlternatePostageType(event.target.value)}
          >
            {alternateRates.map((rate) => (
              <option key={rate.id} value={rate.id}>
                {rate.title} —{" "}
                {(rate.amountCents / 100).toLocaleString("en-CA", {
                  style: "currency",
                  currency: "CAD",
                })}
              </option>
            ))}
          </select>
          <Input
            aria-label="Reason for changing shipping service"
            value={alternateReason}
            onChange={(event) => setAlternateReason(event.target.value)}
            placeholder="Required reason for service change"
            maxLength={500}
          />
          <p className="text-xs text-lh-muted">
            The customer is not charged or refunded for the difference. Do not
            select a downgrade without documenting why.
          </p>
        </div>
      ) : null}
      {error ? (
        <p className="mt-2 text-xs font-semibold text-lh-accent" role="alert">
          {error}
        </p>
      ) : null}
      {trackingNumber ? (
        <p className="mt-2 text-xs text-lh-muted">
          Tracking:{" "}
          {trackingUrl ? (
            <a
              className="font-semibold text-lh-primary underline"
              href={trackingUrl}
              rel="noreferrer"
              target="_blank"
            >
              {trackingNumber}
            </a>
          ) : (
            trackingNumber
          )}
        </p>
      ) : null}
      {[
        "label_ready",
        "accepted",
        "in_transit",
        "delivered",
        "exception",
      ].includes(status) ? (
        <a
          className="mt-2 inline-block text-xs font-semibold text-lh-primary underline"
          href={`/api/admin/orders/${encodeURIComponent(orderId)}/shipping/label`}
          target="_blank"
          rel="noreferrer"
        >
          Open shipping label
        </a>
      ) : null}
      {["label_ready", "exception"].includes(status) ? (
        <Button
          className="ml-3 mt-2"
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={refundPostage}
        >
          Request postage refund
        </Button>
      ) : null}
    </div>
  );
}
