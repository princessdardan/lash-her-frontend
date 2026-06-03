import assert from "node:assert/strict";
import test from "node:test";

import {
  describeCalendarFinalizationStatus,
  describeCheckoutStatus,
  getPurchaseDomainFromPurpose,
  moneyFromCents,
  toOperationsInboxItem,
} from "./read-models";

test("moneyFromCents formats CAD cents", () => {
  assert.equal(moneyFromCents(12345, "CAD"), "$123.45 CAD");
});

test("getPurchaseDomainFromPurpose separates shared checkout table flows", () => {
  assert.equal(getPurchaseDomainFromPurpose("product"), "product");
  assert.equal(getPurchaseDomainFromPurpose("training"), "training");
  assert.equal(getPurchaseDomainFromPurpose("appointment_deposit"), "service");
  assert.equal(getPurchaseDomainFromPurpose("appointment_full"), "service");
  assert.equal(getPurchaseDomainFromPurpose("appointment_custom_partial"), "service");
});

test("status descriptions use friendly operational language", () => {
  assert.equal(describeCheckoutStatus("paid"), "Paid");
  assert.equal(describeCheckoutStatus("verification_failed"), "Payment needs review");
  assert.equal(
    describeCalendarFinalizationStatus("paid_unbookable_rebooking_pending"),
    "Paid, rebooking needed",
  );
});

test("operations inbox item explains what happened and the safe next action", () => {
  const item = toOperationsInboxItem({
    createdAt: new Date("2026-06-02T12:00:00Z"),
    domain: "booking",
    href: "/admin/bookings/hold-1",
    id: "hold-1",
    reason: "Calendar finalization failed",
    severity: "high",
    title: "Booking needs manual follow-up",
  });

  assert.equal(
    item.nextAction,
    "Open the record and review the troubleshooting panel before contacting the customer.",
  );
});
