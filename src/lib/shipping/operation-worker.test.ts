import assert from "node:assert/strict";
import test from "node:test";
import {
  assertProviderMatchesRefreshIntent,
  classifyProviderPurchaseAction,
  classifyProviderPurchaseConfirmation,
} from "./operation-worker";

test("ambiguous purchase reconciliation never buys a provider draft again", () => {
  assert.equal(
    classifyProviderPurchaseAction(
      { id: "shipment-quoted-after-buy", status: "unpaid" },
      true,
    ),
    "manual_review",
  );
  assert.equal(
    classifyProviderPurchaseAction(
      { id: "shipment-normal-quote", status: "unpaid" },
      false,
    ),
    "buy",
  );
});

test("purchase action respects refreshed and reconciled provider state", () => {
  assert.equal(
    classifyProviderPurchaseAction(
      { id: "shipment-purchased", status: "ready", purchase_amount: "12.00" },
      false,
    ),
    "reconcile",
  );
  assert.equal(
    classifyProviderPurchaseAction(
      { id: "shipment-requested", status: "postage_requested" },
      false,
    ),
    "wait",
  );
  assert.equal(
    classifyProviderPurchaseAction(
      { id: "shipment-voided", status: "voided" },
      false,
    ),
    "manual_review",
  );
});

test("purchase reconciliation rejects non-purchase terminal and unknown states", () => {
  for (const status of ["resolved", "voided", "unknown_provider_state"]) {
    assert.deepEqual(
      classifyProviderPurchaseConfirmation({
        id: `shipment-${status}`,
        status,
        purchase_amount: "12.00",
      }),
      { settledPurchaseCents: null, statusConfirmed: false },
    );
  }
});

test("purchase reconciliation requires settled provider accounting evidence", () => {
  assert.deepEqual(
    classifyProviderPurchaseConfirmation({ id: "shipment-1", status: "ready" }),
    { settledPurchaseCents: null, statusConfirmed: true },
  );
  assert.deepEqual(
    classifyProviderPurchaseConfirmation({
      id: "shipment-2",
      status: "ready",
      purchase_amount: "12.34",
    }),
    { settledPurchaseCents: 1234, statusConfirmed: true },
  );
  assert.deepEqual(
    classifyProviderPurchaseConfirmation({
      id: "shipment-components-only",
      status: "ready",
      postage_fee: "8.00",
      insurance_fee: "1.00",
      delivery_fee: "0.50",
      tariff_fee: "0.25",
      fda_prior_notification_fee: "0.00",
      federal_tax: "1.00",
      provincial_tax: "1.59",
    }),
    { settledPurchaseCents: null, statusConfirmed: true },
  );
});

test("ambiguous refresh reconciliation requires every immutable PATCH field", () => {
  const provider = {
    id: "shipment-refresh",
    status: "unpaid",
    package_type: "parcel",
    weight_unit: "g",
    weight: "250",
    size_unit: "cm",
    size_x: "20",
    size_y: 15,
    size_z: 4,
    signature_requested: true,
    ship_date: "2026-08-15T00:00:00Z",
  };
  const intent = {
    packageType: "parcel",
    weightGrams: 250,
    lengthCm: 20,
    widthCm: 15,
    heightCm: 4,
    signatureRequested: true,
    shipDate: "2026-08-15",
  };
  assert.doesNotThrow(() =>
    assertProviderMatchesRefreshIntent(provider, intent),
  );
  for (const mutation of [
    { package_type: "letter" },
    { weight: "251" },
    { size_x: 21 },
    { size_y: 16 },
    { size_z: 5 },
    { signature_requested: false },
    { ship_date: "2026-08-16" },
    { weight_unit: "kg" },
    { size_unit: "in" },
  ]) {
    assert.throws(() =>
      assertProviderMatchesRefreshIntent({ ...provider, ...mutation }, intent),
    );
  }
});
