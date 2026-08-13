import type { ProductShipmentStatus } from "@/lib/shipping/store-types";
import type { ChitChatsShipment } from "./types";

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
