export type ManualFulfillmentAction =
  | "approve_cancellation"
  | "manual_shipping_agreement"
  | "manual_shipping_dispatch"
  | "pickup_complete";

export interface ManualFulfillmentTransition {
  carrier: string | null;
  eventStatus: "cancelled" | "dispatched" | "paid_pending_dispatch";
  method: "manual_shipping" | "pickup_handoff";
  orderStatus: string;
  trackingNumber: string | null;
}

export function getManualFulfillmentTransition(input: {
  action: ManualFulfillmentAction;
  carrier: string;
  currentMode: string;
  currentManualStatus: string | null;
  currentPaymentStatus: string;
  trackingNumber: string;
}): ManualFulfillmentTransition {
  if (["cancelled", "dispatched"].includes(input.currentManualStatus ?? "")) {
    throw new Error(
      "Manual fulfillment is already terminal or cancellation-locked",
    );
  }
  if (
    input.action !== "approve_cancellation" &&
    input.currentPaymentStatus !== "paid"
  ) {
    throw new Error(
      "Manual fulfillment cannot proceed before payment is recorded",
    );
  }
  if (input.action === "pickup_complete") {
    if (input.currentMode !== "manual_pickup") {
      throw new Error("Pickup completion is only valid for pickup orders");
    }
    return {
      carrier: null,
      eventStatus: "dispatched",
      method: "pickup_handoff",
      orderStatus: "dispatched",
      trackingNumber: null,
    };
  }
  if (input.action === "manual_shipping_agreement") {
    if (
      input.currentMode !== "manual_pickup" &&
      input.currentMode !== "manual_shipping"
    ) {
      throw new Error(
        "Shipping agreement is only valid for manual shipping orders",
      );
    }
    return {
      carrier: null,
      eventStatus: "paid_pending_dispatch",
      method: "manual_shipping",
      orderStatus: "paid_pending_dispatch",
      trackingNumber: null,
    };
  }
  if (input.action === "manual_shipping_dispatch") {
    if (
      input.currentMode !== "manual_shipping" ||
      !input.carrier ||
      !input.trackingNumber
    ) {
      throw new Error("Manual dispatch requires carrier and tracking evidence");
    }
    return {
      carrier: input.carrier,
      eventStatus: "dispatched",
      method: "manual_shipping",
      orderStatus: "dispatched",
      trackingNumber: input.trackingNumber,
    };
  }
  return {
    carrier: null,
    eventStatus: "cancelled",
    method:
      input.currentMode === "manual_pickup"
        ? "pickup_handoff"
        : "manual_shipping",
    orderStatus: "cancelled",
    trackingNumber: null,
  };
}

export function getManualFulfillmentConflictToken(input: {
  id: string;
  updatedAt: Date;
}): string {
  return `${input.id}:${input.updatedAt.getTime()}`;
}
