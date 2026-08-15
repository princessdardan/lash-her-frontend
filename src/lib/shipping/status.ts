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

const CARRIER_HANDOFF_OR_LATER_STATUSES = new Set<ProductShipmentStatus>([
  "accepted",
  "in_transit",
  "delivered",
  "exception",
]);

export function hasRecordedCarrierHandoff(input: {
  status: ProductShipmentStatus;
  acceptedAt: Date | null;
}): boolean {
  return (
    input.acceptedAt !== null &&
    CARRIER_HANDOFF_OR_LATER_STATUSES.has(input.status) &&
    isAllowedShipmentTransition("accepted", input.status)
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
  const allowedKeys = new Set([
    "id",
    "status",
    "order_id",
    "postage_type",
    "carrier",
    "carrier_tracking_code",
    "tracking_url",
    "purchase_amount",
    "postage_fee",
    "insurance_fee",
    "delivery_fee",
    "tariff_fee",
    "fda_prior_notification_fee",
    "federal_tax",
    "provincial_tax",
    "is_insured",
    "estimated_delivery_at",
    "postage_purchase_date",
    "ship_date",
    "updated_at",
    "created_at",
  ]);
  const safe = Object.fromEntries(
    Object.entries(shipment).filter(([key, value]) => {
      if (!allowedKeys.has(key) || value === undefined) return false;
      if (key === "tracking_url") return isSafePublicTrackingUrl(value);
      return isSafeScalar(value);
    }),
  );
  if (Array.isArray(shipment.rates)) {
    safe.rates = shipment.rates.map((rate) =>
      Object.fromEntries(
        Object.entries(rate).filter(
          ([key, value]) =>
            !key.toLowerCase().includes("url") && isSafeScalar(value),
        ),
      ),
    );
  }
  if (Array.isArray(shipment.tracking_events)) {
    safe.tracking_events = shipment.tracking_events.map((event) =>
      Object.fromEntries(
        Object.entries(event).filter(
          ([key, value]) =>
            !key.toLowerCase().includes("url") && isSafeScalar(value),
        ),
      ),
    );
  }
  return safe;
}

function isSafeScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function isSafePublicTrackingUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function providerShipmentEventAt(
  shipment: ChitChatsShipment,
  observedAt: Date,
): Date {
  return providerShipmentTransitionEvent(shipment, observedAt).eventAt;
}

export function providerShipmentTransitionEvent(
  shipment: ChitChatsShipment,
  observedAt: Date,
): {
  authoritative: boolean;
  eventAt: Date;
  source:
    | "tracking_event"
    | "shipment_updated_at"
    | "shipment_created_at"
    | "observed_at";
} {
  const matchingStatuses =
    TRACKING_EVENT_STATUSES[normalizeChitChatsStatus(shipment)];
  if (matchingStatuses) {
    const trackingEventAt = latestMatchingTrackingEventAt(
      shipment,
      matchingStatuses,
      observedAt,
    );
    if (trackingEventAt) {
      return {
        authoritative: true,
        eventAt: trackingEventAt,
        source: "tracking_event",
      };
    }
  }
  for (const value of [shipment.updated_at, shipment.created_at]) {
    if (!value) continue;
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime()) && parsed <= observedAt) {
      return {
        authoritative: matchingStatuses === undefined,
        eventAt: parsed,
        source:
          value === shipment.updated_at
            ? "shipment_updated_at"
            : "shipment_created_at",
      };
    }
  }
  return {
    authoritative: matchingStatuses === undefined,
    eventAt: observedAt,
    source: "observed_at",
  };
}

const TRACKING_EVENT_STATUSES: Partial<
  Record<ProductShipmentStatus, ReadonlySet<string>>
> = {
  accepted: new Set(["received"]),
  in_transit: new Set(["released", "inducted", "in_transit"]),
  exception: new Set(["exception", "canceled"]),
  delivered: new Set(["delivered"]),
};

function latestMatchingTrackingEventAt(
  shipment: ChitChatsShipment,
  statuses: ReadonlySet<string>,
  observedAt: Date,
): Date | null {
  let latest: Date | null = null;
  for (const event of shipment.tracking_events ?? []) {
    if (
      (!event.status || !statuses.has(event.status)) &&
      (!event.type || !statuses.has(event.type))
    )
      continue;
    if (!event.created_at) continue;
    const parsed = new Date(event.created_at);
    if (
      !Number.isFinite(parsed.getTime()) ||
      parsed > observedAt ||
      (latest && parsed <= latest)
    )
      continue;
    latest = parsed;
  }
  return latest;
}
