import type { ProductShipmentStatus } from "@/lib/shipping/store-types";
import type { ChitChatsShipment } from "./types";

const SHIPMENT_TRANSITIONS: Record<
  ProductShipmentStatus,
  ReadonlySet<ProductShipmentStatus>
> = {
  quote_pending: new Set([
    "quote_pending",
    "quoted",
    "quote_unknown",
    "abandoned",
    "manual_review",
  ]),
  quoted: new Set(["quoted", "payment_pending", "abandoned", "manual_review"]),
  quote_unknown: new Set([
    "quote_unknown",
    "quoted",
    "abandoned",
    "manual_review",
  ]),
  payment_pending: new Set([
    "payment_pending",
    "ready_for_staff",
    "manual_review",
  ]),
  ready_for_staff: new Set([
    "ready_for_staff",
    "purchase_pending",
    "manual_review",
  ]),
  purchase_pending: new Set([
    "purchase_pending",
    "label_ready",
    "accepted",
    "in_transit",
    "delivered",
    "exception",
    "manual_review",
  ]),
  label_ready: new Set([
    "label_ready",
    "accepted",
    "in_transit",
    "delivered",
    "exception",
    "refund_pending",
    "voided",
    "manual_review",
  ]),
  accepted: new Set([
    "accepted",
    "in_transit",
    "delivered",
    "exception",
    "refund_pending",
    "voided",
    "manual_review",
  ]),
  in_transit: new Set([
    "in_transit",
    "delivered",
    "exception",
    "refund_pending",
    "voided",
    "manual_review",
  ]),
  delivered: new Set(["delivered", "manual_review"]),
  exception: new Set([
    "exception",
    "in_transit",
    "delivered",
    "refund_pending",
    "voided",
    "manual_review",
  ]),
  refund_pending: new Set(["refund_pending", "voided", "manual_review"]),
  voided: new Set(["voided", "manual_review"]),
  abandoned: new Set(["abandoned", "manual_review"]),
  manual_review: new Set(["manual_review"]),
};

export function isAllowedShipmentTransition(
  current: ProductShipmentStatus,
  next: ProductShipmentStatus,
): boolean {
  return SHIPMENT_TRANSITIONS[current].has(next);
}

export function allowedShipmentSourceStatuses(
  next: ProductShipmentStatus,
): ProductShipmentStatus[] {
  return (Object.keys(SHIPMENT_TRANSITIONS) as ProductShipmentStatus[]).filter(
    (current) => isAllowedShipmentTransition(current, next),
  );
}

export function normalizeChitChatsStatus(
  shipment: ChitChatsShipment,
): ProductShipmentStatus {
  switch (shipment.status.toLowerCase()) {
    case "unpaid":
      return "quoted";
    case "postage_requested":
    case "pending":
      return "purchase_pending";
    case "ready":
      return "label_ready";
    case "received":
      return "accepted";
    case "released":
    case "inducted":
    case "in_transit":
      return "in_transit";
    case "delivered":
      return "delivered";
    case "exception":
    case "canceled":
      return "exception";
    case "voided":
      return "voided";
    case "resolved":
      return "manual_review";
    default:
      return "manual_review";
  }
}

export function normalizeChitChatsTransition(
  currentStatus: ProductShipmentStatus,
  shipment: ChitChatsShipment,
): ProductShipmentStatus {
  const normalized = normalizeChitChatsStatus(shipment);
  if (!isAllowedShipmentTransition(currentStatus, normalized)) {
    return currentStatus === "refund_pending" ||
      currentStatus === "delivered" ||
      currentStatus === "voided"
      ? currentStatus
      : "manual_review";
  }
  if (currentStatus === "refund_pending" && normalized !== "voided")
    return "refund_pending";
  if (currentStatus !== "quoted" && normalized === "quoted")
    return "manual_review";
  return normalized;
}

export function stripSignedLabelUrls(
  shipment: ChitChatsShipment,
): Record<string, unknown> {
  const safe = { ...shipment };
  delete safe.postage_label_pdf_url;
  delete safe.postage_label_png_url;
  delete safe.postage_label_zpl_url;
  return safe;
}
