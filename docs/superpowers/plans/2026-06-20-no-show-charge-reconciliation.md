# No-Show Charge Lifecycle, Webhook Validation & Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make no-show charge execution financially validated, retry-safe, and observable across Square publish responses, webhooks, and reconciliation cron.

**Architecture:** Add provider read methods for Square invoices/payments, validate terminal webhook outcomes against local no-show records before state transitions, introduce stale `charge_pending` recovery, implement real reconciliation queries, and harden cron auth. This plan depends on card-on-file intake hardening and admin audit plans.

**Tech Stack:** TypeScript, Square REST Invoices/Payments APIs, Drizzle/PostgreSQL, Next.js App Router, Node `tsx --test`, Vercel cron.

---

## Plan Set Position

This is **Plan 4 of 5** and depends on:

- `2026-06-20-card-on-file-intake-hardening.md`
- `2026-06-20-no-show-admin-audit.md`

Production gate after this plan: no-show charge lifecycle is staging-ready, but production enablement waits for Plan 5 sandbox/staging certification.

---

## Files

- Modify: `src/lib/payments/square/invoice-client.ts`
- Modify: `src/lib/payments/square/invoice-client.test.ts`
- Modify: `src/lib/payments/square/payments-client.ts`
- Modify: `src/lib/payments/square/payments-client.test.ts`
- Modify: `src/lib/booking/payments/service-no-show-invoice.ts`
- Modify: `src/lib/booking/payments/service-no-show-invoice.test.ts`
- Modify: `src/lib/booking/payments/service-no-show-charge-finalizer.ts`
- Modify: `src/lib/booking/payments/service-no-show-charge-finalizer.test.ts`
- Modify: `src/lib/private-db/card-on-file-repository.ts`
- Modify: `src/lib/booking/payments/service-reconciliation-monitor.ts`
- Modify: `src/lib/booking/payments/service-reconciliation-monitor.test.ts`
- Modify: `src/app/api/admin/payment-reconciliation/route.ts`
- Modify: `src/app/api/admin/payment-reconciliation/route.test.ts`
- Modify: `src/app/api/webhooks/square/route.ts`
- Modify: `src/app/api/webhooks/square/route.test.ts`

---

## Task 1: Add Square invoice/payment read methods for reconciliation

**Files:**

- Modify: `src/lib/payments/square/invoice-client.ts`
- Modify: `src/lib/payments/square/invoice-client.test.ts`
- Modify: `src/lib/payments/square/payments-client.ts`
- Modify: `src/lib/payments/square/payments-client.test.ts`

- [ ] **Step 1: Add invoice get test**

In `invoice-client.test.ts`, add:

```ts
test("getSquareInvoice URL-encodes invoice IDs", async () => {
  const fetchMock = mockSquareFetch({
    invoice: { id: "inv/1", status: "PAID", order_id: "order-1", version: 2 },
  });
  const client = createSquareInvoicesClient(
    { environment: "sandbox", accessToken: "token" },
    fetchMock.fetch,
  );

  await client.getInvoice("inv/1");

  assert.equal(
    fetchMock.requests[0]?.url,
    "https://connect.squareupsandbox.com/v2/invoices/inv%2F1",
  );
});
```

- [ ] **Step 2: Add payment get test**

In `payments-client.test.ts`, add:

```ts
test("getSquarePayment returns amount, currency, customer, card, and order fields", async () => {
  const fetchMock = mockSquareFetch({
    payment: {
      id: "pay-1",
      status: "COMPLETED",
      order_id: "order-1",
      customer_id: "cust-1",
      source_type: "CARD",
      card_details: { card: { id: "ccof-1" } },
      amount_money: { amount: 12500, currency: "CAD" },
    },
  });
  const client = createSquarePaymentsClient(
    { environment: "sandbox", accessToken: "token" },
    fetchMock.fetch,
  );

  const result = await client.getPayment("pay-1");

  assert.equal(result.payment.customer_id, "cust-1");
  assert.equal(result.payment.card_details?.card?.id, "ccof-1");
});
```

- [ ] **Step 3: Implement client methods**

Add to `SquareInvoicesClient`:

```ts
getInvoice(invoiceId: string): Promise<SquareGetInvoiceResponse>;
```

Implement with GET:

```ts
async getInvoice(invoiceId) {
  return getSquare<SquareGetInvoiceResponse>(
    env,
    `/v2/invoices/${encodeURIComponent(invoiceId)}`,
    isSquareGetInvoiceResponse,
  );
}
```

Add to `SquarePaymentsClient`:

```ts
getPayment(paymentId: string): Promise<SquareGetPaymentResponse>;
```

Implement with GET:

```ts
async getPayment(paymentId) {
  return getSquare<SquareGetPaymentResponse>(
    env,
    `/v2/payments/${encodeURIComponent(paymentId)}`,
    isSquareGetPaymentResponse,
  );
}
```

Keep error messages sanitized exactly like existing POST methods.

- [ ] **Step 4: Run client tests**

Run:

```bash
npx tsx --test src/lib/payments/square/invoice-client.test.ts src/lib/payments/square/payments-client.test.ts
```

Expected: PASS.

---

## Task 2: Validate no-show webhook terminal outcomes against local financial invariants

**Files:**

- Modify: `src/lib/booking/payments/service-no-show-charge-finalizer.ts`
- Modify: `src/lib/booking/payments/service-no-show-charge-finalizer.test.ts`
- Modify: `src/lib/private-db/card-on-file-repository.ts`

- [ ] **Step 1: Add mismatch tests**

Add tests to `service-no-show-charge-finalizer.test.ts`:

```ts
test("invoice payment_made with mismatched amount is ignored and alerts", async () => {
  const fixture = createNoShowFinalizerFixture({
    maxChargeCents: 12500,
    currency: "CAD",
  });
  const event = squareInvoicePaymentMadeEvent({
    amountCents: 12000,
    currency: "CAD",
    customerId: "cust-1",
    cardId: "ccof-1",
  });

  const result = await finalizeNoShowCharge({ event }, fixture.dependencies);

  assert.equal(result.finalized, false);
  assert.equal(result.status, "ignored");
  assert.equal(fixture.repository.finalizeCalls.length, 0);
  assert.equal(
    fixture.alerts.messages[0]?.category,
    "no_show_charge_provider_mismatch",
  );
});

test("payment completed with matching amount currency customer and card marks charged", async () => {
  const fixture = createNoShowFinalizerFixture({
    maxChargeCents: 12500,
    currency: "CAD",
    squareCustomerId: "cust-1",
    squareCardId: "ccof-1",
  });
  const event = squarePaymentUpdatedEvent({
    amountCents: 12500,
    currency: "CAD",
    customerId: "cust-1",
    cardId: "ccof-1",
    status: "COMPLETED",
  });

  const result = await finalizeNoShowCharge({ event }, fixture.dependencies);

  assert.equal(result.finalized, true);
  assert.equal(result.status, "charged");
});
```

- [ ] **Step 2: Extend no-show record detail**

In `service-no-show-invoice.ts`, add fields to `NoShowChargeRecordDetail`:

```ts
squareCustomerId?: string;
savedPaymentMethodId?: string;
policyAcceptanceId?: string;
```

Map them in `toNoShowChargeRecordDetail` in `card-on-file-repository.ts`:

```ts
squareCustomerId: row.squareCustomerId ?? undefined,
savedPaymentMethodId: row.savedPaymentMethodId ?? undefined,
policyAcceptanceId: row.policyAcceptanceId ?? undefined,
```

- [ ] **Step 3: Parse and validate provider facts before terminal success**

In `service-no-show-charge-finalizer.ts`, add:

```ts
function validateProviderMatch(
  record: NoShowChargeRecordDetail,
  event: VerifiedSquareWebhookEvent,
): { ok: true } | { ok: false; reason: string } {
  const facts = extractPaymentFacts(event);

  if (
    facts.amountCents !== undefined &&
    facts.amountCents !== record.maxChargeCents
  ) {
    return { ok: false, reason: "amount_mismatch" };
  }
  if (facts.currency !== undefined && facts.currency !== record.currency) {
    return { ok: false, reason: "currency_mismatch" };
  }
  if (
    record.squareCustomerId !== undefined &&
    facts.customerId !== undefined &&
    facts.customerId !== record.squareCustomerId
  ) {
    return { ok: false, reason: "customer_mismatch" };
  }
  if (
    record.squareCardId !== undefined &&
    facts.cardId !== undefined &&
    facts.cardId !== record.squareCardId
  ) {
    return { ok: false, reason: "card_mismatch" };
  }

  return { ok: true };
}
```

Call it before `buildRecordUpdate` for success outcomes. On mismatch, record an ignored webhook event and alert:

```ts
await alerts.alert({
  category: "no_show_charge_provider_mismatch",
  severity: "error",
  message: "Square no-show webhook did not match local charge invariants",
  context: {
    eventId: event.eventId,
    noShowChargeRecordId: record.id,
    reason: validation.reason,
  },
});
return {
  duplicateEvent: false,
  finalized: false,
  noShowChargeRecordId: record.id,
  retryable: false,
  status: "ignored",
};
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
npx tsx --test src/lib/booking/payments/service-no-show-charge-finalizer.test.ts
```

Expected: PASS.

---

## Task 3: Add stale `charge_pending` recovery and controlled retry

**Files:**

- Modify: `src/lib/booking/payments/service-no-show-invoice.ts`
- Modify: `src/lib/booking/payments/service-no-show-invoice.test.ts`
- Modify: `src/lib/private-db/card-on-file-repository.ts`

- [ ] **Step 1: Add stale pending test**

In `service-no-show-invoice.test.ts`, add:

```ts
test("stale charge_pending with DRAFT invoice can be reclaimed for retry", async () => {
  const fixture = createNoShowInvoiceFixture({
    recordStatus: "charge_pending",
    providerStatus: "publish_pending",
    updatedAt: new Date("2026-06-20T11:00:00Z"),
  });
  fixture.squareInvoices.getInvoiceResponse = {
    invoice: { id: "inv-1", status: "DRAFT", order_id: "order-1", version: 2 },
  };

  const result = await chargeNoShowInvoice(
    {
      amountCents: fixture.record.maxChargeCents,
      idempotencyKey: "retry-stale-pending",
      noShowChargeRecordId: fixture.record.id,
      operatorId: "staff-nataliea",
      reason: "Retry after stale pending publish.",
    },
    { ...fixture.dependencies, now: new Date("2026-06-20T12:00:00Z") },
  );

  assert.equal(result.chargeStatus, "charge_pending");
  assert.equal(fixture.squareInvoices.publishCalls.length, 1);
});
```

- [ ] **Step 2: Add repository recovery method**

Extend `NoShowInvoiceRepository`:

```ts
recoverStaleNoShowChargePending(input: {
  noShowChargeRecordId: string;
  now: Date;
}): Promise<NoShowChargeRecordDetail | null>;
```

Implement it so it locks the record and changes only stale `charge_pending` records with `providerStatus = 'publish_pending'` back to `provider_draft_created`.

- [ ] **Step 3: Check Square invoice state before retrying stale pending**

At the start of `chargeNoShowInvoice`, if `record.status === "charge_pending"`, fetch the Square invoice. If Square says `DRAFT`, call `recoverStaleNoShowChargePending` and continue with the recovered record. If Square says `PAID`, return `charge_pending` and rely on webhook/finalizer. If Square says a terminal failure status, update the local record to `charge_failed`.

Use a constant:

```ts
const STALE_CHARGE_PENDING_MS = 15 * 60 * 1000;
```

Only retry stale rows older than this threshold.

- [ ] **Step 4: Run focused tests**

Run:

```bash
npx tsx --test src/lib/booking/payments/service-no-show-invoice.test.ts
```

Expected: PASS.

---

## Task 4: Implement real reconciliation checks and avoid legacy false positives

**Files:**

- Modify: `src/lib/booking/payments/service-reconciliation-monitor.ts:260-568`
- Modify: `src/lib/booking/payments/service-reconciliation-monitor.test.ts`

- [x] **Step 1: Add repository tests for card-on-file filters**

Add in-memory monitor tests and DB-backed tests that prove legacy booked holds are ignored:

```ts
test("reconciliation does not flag legacy booked holds without card-on-file markers", async () => {
  const repository = createInMemoryReconciliationRepository({
    bookedAppointmentsWithoutSavedPaymentMethod: [],
    bookedAppointmentsWithoutPolicyAcceptance: [],
    bookedAppointmentsWithoutNoShowChargeRecord: [],
  });
  const monitor = createServiceReconciliationMonitor({ repository });

  const summary = await monitor.run({ now: new Date("2026-06-20T12:00:00Z") });

  assert.equal(summary.ok, true);
});
```

- [x] **Step 2: Replace stubbed checks**

> Implemented as specified, with one review-driven refinement: `findFailedNoShowCharges` now excludes stale, unalerted `charge_failed` records so they are surfaced only by `no_show_charge_failed_not_alerted`, preventing duplicate findings for the same record.

Implement `findConfirmedBookingsWithoutSavedCard`:

```ts
const rows = await db
  .select({ holdId: appointmentHolds.id })
  .from(appointmentHolds)
  .where(
    and(
      eq(appointmentHolds.status, "booked"),
      eq(appointmentHolds.paymentProvider, "square"),
      isNotNull(appointmentHolds.cardOnFileStatus),
      isNull(appointmentHolds.savedPaymentMethodId),
    ),
  );
return rows;
```

Implement `findConfirmedBookingsWithoutNoShowInvoice` for **linked** no-show records only:

```ts
const rows = await db
  .select({ holdId: appointmentHolds.id })
  .from(appointmentHolds)
  .innerJoin(
    bookingNoShowChargeRecords,
    eq(appointmentHolds.noShowChargeRecordId, bookingNoShowChargeRecords.id),
  )
  .where(
    and(
      eq(appointmentHolds.status, "booked"),
      eq(appointmentHolds.paymentProvider, "square"),
      isNotNull(appointmentHolds.cardOnFileStatus),
      isNull(bookingNoShowChargeRecords.squareInvoiceId),
      ne(bookingNoShowChargeRecords.status, "manual_followup"),
    ),
  );
return rows;
```

Missing no-show charge records are surfaced by the separate `booked_without_no_show_charge_record` finding (`findBookedAppointmentsWithoutNoShowChargeRecord`), not by the missing-invoice check.

Implement `findFailedNoShowCharges`:

```ts
const rows = await db
  .select({
    holdId: bookingNoShowChargeRecords.holdId,
    orderId: bookingNoShowChargeRecords.squareOrderId,
  })
  .from(bookingNoShowChargeRecords)
  .where(eq(bookingNoShowChargeRecords.status, "charge_failed"));
return rows.map((row) => ({
  holdId: row.holdId,
  orderId: row.orderId ?? undefined,
}));
```

Scope `findSquarePaymentsPendingTooLong` to current card-on-file records and exclude legacy Square Payment Link holds:

```ts
and(
  eq(appointmentHolds.paymentProvider, "square"),
  eq(appointmentHolds.status, "payment_pending"),
  isNotNull(appointmentHolds.cardOnFileStatus),
  isNull(appointmentHolds.squarePaymentLinkId),
  lt(appointmentHolds.updatedAt, threshold),
);
```

Scope `findPaidBookingsNotBooked` to current Square card-on-file appointments and exclude Helcim and legacy Square Payment Link-era rows:

```ts
and(
  eq(checkoutOrders.status, "paid"),
  eq(checkoutOrders.paymentProvider, "square"),
  inArray(checkoutOrders.purpose, APPOINTMENT_CHECKOUT_ORDER_PURPOSES),
  notInArray(
    checkoutOrders.calendarFinalizationStatus,
    BOOKED_CALENDAR_STATUSES,
  ),
  lt(checkoutOrders.paidAt, threshold),
  eq(appointmentHolds.paymentProvider, "square"),
  isNotNull(appointmentHolds.cardOnFileStatus),
  isNull(appointmentHolds.squarePaymentLinkId),
);
```

- [x] **Step 3: Add stale charge pending category**

Extend `ServiceReconciliationFinding["category"]` with:

```ts
| "no_show_charge_pending_too_long"
```

Add repository method:

```ts
findNoShowChargesPendingTooLong(now: Date): Promise<Array<{ holdId: string; noShowChargeRecordId: string; status: NoShowChargeStatus }>>;
```

Use a threshold of 15 minutes and query `booking_no_show_charge_records.status = 'charge_pending'`, `providerStatus = 'publish_pending'`, with `updatedAt` older than the threshold.

- [x] **Step 4: Run monitor tests**

Run:

```bash
npx tsx --test src/lib/booking/payments/service-reconciliation-monitor.test.ts
```

Expected: PASS; DB-backed tests still skip when `TEST_DATABASE_URL` is absent.

---

## Task 5: Harden reconciliation cron auth and webhook alert noise

**Files:**

- Modify: `src/app/api/admin/payment-reconciliation/route.ts`
- Modify: `src/app/api/admin/payment-reconciliation/route.test.ts`
- Modify: `src/app/api/webhooks/square/route.ts`
- Modify: `src/app/api/webhooks/square/route.test.ts`

- [ ] **Step 1: Add timing-safe cron auth test**

In `payment-reconciliation/route.test.ts`, add a test with a same-length wrong secret and assert 401:

```ts
test("payment reconciliation cron auth rejects same-length wrong bearer token", async () => {
  const handler = createPaymentReconciliationGetHandler(
    createRouteDeps({ secrets: ["correct-secret"] }),
  );
  const response = await handler(
    new Request("https://example.com/api/admin/payment-reconciliation", {
      headers: { authorization: "Bearer wronggg-secret" },
    }),
  );

  assert.equal(response.status, 401);
});
```

- [ ] **Step 2: Implement timing-safe string comparison**

Use the same `timingSafeEqual` pattern as the admin no-show route:

```ts
function timingSafeStringEqual(expected: string, received: string): boolean {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(received, "utf8");
  if (expectedBuffer.length !== receivedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, receivedBuffer);
}
```

Then:

```ts
return cronSecrets.some((secret) =>
  timingSafeStringEqual(secret, authorization.slice("Bearer ".length)),
);
```

- [ ] **Step 3: Avoid no-show unknown alerts for legacy payment events**

In `src/app/api/webhooks/square/route.ts`, call no-show finalizer only when an invoice ID or payment/order ID first matches a no-show record. Add this dependency method:

```ts
isKnownNoShowChargeEvent(event: VerifiedSquareWebhookEvent): Promise<boolean>;
```

Return `null` without alerting when the event is a normal service Payment Link event.

- [ ] **Step 4: Run route tests**

Run:

```bash
npx tsx --test src/app/api/admin/payment-reconciliation/route.test.ts src/app/api/webhooks/square/route.test.ts
```

Expected: PASS.

---

## Task 6: Full validation for this plan

**Files:**

- No new files

- [ ] **Step 1: Run unit tests**

Run:

```bash
npm run test:unit
```

Expected: PASS, with DB-backed tests skipped unless `TEST_DATABASE_URL` is set.

- [ ] **Step 2: Run lint and build**

Run:

```bash
npm run lint
npm run build
```

Expected: lint has no new errors and build succeeds.

- [ ] **Step 3: Run DB-backed tests against staging clone**

Run:

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" npx tsx --test src/lib/private-db/card-on-file-repository.db.test.ts src/lib/booking/payments/service-reconciliation-monitor.test.ts
```

Expected: DB-backed repository and reconciliation tests pass.

---

## Plan Self-Review Checklist

- Covers: webhook amount/currency/customer/card validation, stale `charge_pending` recovery, real reconciliation checks, legacy false-positive filtering, cron timing-safe auth, webhook alert noise.
- Defers by design: live Square sandbox/staging proof and production flag enablement.
- No production enablement occurs in this plan.
