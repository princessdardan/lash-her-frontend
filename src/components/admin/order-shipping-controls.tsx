"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  isTerminalShipmentOperationStatus,
  type ShipmentOperationStatus,
} from "@/lib/shipping/operation-status";

export function OrderShippingControls({
  orderId,
  shipmentId,
  stateVersion,
  status,
  defaultWeightGrams,
  trackingNumber,
  trackingUrl,
}: {
  orderId: string;
  shipmentId: string;
  stateVersion: number;
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
  const [operationStatus, setOperationStatus] = useState<string | null>(null);

  const waitForOperation = async (operationId: string) => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await fetch(
        `/api/admin/orders/${encodeURIComponent(orderId)}/shipping/operations/${encodeURIComponent(operationId)}?${new URLSearchParams({ shipmentId }).toString()}`,
        { cache: "no-store" },
      );
      const result = (await response.json()) as {
        attemptCount?: number;
        error?: string;
        lastError?: string | null;
        outcomeCode?: string | null;
        outcomeUnknown?: boolean;
        status?: ShipmentOperationStatus;
      };
      if (!response.ok || !result.status) {
        throw new Error(result.error ?? "Operation status could not be loaded");
      }
      const detail = result.outcomeCode ?? result.status;
      setOperationStatus(
        `Operation ${operationId}: ${detail.replaceAll("_", " ")}${result.outcomeUnknown ? " (provider outcome unknown)" : ""}`,
      );
      if (isTerminalShipmentOperationStatus(result.status)) {
        router.refresh();
        if (result.status === "dead_letter") {
          throw new Error(
            result.lastError ??
              "The operation requires manual review. Refresh for current state.",
          );
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    setOperationStatus(
      `Operation ${operationId} is still queued. Refresh for current state.`,
    );
  };

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
            shipmentId,
            expectedStateVersion: stateVersion,
            measuredWeightGrams: Number(weight),
            shipDate,
          }),
        },
      );
      const result = (await response.json()) as {
        error?: string;
        operationId?: string;
        status?: string;
      };
      if (!response.ok) {
        setError(result.error ?? "Postage could not be purchased");
        return;
      }
      setOperationStatus(
        result.operationId && result.status
          ? `Operation ${result.operationId}: ${result.status.replaceAll("_", " ")}`
          : "Postage purchase queued",
      );
      if (result.operationId) await waitForOperation(result.operationId);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Postage could not be purchased",
      );
    } finally {
      setBusy(false);
    }
  };

  const refundPostage = async () => {
    if (
      !window.confirm(
        "Request a Chit Chats postage refund? This does not refund the customer's payment.",
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/admin/orders/${encodeURIComponent(orderId)}/shipping/refund`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            shipmentId,
            expectedStateVersion: stateVersion,
          }),
        },
      );
      const result = (await response.json()) as {
        error?: string;
        operationId?: string;
        status?: string;
      };
      if (!response.ok)
        setError(result.error ?? "Postage refund could not be requested");
      else {
        setOperationStatus(
          result.operationId && result.status
            ? `Operation ${result.operationId}: ${result.status.replaceAll("_", " ")}`
            : "Postage refund queued",
        );
        if (result.operationId) await waitForOperation(result.operationId);
      }
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Postage refund could not be requested",
      );
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
      {error ? (
        <p className="mt-2 text-xs font-semibold text-lh-accent" role="alert">
          {error}
        </p>
      ) : null}
      {operationStatus ? (
        <p className="mt-2 text-xs text-lh-muted" role="status">
          {operationStatus}
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
          href={`/api/admin/orders/${encodeURIComponent(orderId)}/shipping/label?${new URLSearchParams({ shipmentId, expectedStateVersion: String(stateVersion) }).toString()}`}
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
