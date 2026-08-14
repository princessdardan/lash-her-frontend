import assert from "node:assert/strict";
import test from "node:test";
import {
  isAllowedShipmentTransition,
  normalizeChitChatsStatus,
  normalizeChitChatsTransition,
  stripSignedLabelUrls,
} from "./status";

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
  });
  assert.equal("postage_label_pdf_url" in safe, false);
  assert.equal(safe.tracking_url, "https://public");
});
