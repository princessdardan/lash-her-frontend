# Service Booking Square HST Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collect Ontario HST at 13% on service booking Square Payment Links for the amount paid today only, while keeping tips separate and preserving booking reconciliation.

**Architecture:** Add a focused service booking tax policy that computes the HST quote locally. Square Payment Links will include a real manual line-item tax, and private checkout records will persist the expected non-tip total (`base + HST`) plus tax metadata. Existing Square webhook/return finalization will continue comparing Square `payment.amount_money.amount` to `checkoutOrders.amountCents`, while `tip_money` remains separate.

**Tech Stack:** Next.js 16 App Router, TypeScript, Node test runner via `tsx --test`, Drizzle/PostgreSQL private DB, Square REST Payment Links API, existing Square mock client.

---

## Implementation Notes

- Run commands from repo root: `/Users/dardan/workspace/lash-her-frontend`.
- Do not commit from this environment unless the user explicitly requests it. Each task includes a verification checkpoint instead of an automatic commit.
- The design spec is `docs/superpowers/specs/2026-06-07-service-booking-square-hst-design.md`.
- Keep private/payment data in PostgreSQL/private DB structures, not Sanity.
- HST policy for this work is fixed: Ontario HST, 13%, amount paid today only, tips excluded.

## File Structure

- Create `src/lib/booking/service-tax-policy.ts`
  - Single-purpose tax policy boundary for service booking HST quote calculation.
  - Exports constants, quote type, and calculator.
- Create `src/lib/booking/service-tax-policy.test.ts`
  - Unit tests for 13% HST, rounding, and invalid cents input.
- Modify `src/lib/booking/square-client.ts`
  - Extend Square create-payment-link request typings to include manual order taxes and applied line-item taxes.
- Modify `src/lib/booking/square-service-checkout.ts`
  - Compute HST quote.
  - Send Square line item + manual tax + applied tax.
  - Store `checkoutOrders.amountCents` as `base + HST`.
  - Store tax breakdown in `checkoutOrders.providerMetadata.tax`.
  - Include tax policy version and expected total in the Square idempotency key.
- Modify `src/lib/booking/square-service-checkout.test.ts`
  - Verify Square request shape, expected amount persistence, and idempotency changes.
- Modify `src/lib/booking/square-mock-client.ts`
  - Compute mock payment/order totals from line items plus applied manual taxes so local mock flow reflects production behavior.
- Modify `src/lib/booking/square-mock-client.test.ts`
  - Verify mock Square totals include line-item tax.
- Modify `src/lib/booking/square-payment-finalizer.test.ts`
  - Verify taxed totals reconcile and no-tax totals mismatch for taxed orders.
- Optionally modify `src/lib/booking/square-payment-finalizer.ts`
  - Preserve current comparison semantics; add only small metadata enrichment if needed after tests reveal a gap.

---

### Task 1: Add service booking HST policy

**Files:**
- Create: `src/lib/booking/service-tax-policy.ts`
- Create: `src/lib/booking/service-tax-policy.test.ts`

- [ ] **Step 1: Write the failing tax policy tests**

Create `src/lib/booking/service-tax-policy.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateServiceBookingHstQuote,
  SERVICE_BOOKING_HST_POLICY_VERSION,
  SERVICE_BOOKING_HST_RATE,
} from "./service-tax-policy";

test("service booking HST policy taxes amount paid today at 13%", () => {
  const quote = calculateServiceBookingHstQuote(5000);

  assert.deepEqual(quote, {
    expectedAmountCents: 5650,
    policyVersion: SERVICE_BOOKING_HST_POLICY_VERSION,
    taxAmountCents: 650,
    taxableAmountCents: 5000,
    taxName: "Ontario HST",
    taxRate: SERVICE_BOOKING_HST_RATE,
  });
});

test("service booking HST policy rounds to the nearest cent", () => {
  const quote = calculateServiceBookingHstQuote(999);

  assert.equal(quote.taxAmountCents, 130);
  assert.equal(quote.expectedAmountCents, 1129);
});

test("service booking HST policy rejects non-positive and unsafe cents", () => {
  assert.throws(() => calculateServiceBookingHstQuote(0), /positive integer cents/);
  assert.throws(() => calculateServiceBookingHstQuote(-1), /positive integer cents/);
  assert.throws(() => calculateServiceBookingHstQuote(10.5), /positive integer cents/);
  assert.throws(() => calculateServiceBookingHstQuote(Number.MAX_SAFE_INTEGER + 1), /safe integer cents/);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npx tsx --test src/lib/booking/service-tax-policy.test.ts
```

Expected: FAIL because `./service-tax-policy` does not exist.

- [ ] **Step 3: Implement the tax policy**

Create `src/lib/booking/service-tax-policy.ts`:

```ts
export const SERVICE_BOOKING_HST_POLICY_VERSION = "service-booking-hst-on-paid-today-v1";
export const SERVICE_BOOKING_HST_RATE = 0.13;
export const SERVICE_BOOKING_HST_PERCENTAGE = "13";
export const SERVICE_BOOKING_HST_TAX_NAME = "Ontario HST";
export const SERVICE_BOOKING_HST_TAX_UID = "ontario-hst";

export interface ServiceBookingHstQuote {
  expectedAmountCents: number;
  policyVersion: typeof SERVICE_BOOKING_HST_POLICY_VERSION;
  taxAmountCents: number;
  taxableAmountCents: number;
  taxName: typeof SERVICE_BOOKING_HST_TAX_NAME;
  taxRate: typeof SERVICE_BOOKING_HST_RATE;
}

export function calculateServiceBookingHstQuote(amountPaidTodayCents: number): ServiceBookingHstQuote {
  assertPositiveSafeIntegerCents(amountPaidTodayCents);

  const taxAmountCents = Math.round(amountPaidTodayCents * SERVICE_BOOKING_HST_RATE);

  return {
    expectedAmountCents: amountPaidTodayCents + taxAmountCents,
    policyVersion: SERVICE_BOOKING_HST_POLICY_VERSION,
    taxAmountCents,
    taxableAmountCents: amountPaidTodayCents,
    taxName: SERVICE_BOOKING_HST_TAX_NAME,
    taxRate: SERVICE_BOOKING_HST_RATE,
  };
}

function assertPositiveSafeIntegerCents(value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("Service booking HST requires positive integer cents");
  }

  if (!Number.isSafeInteger(value)) {
    throw new Error("Service booking HST requires safe integer cents");
  }
}
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
npx tsx --test src/lib/booking/service-tax-policy.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Checkpoint**

Run:

```bash
git diff -- src/lib/booking/service-tax-policy.ts src/lib/booking/service-tax-policy.test.ts
```

Expected: diff contains only the new policy and tests. Do not commit unless explicitly requested.

---

### Task 2: Extend Square request typings for taxes

**Files:**
- Modify: `src/lib/booking/square-client.ts`
- Modify: `src/lib/booking/square-client.test.ts`

- [ ] **Step 1: Write the failing Square client body-shape assertion**

In `src/lib/booking/square-client.test.ts`, extend the request object in the existing “Square client posts CreatePaymentLink with Square REST headers and body” test to include a tax and applied tax. The test should assert the raw request body preserves that tax payload.

Use this request shape in the test setup:

```ts
const request: SquareCreatePaymentLinkRequest = {
  checkout_options: {
    allow_tipping: true,
    redirect_url: "https://lashher.test/api/booking/square/return",
  },
  idempotency_key: "idempotency-key-1",
  order: {
    location_id: "LOC123",
    line_items: [
      {
        applied_taxes: [{ tax_uid: "ontario-hst" }],
        base_price_money: { amount: 5000, currency: "CAD" },
        name: "Classic Fill deposit",
        quantity: "1",
      },
    ],
    reference_id: "lh-sq-order-1",
    taxes: [
      {
        name: "Ontario HST",
        percentage: "13",
        scope: "LINE_ITEM",
        type: "ADDITIVE",
        uid: "ontario-hst",
      },
    ],
  },
};
```

Add this assertion after the existing body assertion or replace the body assertion with this expected object:

```ts
assert.deepEqual(JSON.parse(requests[0].body), request);
```

- [ ] **Step 2: Run the focused Square client test and verify it fails at type-check/runtime**

Run:

```bash
npx tsx --test src/lib/booking/square-client.test.ts
```

Expected: FAIL because `applied_taxes` and `taxes` are not yet part of `SquareCreatePaymentLinkRequest` typings.

- [ ] **Step 3: Extend `SquareCreatePaymentLinkRequest`**

In `src/lib/booking/square-client.ts`, replace the `order` portion of `SquareCreatePaymentLinkRequest` with this shape:

```ts
  order?: {
    location_id: string;
    line_items: Array<{
      applied_taxes?: Array<{
        tax_uid: string;
      }>;
      name: string;
      quantity: string;
      base_price_money: {
        amount: number;
        currency: "CAD";
      };
      note?: string;
    }>;
    metadata?: Record<string, string>;
    reference_id?: string;
    taxes?: Array<{
      name: string;
      percentage: string;
      scope: "LINE_ITEM";
      type: "ADDITIVE";
      uid: string;
    }>;
  };
```

- [ ] **Step 4: Run the focused Square client test and verify it passes**

Run:

```bash
npx tsx --test src/lib/booking/square-client.test.ts
```

Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run:

```bash
git diff -- src/lib/booking/square-client.ts src/lib/booking/square-client.test.ts
```

Expected: diff contains type additions and the test request payload. Do not commit unless explicitly requested.

---

### Task 3: Apply HST in Square service checkout and persistence

**Files:**
- Modify: `src/lib/booking/square-service-checkout.ts`
- Modify: `src/lib/booking/square-service-checkout.test.ts`

- [ ] **Step 1: Update the primary checkout test to expect HST**

In `src/lib/booking/square-service-checkout.test.ts`, update the “Square service checkout creates payment link with idempotent booking body” assertion block.

Replace the expected key line with:

```ts
const expectedKey = buildSquareServiceCheckoutIdempotencyKey(hold, 5000, 5650);
```

Replace the line item assertion with:

```ts
assert.deepEqual(clientRequests[0].order.line_items, [{
  applied_taxes: [{ tax_uid: "ontario-hst" }],
  name: "Classic Fill deposit",
  quantity: "1",
  base_price_money: { amount: 5000, currency: "CAD" },
  note: "Lash Her BOOKING-DEPOSIT",
}]);
```

Add this tax assertion after the line item assertion:

```ts
assert.deepEqual(clientRequests[0].order.taxes, [{
  name: "Ontario HST",
  percentage: "13",
  scope: "LINE_ITEM",
  type: "ADDITIVE",
  uid: "ontario-hst",
}]);
```

Add these persistence assertions after `assert.equal(persisted[0].locationId, "LOC123");`:

```ts
assert.equal(persisted[0].amountCents, 5650);
assert.deepEqual(persisted[0].taxQuote, {
  expectedAmountCents: 5650,
  policyVersion: "service-booking-hst-on-paid-today-v1",
  taxAmountCents: 650,
  taxableAmountCents: 5000,
  taxName: "Ontario HST",
  taxRate: 0.13,
});
```

- [ ] **Step 2: Update add-on/full-payment test expectations**

In the “Square service checkout charges selected full payment amount when an add-on is selected” test, add:

```ts
assert.equal(request.order.line_items[0].base_price_money.amount, 17500);
assert.deepEqual(request.order.line_items[0].applied_taxes, [{ tax_uid: "ontario-hst" }]);
assert.deepEqual(request.order.taxes, [{
  name: "Ontario HST",
  percentage: "13",
  scope: "LINE_ITEM",
  type: "ADDITIVE",
  uid: "ontario-hst",
}]);
```

Keep the existing assertion that the base line amount remains `17500`; HST is added by Square as tax and not folded into the line item base price.

- [ ] **Step 3: Run checkout tests and verify they fail**

Run:

```bash
npx tsx --test src/lib/booking/square-service-checkout.test.ts
```

Expected: FAIL because checkout code does not compute or persist HST yet.

- [ ] **Step 4: Update checkout dependency types and helper signature**

In `src/lib/booking/square-service-checkout.ts`, add imports:

```ts
import {
  calculateServiceBookingHstQuote,
  SERVICE_BOOKING_HST_PERCENTAGE,
  SERVICE_BOOKING_HST_TAX_NAME,
  SERVICE_BOOKING_HST_TAX_UID,
  type ServiceBookingHstQuote,
} from "./service-tax-policy";
```

Update `PersistSquareServiceCheckoutInput`:

```ts
export interface PersistSquareServiceCheckoutInput {
  amountCents: number;
  hold: BookingHoldRecord;
  idempotencyKey: string;
  locationId: string;
  now: Date;
  orderId: string;
  paymentLink: SquarePaymentLink;
  paymentSelection: BookingPaymentSelection;
  taxQuote: ServiceBookingHstQuote;
}
```

Update `buildSquareServiceCheckoutIdempotencyKey` signature and body:

```ts
export function buildSquareServiceCheckoutIdempotencyKey(
  hold: Pick<BookingHoldRecord, "id" | "publicReference">,
  amountCents: number,
  expectedAmountCents = amountCents,
): string {
  const digest = createHash("sha256")
    .update(`${hold.id}:${hold.publicReference}:${amountCents}:${expectedAmountCents}:${calculateServiceBookingHstQuote(amountCents).policyVersion}`, "utf8")
    .digest("hex")
    .slice(0, 32);

  return `svc_${digest}`;
}
```

- [ ] **Step 5: Compute HST quote and send it to Square**

In `createSquareServiceCheckout`, after `const amountCents = toBookingPaymentAmountCents(paymentSelection);`, add:

```ts
const taxQuote = calculateServiceBookingHstQuote(amountCents);
```

Replace the idempotency key line with:

```ts
const idempotencyKey = buildSquareServiceCheckoutIdempotencyKey(input.hold, amountCents, taxQuote.expectedAmountCents);
```

Update the Square line item to include applied tax:

```ts
{
  applied_taxes: [{ tax_uid: SERVICE_BOOKING_HST_TAX_UID }],
  name: paymentSelection.description,
  quantity: "1",
  base_price_money: {
    amount: amountCents,
    currency: "CAD",
  },
  note: `Lash Her ${paymentSelection.sku}`,
}
```

Add `taxes` beside `line_items` in the Square order:

```ts
taxes: [
  {
    name: SERVICE_BOOKING_HST_TAX_NAME,
    percentage: SERVICE_BOOKING_HST_PERCENTAGE,
    scope: "LINE_ITEM",
    type: "ADDITIVE",
    uid: SERVICE_BOOKING_HST_TAX_UID,
  },
],
```

Pass `amountCents: taxQuote.expectedAmountCents` and `taxQuote` to `persistPendingCheckout`:

```ts
const persistedCheckout = await dependencies.repository.persistPendingCheckout({
  amountCents: taxQuote.expectedAmountCents,
  hold: input.hold,
  idempotencyKey,
  locationId: env.locationId,
  now,
  orderId,
  paymentLink: paymentLink.payment_link,
  paymentSelection,
  taxQuote,
});
```

- [ ] **Step 6: Persist expected total and tax metadata**

In `persistPendingCheckout`, remove the local line:

```ts
const amountCents = toBookingPaymentAmountCents(input.paymentSelection);
```

Use these checkout order values:

```ts
amountCents: input.amountCents,
```

Keep line items pre-tax by using `input.taxQuote.taxableAmountCents` for unit/total cents:

```ts
lineItems: cart.lineItems.map((lineItem) => ({
  productId: lineItem.productId,
  sku: lineItem.sku,
  description: lineItem.description,
  quantity: lineItem.quantity,
  unitPriceCents: input.taxQuote.taxableAmountCents,
  totalCents: input.taxQuote.taxableAmountCents,
})),
```

Update `providerMetadata`:

```ts
providerMetadata: {
  holdId: input.hold.id,
  holdReference: input.hold.publicReference,
  idempotencyKey: input.idempotencyKey,
  tax: input.taxQuote,
},
```

Update `appointmentHolds.reconciliationMetadata`:

```ts
reconciliationMetadata: {
  idempotencyKey: input.idempotencyKey,
  squareLocationId: input.locationId,
  tax: input.taxQuote,
},
```

- [ ] **Step 7: Run checkout tests and verify they pass**

Run:

```bash
npx tsx --test src/lib/booking/square-service-checkout.test.ts
```

Expected: PASS.

- [ ] **Step 8: Checkpoint**

Run:

```bash
git diff -- src/lib/booking/square-service-checkout.ts src/lib/booking/square-service-checkout.test.ts
```

Expected: checkout creates real Square HST tax, persists expected total, and stores tax metadata. Do not commit unless explicitly requested.

---

### Task 4: Update Square mock totals to include manual taxes

**Files:**
- Modify: `src/lib/booking/square-mock-client.ts`
- Modify: `src/lib/booking/square-mock-client.test.ts`

- [ ] **Step 1: Write failing mock total test**

In `src/lib/booking/square-mock-client.test.ts`, add this test:

```ts
test("mock Square payment link totals include applied manual line item taxes", async () => {
  const client = createMockSquareClient({ scenario: "success" });
  const response = await client.createPaymentLink({
    checkout_options: {
      allow_tipping: true,
      redirect_url: "https://lashher.test/api/booking/square/return",
    },
    idempotency_key: "taxed-square-link-1",
    order: {
      location_id: "LOC123",
      line_items: [
        {
          applied_taxes: [{ tax_uid: "ontario-hst" }],
          base_price_money: { amount: 5000, currency: "CAD" },
          name: "Classic Fill deposit",
          quantity: "1",
        },
      ],
      reference_id: "lh-sq-taxed",
      taxes: [
        {
          name: "Ontario HST",
          percentage: "13",
          scope: "LINE_ITEM",
          type: "ADDITIVE",
          uid: "ontario-hst",
        },
      ],
    },
  });

  const paymentId = new URL(response.payment_link.url).searchParams.get("paymentId");
  assert.equal(paymentId, "mock-square-payment-1");

  const payment = await client.getPayment("mock-square-payment-1");
  const order = await client.getOrder(response.payment_link.order_id ?? "");

  assert.equal(payment.payment.amount_money?.amount, 5650);
  assert.equal(payment.payment.total_money?.amount, 5650);
  assert.equal(order.order.total_money?.amount, 5650);
});
```

- [ ] **Step 2: Run mock client tests and verify failure**

Run:

```bash
npx tsx --test src/lib/booking/square-mock-client.test.ts
```

Expected: FAIL because mock total currently uses only the first line item base amount.

- [ ] **Step 3: Implement mock tax total calculation**

In `src/lib/booking/square-mock-client.ts`, replace:

```ts
const amountCents = options.amountCents ?? request.order?.line_items[0]?.base_price_money.amount ?? 0;
```

with:

```ts
const amountCents = options.amountCents ?? calculateMockOrderTotalCents(request);
```

Add these helpers near `getLocalOrderId`:

```ts
function calculateMockOrderTotalCents(request: SquareCreatePaymentLinkRequest): number {
  const lineItems = request.order?.line_items ?? [];
  const taxesByUid = new Map((request.order?.taxes ?? []).map((tax) => [tax.uid, tax]));

  return lineItems.reduce((total, lineItem) => {
    const quantity = Number.parseInt(lineItem.quantity, 10);
    const safeQuantity = Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
    const lineBaseAmount = lineItem.base_price_money.amount * safeQuantity;
    const taxAmount = (lineItem.applied_taxes ?? []).reduce((taxTotal, appliedTax) => {
      const tax = taxesByUid.get(appliedTax.tax_uid);

      if (tax === undefined) {
        return taxTotal;
      }

      const percentage = Number.parseFloat(tax.percentage);

      if (!Number.isFinite(percentage)) {
        return taxTotal;
      }

      return taxTotal + Math.round(lineBaseAmount * (percentage / 100));
    }, 0);

    return total + lineBaseAmount + taxAmount;
  }, 0);
}
```

- [ ] **Step 4: Run mock client tests and verify pass**

Run:

```bash
npx tsx --test src/lib/booking/square-mock-client.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run checkout mock-mode test again**

Run:

```bash
npx tsx --test src/lib/booking/square-service-checkout.test.ts
```

Expected: PASS. The mock return flow should now create payments whose non-tip amount matches the taxed expected amount.

---

### Task 5: Lock finalizer reconciliation behavior with taxed totals

**Files:**
- Modify: `src/lib/booking/square-payment-finalizer.test.ts`
- Modify if needed: `src/lib/booking/square-payment-finalizer.ts`

- [ ] **Step 1: Add finalizer test for taxed expected amount**

In `src/lib/booking/square-payment-finalizer.test.ts`, add this test near existing amount mismatch tests:

```ts
test("Square finalizer reconciles taxed service booking amount and keeps tip separate", async () => {
  let paidTransitionTipAmount: number | undefined;
  const repository: SquarePaymentFinalizerRepository = {
    async claimSquareEvent() {
      return { duplicate: false };
    },
    async findSquareOrder() {
      return {
        amountCents: 5650,
        id: "order-db-id",
        orderId: "lh-sq-taxed",
        providerOrderId: "order_taxed_123",
        providerPaymentId: null,
        purpose: "appointment_deposit",
        squareLocationId: "loc_123",
        status: "pending",
      };
    },
    async recordSquareEvent() {
      return { duplicate: false };
    },
    async recordSquarePaymentPendingCalendar(input) {
      paidTransitionTipAmount = input.tipAmountCents;
    },
  };
  const finalizer = createSquarePaymentFinalizer({
    finalizeAppointmentPaymentForOrder: async () => ({ ok: true, eventId: "calendar-event-1", status: "booked" }),
    getEnv: createEnv,
    repository,
    sendBookingConfirmationEmailForOrder: async () => {},
    squareClientFactory: () => ({
      async createPaymentLink() {
        throw new Error("Not used");
      },
      async getOrder() {
        throw new Error("Not used");
      },
      async getPayment() {
        return {
          payment: {
            amount_money: { amount: 5650, currency: "CAD" },
            id: "pay_taxed_123",
            order_id: "order_taxed_123",
            status: "COMPLETED",
            tip_money: { amount: 1500, currency: "CAD" },
            total_money: { amount: 7150, currency: "CAD" },
          },
        };
      },
    }),
  });

  const result = await finalizer({ paymentId: "pay_taxed_123", source: "return" });

  assert.equal(result.status, "booked");
  assert.equal(result.finalized, true);
  assert.equal(paidTransitionTipAmount, 1500);
});
```

- [ ] **Step 2: Add finalizer test for no-tax mismatch on taxed order**

Add this test near the new taxed success test:

```ts
test("Square finalizer rejects no-tax payment amount for a taxed service booking order", async () => {
  const recordedStatuses: Array<string | undefined> = [];
  const repository: SquarePaymentFinalizerRepository = {
    async claimSquareEvent() {
      return { duplicate: false };
    },
    async findSquareOrder() {
      return {
        amountCents: 5650,
        id: "order-db-id",
        orderId: "lh-sq-taxed",
        providerOrderId: "order_taxed_123",
        providerPaymentId: null,
        purpose: "appointment_deposit",
        squareLocationId: "loc_123",
        status: "pending",
      };
    },
    async recordSquareEvent(input) {
      recordedStatuses.push(input.status);
      return { duplicate: false };
    },
    async recordSquarePaymentPendingCalendar() {
      throw new Error("No-tax mismatch must not transition to paid");
    },
  };
  const finalizer = createSquarePaymentFinalizer({
    finalizeAppointmentPaymentForOrder: async () => {
      throw new Error("No-tax mismatch must not finalize booking");
    },
    getEnv: createEnv,
    repository,
    sendBookingConfirmationEmailForOrder: async () => {},
    squareClientFactory: () => ({
      async createPaymentLink() {
        throw new Error("Not used");
      },
      async getOrder() {
        throw new Error("Not used");
      },
      async getPayment() {
        return {
          payment: {
            amount_money: { amount: 5000, currency: "CAD" },
            id: "pay_no_tax_123",
            order_id: "order_taxed_123",
            status: "COMPLETED",
          },
        };
      },
    }),
  });

  const result = await finalizer({ paymentId: "pay_no_tax_123", source: "return" });

  assert.equal(result.status, "ignored");
  assert.equal(result.reason, "Square payment amount or currency did not match local order");
  assert.ok(recordedStatuses.includes("amount_or_currency_mismatch"));
});
```

- [ ] **Step 3: Run finalizer tests**

Run:

```bash
npx tsx --test src/lib/booking/square-payment-finalizer.test.ts
```

Expected: PASS. If these fail because the existing finalizer uses `payment.total_money.amount`, stop and keep `amount_money.amount` as the authoritative non-tip comparison.

- [ ] **Step 4: If metadata enrichment is needed, make a minimal finalizer change**

Only if tests reveal missing tip metadata in hold reconciliation, update `recordSquarePaymentPendingCalendar` in `src/lib/booking/square-payment-finalizer.ts` so `appointmentHolds.reconciliationMetadata.squarePayment` includes tip amount:

```ts
reconciliationMetadata: {
  squarePayment: {
    amountCents: input.amountCents,
    orderId: input.providerOrderId ?? input.order.providerOrderId,
    paymentId: input.payment.id,
    status: input.payment.status,
    tipAmountCents: input.tipAmountCents,
  },
},
```

Run the finalizer test again after any change.

- [ ] **Step 5: Checkpoint**

Run:

```bash
git diff -- src/lib/booking/square-payment-finalizer.ts src/lib/booking/square-payment-finalizer.test.ts
```

Expected: tests prove taxed orders reconcile on `base + HST` and tips remain separate. Do not commit unless explicitly requested.

---

### Task 6: Run focused booking payment test suite

**Files:**
- No new source files.
- Validate changed booking/Square tests.

- [ ] **Step 1: Run all focused unit tests touched by this plan**

Run:

```bash
npx tsx --test src/lib/booking/service-tax-policy.test.ts src/lib/booking/square-client.test.ts src/lib/booking/square-service-checkout.test.ts src/lib/booking/square-mock-client.test.ts src/lib/booking/square-payment-finalizer.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run route tests for Square return and webhook regression safety**

Run:

```bash
npx tsx --test src/app/api/booking/square/return/route.test.ts src/app/api/webhooks/square/route.test.ts
```

Expected: PASS. These routes should not require tax-specific changes.

- [ ] **Step 3: Run lint**

Run:

```bash
npm run lint
```

Expected: PASS.

- [ ] **Step 4: Run build if environment variables are available**

Run:

```bash
npm run build
```

Expected: PASS. If `prebuild` fails because local Sanity/env variables are not configured, capture the exact failure and do not claim build success.

- [ ] **Step 5: Final diff review**

Run:

```bash
git diff -- src/lib/booking src/app/api/booking/square/return src/app/api/webhooks/square docs/superpowers
```

Expected: diff is limited to HST policy, Square request typing, checkout construction, mocks, tests, and the spec/plan docs.

---

### Task 7: Production rollout checklist

**Files:**
- No code files.
- Operational checklist only.

- [ ] **Step 1: Let no-tax pending Square Payment Links drain if possible**

Before deployment, identify recent service booking holds in `payment_pending` with Square links created before this change. Those links may still charge no tax. Prefer allowing them to expire or manually contacting customers before deployment.

- [ ] **Step 2: Verify Vercel/Square webhook delivery separately**

In Vercel project settings and protection/firewall configuration, ensure `POST /api/webhooks/square` is not blocked or rate-limited. The app route does not emit HTTP 429, so Square webhook 429 responses are likely platform/protection-level responses.

- [ ] **Step 3: Smoke test staging or preview with mock mode**

Use the existing booking flow in mock Square mode and verify:

```text
Selected amount: $50.00
Expected HST: $6.50
Expected non-tip Square amount: $56.50
Optional tip: recorded separately when present
Booking finalization: booked or paid_calendar_pending according to calendar state
```

- [ ] **Step 4: Production monitor after deploy**

After deploying, monitor logs for:

```text
[square-return] Square payment reconciliation failed
[square-webhook] Square payment finalization failed
amount_or_currency_mismatch
```

Expected: no new mismatch logs for newly created taxed Square Payment Links.

---

## Self-Review

- Spec coverage: This plan covers Ontario HST 13%, amount paid today only, tips excluded, real Square tax representation, expected non-tip total persistence, tax metadata, idempotency versioning, mock behavior, finalizer reconciliation, and rollout notes.
- Placeholder scan: The plan contains no intentionally blank implementation sections and no deferred code requirements.
- Type consistency: `ServiceBookingHstQuote`, `calculateServiceBookingHstQuote`, `SERVICE_BOOKING_HST_*` constants, Square `taxes`, Square `applied_taxes`, and `taxQuote` names are consistent across tasks.
