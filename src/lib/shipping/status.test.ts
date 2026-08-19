import assert from "node:assert/strict";
import test from "node:test";
import type { ChitChatsShipment } from "./types";
import {
  hasRecordedCarrierHandoff,
  isAllowedShipmentTransition,
  normalizeChitChatsStatus,
  normalizeChitChatsTransition,
  providerShipmentEventAt,
  providerShipmentTransitionEvent,
  stripSignedLabelUrls,
} from "./status";

test("carrier handoff requires authoritative acceptance evidence and a directed post-handoff state", () => {
  const acceptedAt = new Date("2026-08-15T12:00:00.000Z");
  assert.equal(
    hasRecordedCarrierHandoff({ status: "accepted", acceptedAt }),
    true,
  );
  assert.equal(
    hasRecordedCarrierHandoff({ status: "exception", acceptedAt }),
    true,
  );
  assert.equal(
    hasRecordedCarrierHandoff({ status: "label_ready", acceptedAt }),
    false,
  );
  assert.equal(
    hasRecordedCarrierHandoff({ status: "delivered", acceptedAt: null }),
    false,
  );
  assert.equal(
    hasRecordedCarrierHandoff({ status: "voided", acceptedAt }),
    false,
  );
});

test("provider statuses map to fulfillment states without discarding raw state", () => {
  assert.equal(
    normalizeChitChatsStatus({ id: "1", status: "received" }),
    "accepted",
  );
  assert.equal(
    normalizeChitChatsStatus({ id: "1", status: "inducted" }),
    "in_transit",
  );
  assert.equal(
    normalizeChitChatsStatus({
      id: "1",
      status: "resolved",
      carrier_tracking_code: "tracking-present",
    }),
    "manual_review",
  );
  assert.equal(
    normalizeChitChatsStatus({ id: "1", status: "unexpected_new_status" }),
    "manual_review",
  );
});

test("directed shipment transitions permit recovery and reject regressions", () => {
  assert.equal(isAllowedShipmentTransition("exception", "in_transit"), true);
  assert.equal(isAllowedShipmentTransition("in_transit", "delivered"), true);
  assert.equal(isAllowedShipmentTransition("delivered", "in_transit"), false);
  assert.equal(isAllowedShipmentTransition("voided", "label_ready"), false);
  assert.equal(
    isAllowedShipmentTransition("refund_pending", "label_ready"),
    false,
  );
});

test("poll transitions preserve asynchronous purchase and refund safeguards", () => {
  assert.equal(
    normalizeChitChatsTransition("purchase_pending", {
      id: "1",
      status: "unpaid",
    }),
    "manual_review",
  );
  assert.equal(
    normalizeChitChatsTransition("refund_pending", {
      id: "1",
      status: "ready",
    }),
    "refund_pending",
  );
  assert.equal(
    normalizeChitChatsTransition("refund_pending", {
      id: "1",
      status: "voided",
    }),
    "voided",
  );
});

test("signed label URLs are stripped before persistence", () => {
  const safe = stripSignedLabelUrls({
    id: "1",
    status: "ready",
    postage_label_pdf_url: "https://secret",
    postage_label_png_url: "https://secret",
    tracking_url: "https://public",
    metadata: {
      postage_label_pdf_url: "https://nested-secret",
    },
    rates: [
      {
        id: "rate-1",
        postage_type: "tracked",
        payment_amount: "12.00",
        postage_label_svg_url: "https://new-secret",
      },
    ],
  } as ChitChatsShipment);
  assert.equal("postage_label_pdf_url" in safe, false);
  assert.equal("metadata" in safe, false);
  assert.deepEqual(safe.rates, [
    { id: "rate-1", postage_type: "tracked", payment_amount: "12.00" },
  ]);
  assert.equal(safe.tracking_url, "https://public");
});

test("tracking URLs with credentials or signed query parameters are not persisted", () => {
  assert.equal(
    "tracking_url" in
      stripSignedLabelUrls({
        id: "1",
        status: "ready",
        tracking_url: "https://user:password@carrier.test/track/1",
      }),
    false,
  );
  assert.equal(
    "tracking_url" in
      stripSignedLabelUrls({
        id: "1",
        status: "ready",
        tracking_url: "https://carrier.test/track/1?token=secret",
      }),
    false,
  );
});

test("provider event time uses a valid provider timestamp without accepting the future", () => {
  const observedAt = new Date("2026-08-15T12:00:00.000Z");
  assert.equal(
    providerShipmentEventAt(
      {
        id: "1",
        status: "ready",
        updated_at: "2026-08-15T11:59:00.000Z",
      },
      observedAt,
    ).toISOString(),
    "2026-08-15T11:59:00.000Z",
  );
  assert.equal(
    providerShipmentEventAt(
      {
        id: "1",
        status: "ready",
        updated_at: "2026-08-15T12:01:00.000Z",
      },
      observedAt,
    ).toISOString(),
    observedAt.toISOString(),
  );
});

test("fulfillment transitions use the matching tracking event instead of shipment update time", () => {
  const observedAt = new Date("2026-08-15T12:00:00.000Z");
  const transition = providerShipmentTransitionEvent(
    {
      id: "1",
      status: "delivered",
      updated_at: "2026-08-15T11:59:00.000Z",
      tracking_events: [
        {
          status: "in_transit",
          created_at: "2026-08-15T10:00:00.000Z",
        },
        {
          status: "delivered",
          created_at: "2026-08-15T11:00:00.000Z",
        },
      ],
    },
    observedAt,
  );
  assert.equal(transition.authoritative, true);
  assert.equal(transition.source, "tracking_event");
  assert.equal(transition.eventAt.toISOString(), "2026-08-15T11:00:00.000Z");
});

test("movement without a certified matching tracking event is a non-authoritative fallback", () => {
  const transition = providerShipmentTransitionEvent(
    {
      id: "1",
      status: "received",
      updated_at: "2026-08-15T11:59:00.000Z",
      tracking_events: [
        {
          status: "unrecognized_status",
          created_at: "2026-08-15T11:58:00.000Z",
        },
      ],
    },
    new Date("2026-08-15T12:00:00.000Z"),
  );
  assert.equal(transition.authoritative, false);
  assert.equal(transition.source, "shipment_updated_at");
});
