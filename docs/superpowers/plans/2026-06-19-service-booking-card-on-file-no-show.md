# Service Booking Card-on-File + No-Show Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Historical note:** At the time this plan was written, service bookings were confirmed via Square Payment Link. That path is now legacy/superseded; the production-ready flow described here uses Square card-on-file intake and Square invoice-based no-show enforcement.

**Goal:** Replace the legacy service-booking Square Payment Link confirmation path (current at plan-writing time, now superseded) with a Square card-on-file flow that requires explicit policy acceptance, persists only private Square references/audit metadata, creates a recoverable no-show charge instrument, and lets staff manually enforce no-show charges.

> **Implementation note (superseded):** This plan originally described a Square Payments API fallback for direct card-on-file no-show charges. The current implementation uses Square Invoices for no-show enforcement; that Payments API fallback is not wired.

**Architecture:** Implement this as a phased booking/payment saga. Phase 0 hardens the current legacy Square Payment Link reconciliation path so production cannot keep creating stuck pending records. Later phases add a feature-flagged Square Web Payments SDK card-save flow, server-side Square Customers/Cards/Invoices adapters, private Postgres card/policy/no-show records, admin no-show charge commands, Square webhook finalizers, and cron-style reconciliation alerts. Private Postgres remains the source of truth; Square stores cards and processes charges; Google Calendar remains the final booking calendar.

**Tech Stack:** Next.js 16 App Router, React client components, TypeScript, Drizzle/PostgreSQL private DB, Square REST APIs (`Customers`, `Cards`, `Orders`, `Invoices`, and `Payments` for non-no-show use only), Square Web Payments SDK, Node `tsx --test`, Playwright, Vercel cron.

---

## Assumptions Locked For This Plan

- The user-provided design is the approved target direction.
- Service bookings continue to create a temporary hold before payment/card work.
- The client must explicitly accept the no-show/cancellation policy before card tokenization/card save is submitted.
- Card save uses Square Web Payments SDK tokenization with `verificationDetails.intent = "STORE"`, then server-side `POST /v2/cards` with `source_id`, `customer_id`, and optional `verification_token`.
- Booking confirmation requires a saved Square card, persisted policy acceptance, finalized Google Calendar event, and either a draft Square no-show invoice/order or a local no-show charge record that can reliably create the Square charge instrument later.
- This plan follows the user recommendation: create the Square no-show draft invoice/order at booking confirmation when sandbox validation confirms the invoice behavior. The current implementation uses Square Invoices for no-show enforcement; the Payments API card-on-file fallback described in earlier drafts is not wired.
- Admin no-show enforcement is manual. No automatic no-show detection or automatic charge without staff action ships in v1.
- Do not commit during execution unless the user explicitly requests it. Use the checkpoint steps instead of automatic commits.

## Scope Decomposition

This is a multi-phase program. Execute phases in order. Each phase should leave the application in a deployable state.

1. **Phase 0:** harden current Square return/webhook reconciliation and add stuck-order visibility.
2. **Phase 1:** add private DB model, Square card/customer/invoice clients, policy/no-show domain modules.
3. **Phase 2:** add customer card-on-file booking confirmation flow and UI behind a feature flag.
4. **Phase 3:** add admin no-show charge command and Square invoice/payment reconciliation.
5. **Phase 4:** add monitor/alerts, docs, sandbox smoke matrix, and legacy path cleanup gates.

---

## File Structure

### New files

- `src/lib/booking/payments/service-square-id-resolution.ts`
  Pure helpers for distinguishing local `lh-sq-*` IDs from Square provider IDs and resolving return/webhook lookup intent.
- `src/lib/booking/payments/service-payment-alerts.ts`
  Structured operational alert boundary. Starts with safe `console.error`/`console.warn` payloads and optional admin email hook.
- `src/lib/booking/payments/service-reconciliation-monitor.ts`
  Queries private DB for stuck or inconsistent service-booking payment/no-show states.
- `src/lib/booking/payments/service-card-on-file.ts`
  Booking card-on-file saga: validate hold/policy, create/reuse Square customer, save card, persist audit records, create no-show charge record/invoice, finalize Calendar booking.
- `src/lib/booking/payments/service-no-show-policy.ts`
  Policy versioning, text hash validation, maximum charge calculation, and audit metadata normalization.
- `src/lib/booking/payments/service-no-show-invoice.ts`
  Square draft no-show invoice/order orchestration and later publish/update command.
- `src/lib/booking/payments/service-no-show-charge-finalizer.ts`
  Finalizes Square invoice/payment webhooks for no-show charges.
- `src/lib/payments/square/cards-client.ts`
  Server-only Square Cards API request/response types and methods.
- `src/lib/payments/square/customers-client.ts`
  Server-only Square Customers API request/response types and methods.
- `src/lib/payments/square/invoice-client.ts`
  Server-only Square Orders/Invoices API request/response types and methods.
- `src/lib/payments/square/payments-client.ts`
  Server-only Square Payments API client. Direct card-on-file no-show charging is not wired; no-show enforcement uses Square Invoices.
- `src/app/api/booking/square/config/route.ts`
  Public-safe Square Web Payments SDK config endpoint.
- `src/app/api/booking/card-on-file/route.ts`
  Customer-facing route that accepts hold reference, card token, verification token, billing/cardholder data, and policy acceptance.
- `src/app/api/admin/appointments/[id]/no-show/route.ts`
  Protected staff command route to mark a booked appointment as no-show and trigger/record the charge attempt.
- `src/app/api/admin/payment-reconciliation/route.ts`
  Protected monitor route for Vercel cron/manual staff checks.
- `src/components/booking/square-card-on-file-form.tsx`
  Client component for loading Square.js, rendering card form, tokenizing with STORE intent, and posting to the card-on-file route.

### Modified files

- `src/lib/private-db/schema.ts`
  Add card-on-file/no-show enums, tables, and appointment/order references.
- `src/lib/env/private-checkout.ts` and `src/lib/env/private-checkout.test.ts`
  Add feature flags and non-secret Square application ID configuration.
- `src/lib/booking/square-payment-finalizer.ts` and tests
  Fix local-ID/provider-ID confusion and return richer finalizer outcomes.
- `src/app/api/booking/square/return/route.ts` and tests
  Treat Square return as legacy best-effort; never call Square with local IDs.
- `src/app/api/webhooks/square/route.ts` and tests
  Dispatch service payment, training invoice, and no-show invoice/payment events; inspect finalizer outcomes.
- `src/lib/booking/square-client.ts` and tests
  Keep legacy Payment Link methods (current at plan-writing time) and share low-level Square request helpers if useful.
- `src/lib/booking/square-mock-client.ts` and tests
  Add mock customer/card/invoice/payment behavior for local and route tests.
- `src/components/booking/booking-flow.tsx` and tests
  Switch feature-flagged service booking from redirect checkout to policy + Square card-on-file confirmation.
- `vercel.json`
  Add payment reconciliation cron route.
- Docs: `docs/booking-system-architecture-reference.md`, `docs/booking-system-runbook.md`, `docs/square-service-booking-setup.md`, `docs/launch-readiness-checklist.md`.

---

## Phase 0 — Legacy Square Hardening

### Task 1: Add Square ID classification helpers

**Files:**

- Create: `src/lib/booking/payments/service-square-id-resolution.ts`
- Create: `src/lib/booking/payments/service-square-id-resolution.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/booking/payments/service-square-id-resolution.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  classifySquareReturnOrderId,
  isLocalServiceBookingOrderId,
} from "./service-square-id-resolution";

test("detects Lash Her local Square service order ids", () => {
  assert.equal(isLocalServiceBookingOrderId("lh-sq-abc123"), true);
  assert.equal(isLocalServiceBookingOrderId(" LH-SQ-abc123 "), false);
  assert.equal(isLocalServiceBookingOrderId("square-order-123"), false);
  assert.equal(isLocalServiceBookingOrderId(undefined), false);
});

test("classifies return order identifiers without treating local ids as provider ids", () => {
  assert.deepEqual(classifySquareReturnOrderId("lh-sq-local-1"), {
    localOrderId: "lh-sq-local-1",
    providerOrderId: undefined,
  });

  assert.deepEqual(classifySquareReturnOrderId("square-order-1"), {
    localOrderId: undefined,
    providerOrderId: "square-order-1",
  });

  assert.deepEqual(classifySquareReturnOrderId(undefined), {
    localOrderId: undefined,
    providerOrderId: undefined,
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npx tsx --test src/lib/booking/payments/service-square-id-resolution.test.ts
```

Expected: FAIL because `service-square-id-resolution.ts` does not exist.

- [ ] **Step 3: Implement the helper**

Create `src/lib/booking/payments/service-square-id-resolution.ts`:

```ts
export interface SquareReturnOrderIdClassification {
  localOrderId?: string;
  providerOrderId?: string;
}

const LOCAL_SERVICE_BOOKING_ORDER_ID_PATTERN = /^lh-sq-[A-Za-z0-9_-]+$/;

export function isLocalServiceBookingOrderId(
  value: string | undefined,
): boolean {
  return (
    typeof value === "string" &&
    LOCAL_SERVICE_BOOKING_ORDER_ID_PATTERN.test(value)
  );
}

export function classifySquareReturnOrderId(
  value: string | undefined,
): SquareReturnOrderIdClassification {
  if (value === undefined || value.trim().length === 0) {
    return {};
  }

  const trimmed = value.trim();

  if (isLocalServiceBookingOrderId(trimmed)) {
    return { localOrderId: trimmed };
  }

  return { providerOrderId: trimmed };
}
```

- [ ] **Step 4: Run focused test and verify it passes**

Run:

```bash
npx tsx --test src/lib/booking/payments/service-square-id-resolution.test.ts
```

Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run:

```bash
git diff -- src/lib/booking/payments/service-square-id-resolution.ts src/lib/booking/payments/service-square-id-resolution.test.ts
```

Expected: diff contains only the helper and its tests.

### Task 2: Fix return-route/local-order reconciliation bug

**Files:**

- Modify: `src/lib/booking/square-payment-finalizer.ts`
- Modify: `src/lib/booking/square-payment-finalizer.test.ts`
- Modify: `src/app/api/booking/square/return/route.test.ts`

- [ ] **Step 1: Add a failing finalizer test for local IDs without payment IDs**

In `src/lib/booking/square-payment-finalizer.test.ts`, add a test that calls the finalizer with `{ orderId: "lh-sq-local", source: "return" }`, configures a repository row with `providerOrderId: "square-order-123"`, and a Square client whose `getOrder` throws if called with `lh-sq-local`.

Expected assertion shape:

```ts
assert.equal(calledSquareOrderIds.includes("lh-sq-local"), false);
assert.equal(result.finalized, false);
assert.equal(result.status, "pending_verification");
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npx tsx --test src/lib/booking/square-payment-finalizer.test.ts
```

Expected: FAIL because current `resolveSquarePaymentLookup()` can call `getOrder(orderId)` with the local ID.

- [ ] **Step 3: Update the finalizer result type**

In `src/lib/booking/square-payment-finalizer.ts`, extend `SquarePaymentFinalizerResult["status"]` to include:

```ts
| "manual_review"
| "pending_verification"
```

Keep existing statuses to avoid breaking the confirmation page.

- [ ] **Step 4: Resolve local IDs through Postgres before Square**

Update `resolveSquarePaymentLookup()` and surrounding call flow so:

1. If `paymentId` is present, use `getPayment(paymentId)` as today.
2. If only `orderId` is present and it is local `lh-sq-*`, call `repository.findSquareOrder({ localOrderId })` first.
3. If the local row has `providerOrderId`, only that provider ID may be used with Square.
4. If no provider ID exists, record an event with status `pending_verification` and return `{ finalized: false, status: "pending_verification" }`.
5. Never pass a local `lh-sq-*` value into `squareClient.getOrder()`.

- [ ] **Step 5: Add structured logs for unresolved return hints**

Log safe fields only:

```ts
console.warn("[square-finalizer] Square return could not be fully resolved", {
  hasLocalOrderId: input.orderId?.startsWith("lh-sq-") === true,
  hasPaymentId: input.paymentId !== undefined,
  source: input.source,
  status: "pending_verification",
});
```

Do not log raw query strings, secrets, card tokens, or webhook bodies.

- [ ] **Step 6: Run finalizer and return route tests**

Run:

```bash
npx tsx --test src/lib/booking/square-payment-finalizer.test.ts src/app/api/booking/square/return/route.test.ts
```

Expected: PASS.

### Task 3: Make Square webhook inspect service finalizer outcomes

**Files:**

- Modify: `src/app/api/webhooks/square/route.ts`
- Modify: `src/app/api/webhooks/square/route.test.ts`
- Create: `src/lib/booking/payments/service-payment-alerts.ts`
- Create: `src/lib/booking/payments/service-payment-alerts.test.ts`

- [ ] **Step 1: Add alert boundary tests**

Create `src/lib/booking/payments/service-payment-alerts.test.ts` with tests proving alert payloads are redacted and categorized:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { createServicePaymentAlertLogger } from "./service-payment-alerts";

test("service payment alerts emit safe structured payloads", async () => {
  const calls: unknown[] = [];
  const alerts = createServicePaymentAlertLogger({
    logError: (...args: unknown[]) => calls.push(args),
    logWarn: (...args: unknown[]) => calls.push(args),
  });

  await alerts.alert({
    category: "square_webhook_non_finalized",
    severity: "warning",
    message: "Webhook did not finalize booking",
    context: {
      eventId: "evt_123",
      orderId: "lh-sq-local",
      rawCardToken: "cnon:do-not-log",
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    "[service-payment-alert] Webhook did not finalize booking",
    {
      category: "square_webhook_non_finalized",
      context: {
        eventId: "evt_123",
        orderId: "lh-sq-local",
        rawCardToken: "[redacted]",
      },
      severity: "warning",
    },
  ]);
});
```

- [ ] **Step 2: Implement `service-payment-alerts.ts`**

Implement a small dependency-injected logger with these exported types:

```ts
export type ServicePaymentAlertSeverity = "info" | "warning" | "error";

export type ServicePaymentAlertCategory =
  | "square_return_pending_verification"
  | "square_webhook_non_finalized"
  | "square_webhook_retryable_failure"
  | "square_amount_or_currency_mismatch"
  | "booking_without_saved_card"
  | "booking_without_no_show_record"
  | "no_show_charge_failed"
  | "stuck_payment_state";
```

Use a sensitive-key regex matching `card|token|secret|cvv|cvc|pan|raw` and replace values with `"[redacted]"`.

- [ ] **Step 3: Add route tests for non-finalized service finalizer results**

In `src/app/api/webhooks/square/route.test.ts`, add tests for:

1. `finalizeSquarePayment()` returns `{ finalized: false, duplicateEvent: false, status: "pending_verification" }` → response `200`, alert warning.
2. `finalizeSquarePayment()` returns `{ finalized: false, duplicateEvent: false, status: "ignored", reason: "Square payment could not be resolved" }` → response `200`, alert warning.
3. `finalizeSquarePayment()` throws → response `503`, alert error.

- [ ] **Step 4: Update webhook dependencies and route behavior**

Add `alerts` to `SquareWebhookDependencies`. After `finalizeSquarePayment()`:

```ts
const result = await dependencies.finalizeSquarePayment({
  event,
  source: "webhook",
});

if (!result.finalized && !result.duplicateEvent) {
  await dependencies.alerts.alert({
    category: "square_webhook_non_finalized",
    severity: "warning",
    message: "Square webhook did not finalize service booking",
    context: {
      eventId: event.eventId,
      eventType: event.eventType,
      orderId: result.orderId ?? event.orderId,
      reason: result.reason,
      status: result.status,
    },
  });
}
```

Return `503` only for thrown/retryable infrastructure failures. Return `200` for valid webhook events that require manual review after alerting.

- [ ] **Step 5: Run webhook and alert tests**

Run:

```bash
npx tsx --test src/app/api/webhooks/square/route.test.ts src/lib/booking/payments/service-payment-alerts.test.ts
```

Expected: PASS.

### Task 4: Add reconciliation monitor route and cron shell

**Files:**

- Create: `src/lib/booking/payments/service-reconciliation-monitor.ts`
- Create: `src/lib/booking/payments/service-reconciliation-monitor.test.ts`
- Create: `src/app/api/admin/payment-reconciliation/route.ts`
- Create: `src/app/api/admin/payment-reconciliation/route.test.ts`
- Modify: `src/lib/env/private-checkout.ts`
- Modify: `src/lib/env/private-checkout.test.ts`
- Modify: `vercel.json`

- [ ] **Step 1: Add env accessor tests**

Extend `src/lib/env/private-checkout.test.ts` to cover `PAYMENT_RECONCILIATION_CRON_SECRET`:

```ts
test("payment reconciliation cron secret is optional but non-blank when set", () => {
  // use the existing env test pattern in this file
});
```

Expected behavior:

- missing secret returns `null` through `getPaymentReconciliationCronSecret()`.
- blank secret throws `Missing env var: PAYMENT_RECONCILIATION_CRON_SECRET`.
- non-blank secret is returned trimmed.

- [ ] **Step 2: Implement env accessor**

Add to `src/lib/env/private-checkout.ts`:

```ts
export function getPaymentReconciliationCronSecret(): string | null {
  const value = process.env.PAYMENT_RECONCILIATION_CRON_SECRET;

  if (value === undefined) {
    return null;
  }

  return requireNonBlank(
    value,
    "Missing env var: PAYMENT_RECONCILIATION_CRON_SECRET",
  );
}
```

Use the existing `requireNonBlank` helper name if present; otherwise follow the exact local helper already used for checkout env vars.

- [ ] **Step 3: Add monitor summary tests**

Create tests that pass fake repository findings and assert the returned summary includes these categories:

- `confirmed_booking_without_saved_square_card`
- `confirmed_booking_without_no_show_invoice`
- `square_payment_pending_too_long`
- `paid_booking_not_booked`
- `failed_no_show_charge`

- [ ] **Step 4: Implement monitor service**

Export:

```ts
export interface ServiceReconciliationFinding {
  category:
    | "confirmed_booking_without_saved_square_card"
    | "confirmed_booking_without_no_show_invoice"
    | "square_payment_pending_too_long"
    | "paid_booking_not_booked"
    | "failed_no_show_charge";
  holdId?: string;
  orderId?: string;
  severity: "warning" | "error";
}

export interface ServiceReconciliationSummary {
  findings: ServiceReconciliationFinding[];
  ok: boolean;
  checkedAt: string;
}
```

The initial implementation may query only existing legacy tables for pending states. Card/no-show categories will become active after Phase 1 schema additions.

- [ ] **Step 5: Implement protected admin route**

Use the same authorization pattern as `src/app/api/admin/private-data-retention/route.ts`: require `Authorization: Bearer ${PAYMENT_RECONCILIATION_CRON_SECRET}`. Return `404` when the secret is not configured, `401` when missing/wrong, `503` on monitor errors, and JSON summary on success.

- [ ] **Step 6: Add Vercel cron**

Modify `vercel.json`:

```json
{
  "crons": [
    {
      "path": "/api/admin/private-data-retention",
      "schedule": "17 8 * * *"
    },
    {
      "path": "/api/admin/payment-reconciliation",
      "schedule": "*/30 * * * *"
    }
  ]
}
```

- [ ] **Step 7: Run focused tests**

Run:

```bash
npx tsx --test src/app/api/admin/payment-reconciliation/route.test.ts src/lib/booking/payments/service-reconciliation-monitor.test.ts src/lib/env/private-checkout.test.ts
```

Expected: PASS.

---

## Phase 1 — Private Data Model + Square Adapters

### Task 5: Add private DB schema for saved cards, policy acceptance, and no-show records

**Files:**

- Modify: `src/lib/private-db/schema.ts`
- Modify: `src/lib/private-db/schema.test.ts`

- [ ] **Step 1: Add schema tests for new enums/tables**

Extend `src/lib/private-db/schema.test.ts` to assert enum values include:

```ts
assert.ok(savedPaymentMethodStatus.enumValues.includes("active"));
assert.ok(savedPaymentMethodStatus.enumValues.includes("disabled"));
assert.ok(noShowChargeStatus.enumValues.includes("ready"));
assert.ok(noShowChargeStatus.enumValues.includes("charge_failed"));
```

Also assert exported table names exist by importing:

- `bookingSquareCustomers`
- `bookingSavedPaymentMethods`
- `bookingPolicyAcceptances`
- `bookingNoShowChargeRecords`
- `bookingNoShowChargeAttempts`

- [ ] **Step 2: Run schema test and verify failure**

Run:

```bash
npx tsx --test src/lib/private-db/schema.test.ts
```

Expected: FAIL because exports do not exist.

- [ ] **Step 3: Add enums and tables**

Add to `schema.ts`:

```ts
export const savedPaymentMethodStatus = pgEnum("saved_payment_method_status", [
  "active",
  "replaced",
  "disabled",
  "deleted",
  "charge_failed",
]);

export const noShowChargeStatus = pgEnum("no_show_charge_status", [
  "draft",
  "ready",
  "provider_draft_created",
  "admin_review",
  "charge_pending",
  "charged",
  "charge_failed",
  "voided",
  "expired",
  "manual_followup",
]);
```

Add tables with only non-sensitive values:

- `booking_square_customers`: local ID, normalized email/name/phone, `squareCustomerId`, timestamps.
- `booking_saved_payment_methods`: customer FK, `squareCardId`, brand, last4, expiry month/year, postal code, status, timestamps.
- `booking_policy_acceptances`: hold FK, policy version, policy text hash/document ID, accepted timestamp, max charge cents, currency, IP hash, user agent hash, customer email/name snapshot.
- `booking_no_show_charge_records`: hold FK, saved payment method FK, policy acceptance FK, Square customer/card IDs, max amount/currency, Square invoice/order/payment IDs, status, provider status, failure reason, timestamps.
- `booking_no_show_charge_attempts`: no-show record FK, idempotency key, amount/currency, status, Square payment/invoice IDs, failure reason, created/processed timestamps.

Add nullable references to `appointment_holds`:

- `savedPaymentMethodId`
- `policyAcceptanceId`
- `noShowChargeRecordId`
- `squareCustomerId`
- `squareCardId`
- `cardOnFileStatus`
- `noShowInvoiceId`
- `noShowInvoiceOrderId`
- `noShowInvoiceStatus`

Add nullable `noShowChargeRecordId` to `checkout_payment_events` for webhook correlation.

- [ ] **Step 4: Generate migration**

Run:

```bash
npm run db:generate
```

Expected: Drizzle creates a migration for the new private DB objects. Inspect it before applying.

- [ ] **Step 5: Run schema test**

Run:

```bash
npx tsx --test src/lib/private-db/schema.test.ts
```

Expected: PASS.

### Task 6: Add Square Customers and Cards clients

**Files:**

- Create: `src/lib/payments/square/customers-client.ts`
- Create: `src/lib/payments/square/cards-client.ts`
- Create: `src/lib/payments/square/customers-client.test.ts`
- Create: `src/lib/payments/square/cards-client.test.ts`

- [ ] **Step 1: Write customer client tests**

Test that `createSquareCustomer()` posts to `/v2/customers` with Square headers and body:

```ts
{
  idempotency_key: "cust-key-1",
  email_address: "client@example.com",
  given_name: "Nataliea",
  family_name: "Client",
  phone_number: "+14165550123",
  reference_id: "booking-hold-1"
}
```

Expected response type includes `customer.id`.

- [ ] **Step 2: Write card client tests**

Test that `createSquareCard()` posts to `/v2/cards` with:

```ts
{
  idempotency_key: "card-key-1",
  source_id: "cnon:card-token",
  verification_token: "verf-token",
  card: {
    customer_id: "cust_123",
    cardholder_name: "Client Name",
    reference_id: "hold_123",
    billing_address: {
      postal_code: "M6P1A1",
      country: "CA"
    }
  }
}
```

Assert the parsed response exposes `card.id`, `card.card_brand`, `card.last_4`, `card.exp_month`, and `card.exp_year`.

- [ ] **Step 3: Implement clients**

Use the same Square base URL and `Square-Version: 2026-05-20` pattern as `src/lib/booking/square-client.ts`. Keep clients `server-only`.

- [ ] **Step 4: Run tests**

Run:

```bash
npx tsx --test src/lib/payments/square/customers-client.test.ts src/lib/payments/square/cards-client.test.ts
```

Expected: PASS.

### Task 7: Add Square invoice/order client for no-show draft and publish

**Files:**

- Create: `src/lib/payments/square/invoice-client.ts`
- Create: `src/lib/payments/square/invoice-client.test.ts`
- Create: `src/lib/payments/square/payments-client.ts`
- Create: `src/lib/payments/square/payments-client.test.ts`

- [ ] **Step 1: Write invoice client tests**

Cover:

1. `createSquareOrder()` posts order line item for no-show max charge.
2. `createSquareInvoice()` posts invoice with `delivery_method: "EMAIL"` and `payment_requests[0].automatic_payment_source: "CARD_ON_FILE"` plus `card_id`.
3. `publishSquareInvoice()` posts to `/v2/invoices/{invoiceId}/publish` with idempotency key.

- [ ] **Step 2: Payments API fallback tests (superseded)**

~~Cover `createSquareCardOnFilePayment()` posting to `/v2/payments` with `source_id: squareCardId`, `customer_id`, `amount_money`, and idempotency key.~~
Direct card-on-file no-show charging is not wired; no-show enforcement uses Square Invoices.

- [ ] **Step 3: Implement clients**

Implement narrow request/response types required by this app. Do not introduce a broad Square SDK wrapper. The Payments API client exists but is not wired for no-show charges; no-show enforcement uses Square Invoices.

- [ ] **Step 4: Run tests**

Run:

```bash
npx tsx --test src/lib/payments/square/invoice-client.test.ts src/lib/payments/square/payments-client.test.ts
```

Expected: PASS.

### Task 8: Add no-show policy and amount calculation module

**Files:**

- Create: `src/lib/booking/payments/service-no-show-policy.ts`
- Create: `src/lib/booking/payments/service-no-show-policy.test.ts`

- [ ] **Step 1: Write policy tests**

Cover:

- policy version is stable, e.g. `service-no-show-full-amount-v1`.
- policy hash is SHA-256 of normalized policy text.
- max charge amount uses full service/add-on amount configured for the hold snapshot.
- function rejects missing/zero/negative amounts.

- [ ] **Step 2: Implement module**

Export:

```ts
export const SERVICE_NO_SHOW_POLICY_VERSION = "service-no-show-full-amount-v1";

export interface ServiceNoShowPolicyAcceptanceInput {
  accepted: boolean;
  acceptedAt: Date;
  customerEmail: string;
  customerName: string;
  ipAddress?: string;
  maxChargeCents: number;
  policyText: string;
  userAgent?: string;
}
```

Hash IP/user-agent before storage. Store the policy text hash, not the entire mutable UI copy, unless legal requires exact copy in private DB.

- [ ] **Step 3: Run tests**

Run:

```bash
npx tsx --test src/lib/booking/payments/service-no-show-policy.test.ts
```

Expected: PASS.

---

## Phase 2 — Customer Card-on-File Booking Confirmation

### Task 9: Add public Square Web Payments SDK config route

**Files:**

- Modify: `src/lib/env/private-checkout.ts`
- Modify: `src/lib/env/private-checkout.test.ts`
- Create: `src/app/api/booking/square/config/route.ts`
- Create: `src/app/api/booking/square/config/route.test.ts`

- [ ] **Step 1: Add env tests**

Add tests for:

- `SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED` enables only exact `"true"`.
- `SQUARE_APPLICATION_ID` is required only when card-on-file is enabled.
- config returns Square environment, application ID, and location ID but never access token/webhook key.

- [ ] **Step 2: Implement env accessors**

Add:

```ts
export function isSquareCardOnFileServiceBookingEnabled(): boolean {
  return process.env.SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED === "true";
}
```

Add a config accessor returning `{ applicationId, environment, locationId }` by reusing existing Square service env validation for environment/location and adding `SQUARE_APPLICATION_ID`.

- [ ] **Step 3: Implement route**

`GET /api/booking/square/config` returns `404` if disabled and JSON if enabled:

```json
{
  "applicationId": "sandbox-sq0idb-...",
  "environment": "sandbox",
  "locationId": "LOC123",
  "scriptUrl": "https://sandbox.web.squarecdn.com/v1/square.js"
}
```

Production script URL must be `https://web.squarecdn.com/v1/square.js`.

- [ ] **Step 4: Run focused tests**

Run:

```bash
npx tsx --test src/app/api/booking/square/config/route.test.ts src/lib/env/private-checkout.test.ts
```

Expected: PASS.

### Task 10: Implement card-on-file confirmation saga

**Files:**

- Create: `src/lib/booking/payments/service-card-on-file.ts`
- Create: `src/lib/booking/payments/service-card-on-file.test.ts`
- Create: `src/app/api/booking/card-on-file/route.ts`
- Create: `src/app/api/booking/card-on-file/route.test.ts`

- [ ] **Step 1: Write saga tests**

Cover these scenarios with dependency-injected fake repositories/gateways:

1. Rejects missing policy acceptance.
2. Rejects expired or non-held hold.
3. Creates Square customer, creates Square card, persists card metadata, persists policy acceptance, creates no-show charge record, finalizes Calendar booking, and returns confirmed result.
4. If Square card save fails, hold remains unconfirmed and no Calendar event is created.
5. Duplicate submit with same idempotency key returns existing confirmed/processing state without duplicate card or Calendar event.
6. Calendar finalization failure after card save sets manual follow-up and alerts.

- [ ] **Step 2: Implement request/response types**

Route body:

```ts
interface CardOnFileBookingRequestBody {
  billingPostalCode?: string;
  cardholderName: string;
  holdReference: string;
  idempotencyKey: string;
  policy: {
    accepted: true;
    maxChargeCents: number;
    policyTextHash: string;
    policyVersion: string;
  };
  sourceId: string;
  verificationToken?: string;
}
```

Response on success:

```ts
interface CardOnFileBookingResponseBody {
  bookingStatus: "booked" | "manual_followup";
  card: { brand?: string; expMonth?: number; expYear?: number; last4?: string };
  holdReference: string;
  noShowChargeStatus: "ready" | "provider_draft_created" | "manual_followup";
}
```

- [ ] **Step 3: Implement saga transaction boundaries**

Use a saga, not one giant DB transaction around external API calls:

1. Lock/read hold and validate active state.
2. Create/reuse Square customer.
3. Create Square card using token and verification token.
4. Persist Square customer/card + policy acceptance in private DB.
5. Create local no-show charge record.
6. Create Square draft no-show invoice/order through Task 11 module.
7. Finalize Calendar booking through existing finalizer/calendar path.
8. Mark hold booked and link saved card/policy/no-show record.

- [ ] **Step 4: Implement route**

Parse JSON safely. Return:

- `400` for invalid body or missing policy acceptance.
- `409` for expired/unavailable hold.
- `502` for Square card/customer API failure.
- `503` for private DB/Calendar infrastructure failure.

Log safe structured errors through `service-payment-alerts.ts`.

- [ ] **Step 5: Run saga and route tests**

Run:

```bash
npx tsx --test src/lib/booking/payments/service-card-on-file.test.ts src/app/api/booking/card-on-file/route.test.ts
```

Expected: PASS.

### Task 11: Create draft no-show invoice/order at booking confirmation

**Files:**

- Create: `src/lib/booking/payments/service-no-show-invoice.ts`
- Create: `src/lib/booking/payments/service-no-show-invoice.test.ts`
- Modify: `src/lib/booking/payments/service-card-on-file.ts`
- Modify: `src/lib/booking/payments/service-card-on-file.test.ts`

- [ ] **Step 1: Write invoice service tests**

Cover:

- creates Square order for full authorized no-show amount.
- creates Square invoice with `delivery_method: "EMAIL"`.
- invoice payment request uses `request_type: "BALANCE"`, `automatic_payment_source: "CARD_ON_FILE"`, and saved `card_id`.
- persists `squareInvoiceId`, `squareOrderId`, and `provider_draft_created` on local no-show charge record.
- if Square invoice creation fails, local record becomes `manual_followup` and booking confirmation is blocked. There is no Payments API no-show charge fallback; no-show enforcement uses Square Invoices.

- [ ] **Step 2: Implement invoice service**

Export a command:

```ts
export interface CreateDraftNoShowInvoiceInput {
  cardId: string;
  customerEmail: string;
  customerId: string;
  holdId: string;
  idempotencyKey: string;
  maxChargeCents: number;
  noShowChargeRecordId: string;
  serviceDescription: string;
}
```

Return provider IDs and status. Store Square metadata on the local no-show charge record.

- [ ] **Step 3: Wire service into saga**

Task 10 confirmation saga must call this before final Calendar confirmation when invoice mode is enabled.

- [ ] **Step 4: Run tests**

Run:

```bash
npx tsx --test src/lib/booking/payments/service-no-show-invoice.test.ts src/lib/booking/payments/service-card-on-file.test.ts
```

Expected: PASS.

### Task 12: Replace booking UI checkout path behind feature flag

**Files:**

- Create: `src/components/booking/square-card-on-file-form.tsx`
- Modify: `src/components/booking/booking-flow.tsx`
- Modify: `src/components/booking/booking-flow.test.ts`

- [ ] **Step 1: Add component/source tests**

Extend `booking-flow.test.ts` to assert:

- card-on-file route posts to `/api/booking/card-on-file` when feature flag/config path is active.
- legacy `/api/booking/checkout` remains referenced for fallback.
- policy acceptance text/checkbox must be present before submit.
- response does not expose `squareCardId`, `squareCustomerId`, raw token, or invoice IDs to the browser.

- [ ] **Step 2: Implement Square card form component**

Component responsibilities:

1. Fetch `/api/booking/square/config`.
2. Load `scriptUrl` once.
3. Initialize `window.Square.payments(applicationId, locationId)`.
4. Attach card to `#square-card-container`.
5. On submit, require policy checkbox.
6. Tokenize with `verificationDetails` using `intent: "STORE"`, `customerInitiated: true`, `sellerKeyedIn: false`, `currencyCode: "CAD"`, and authorized max charge amount.
7. POST `sourceId` and `verificationToken` to `/api/booking/card-on-file`.

- [ ] **Step 3: Update booking flow**

After hold creation, if card-on-file config is available:

- show policy + card form instead of redirecting to Square Payment Link.
- keep hold expiry UI.
- show recoverable errors for card save failures.
- on success, navigate to `/booking/confirmation?payment=booked` or a new status that maps to confirmed card-on-file booking.

If config route returns `404`, keep current `/api/booking/checkout` fallback.

- [ ] **Step 4: Run tests**

Run:

```bash
npx tsx --test src/components/booking/booking-flow.test.ts
```

Expected: PASS.

---

## Phase 3 — Manual Admin No-Show Charging

### Task 13: Add protected admin no-show charge route

**Files:**

- Create: `src/app/api/admin/appointments/[id]/no-show/route.ts`
- Create: `src/app/api/admin/appointments/[id]/no-show/route.test.ts`
- Modify: `src/lib/env/private-checkout.ts`
- Modify: `src/lib/env/private-checkout.test.ts`

- [ ] **Step 1: Add admin secret/env tests**

Use a dedicated secret such as `BOOKING_ADMIN_PAYMENT_ACTION_SECRET`. Test missing secret returns `404`, invalid authorization returns `401`, valid bearer token permits the action.

- [ ] **Step 2: Add route tests**

Cover:

- appointment not found → `404`.
- booked appointment without saved card/no-show record → `409`.
- charge already succeeded → `409` and no duplicate charge.
- valid request calls no-show invoice publish/charge service and returns charge status.
- failed provider charge returns `202` or `200` with `charge_failed` state, not an unhandled exception.

- [ ] **Step 3: Implement route**

Body:

```ts
interface AdminNoShowRequestBody {
  amountCents: number;
  confirmPolicyCharge: true;
  idempotencyKey: string;
  reason?: string;
}
```

Response includes no raw card data:

```ts
interface AdminNoShowResponseBody {
  appointmentId: string;
  chargeStatus:
    | "charge_pending"
    | "charged"
    | "charge_failed"
    | "manual_followup";
  noShowChargeRecordId: string;
}
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
npx tsx --test src/app/api/admin/appointments/[id]/no-show/route.test.ts src/lib/env/private-checkout.test.ts
```

Expected: PASS.

### Task 14: Implement no-show invoice publish/charge command

**Files:**

- Modify: `src/lib/booking/payments/service-no-show-invoice.ts`
- Modify: `src/lib/booking/payments/service-no-show-invoice.test.ts`

- [ ] **Step 1: Add publish/charge tests**

Cover:

- transitions local record from `provider_draft_created` to `charge_pending` before calling Square.
- publishes invoice with idempotency key.
- if Square returns immediate payment success data, record `charged` with payment ID.
- if Square returns payment failure/decline, record `charge_failed`, failure reason, and alert.
- repeated idempotency key returns existing attempt and does not publish twice.

- [ ] **Step 2: Implement command**

Export:

```ts
export interface ChargeNoShowInvoiceInput {
  amountCents: number;
  idempotencyKey: string;
  noShowChargeRecordId: string;
  operatorId?: string;
  reason?: string;
}
```

Validate amount does not exceed `maxAmountCents` from policy acceptance.

- [ ] **Step 3: Run focused tests**

Run:

```bash
npx tsx --test src/lib/booking/payments/service-no-show-invoice.test.ts
```

Expected: PASS.

### Task 15: Finalize no-show charge webhooks

**Files:**

- Create: `src/lib/booking/payments/service-no-show-charge-finalizer.ts`
- Create: `src/lib/booking/payments/service-no-show-charge-finalizer.test.ts`
- Modify: `src/app/api/webhooks/square/route.ts`
- Modify: `src/app/api/webhooks/square/route.test.ts`

- [ ] **Step 1: Write finalizer tests**

Cover Square events:

- invoice paid/payment made maps to local no-show record by `squareInvoiceId`/`squarePaymentId` and marks `charged`.
- payment failed maps to `charge_failed` and alerts.
- unknown invoice/payment records sanitized event as ignored and alerts warning.
- duplicate webhook event is idempotent.

- [ ] **Step 2: Implement finalizer**

Return shape:

```ts
export interface NoShowChargeFinalizerResult {
  duplicateEvent: boolean;
  finalized: boolean;
  noShowChargeRecordId?: string;
  retryable: boolean;
  status: "charged" | "charge_failed" | "ignored" | "duplicate";
}
```

- [ ] **Step 3: Update Square webhook dispatch**

Dispatch invoice/payment events by local correlation:

1. Training invoice finalizer remains first for training invoices.
2. No-show invoice/payment finalizer handles invoices linked to `booking_no_show_charge_records`.
3. Legacy service payment finalizer remains for Payment Link events until cleanup.

Retryable DB/Square lookup failures return `503`. Valid manual-review states return `200` and alert.

- [ ] **Step 4: Run tests**

Run:

```bash
npx tsx --test src/lib/booking/payments/service-no-show-charge-finalizer.test.ts src/app/api/webhooks/square/route.test.ts
```

Expected: PASS.

---

## Phase 4 — Rollout, Docs, and Verification

### Task 16: Expand reconciliation monitor for card/no-show invariants

**Files:**

- Modify: `src/lib/booking/payments/service-reconciliation-monitor.ts`
- Modify: `src/lib/booking/payments/service-reconciliation-monitor.test.ts`
- Modify: `src/app/api/admin/payment-reconciliation/route.test.ts`

- [ ] **Step 1: Add invariant tests**

Add monitor tests for:

- booked appointment without `savedPaymentMethodId`.
- booked appointment without `policyAcceptanceId`.
- booked appointment without `noShowChargeRecordId`.
- no-show record `charge_failed` not alerted.
- Square invoice/payment event not reconciled locally.
- amount/currency/customer mismatch state.

- [ ] **Step 2: Implement DB queries**

Use Drizzle queries against new tables and `appointment_holds`. Findings should include only internal IDs and statuses.

- [ ] **Step 3: Run monitor tests**

Run:

```bash
npx tsx --test src/lib/booking/payments/service-reconciliation-monitor.test.ts src/app/api/admin/payment-reconciliation/route.test.ts
```

Expected: PASS.

### Task 17: Update docs and runbooks

**Files:**

- Modify: `docs/booking-system-architecture-reference.md`
- Modify: `docs/booking-system-runbook.md`
- Modify: `docs/square-service-booking-setup.md`
- Modify: `docs/launch-readiness-checklist.md`

- [ ] **Step 1: Update architecture reference**

Replace the service booking canonical flow with:

```text
Offering selected
  -> availability requested
  -> private hold created
  -> policy accepted
  -> Square Web Payments SDK tokenizes card with STORE intent
  -> server creates/reuses Square customer
  -> server saves Square card on file
  -> private DB stores card references + policy acceptance
  -> draft no-show invoice/order or equivalent charge record created
  -> Google Calendar event finalized
  -> hold marked booked
```

- [ ] **Step 2: Update Square setup docs**

Document new env vars:

```env
SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED=true
SQUARE_APPLICATION_ID=<square-application-id>
PAYMENT_RECONCILIATION_CRON_SECRET=<secret>
BOOKING_ADMIN_PAYMENT_ACTION_SECRET=<secret>
```

Document required Square APIs/scopes and webhook event subscriptions for invoice/payment events.

- [ ] **Step 3: Update launch checklist**

Add smoke tests:

- policy unchecked blocks confirmation.
- sandbox card saves successfully.
- booking is not confirmed if card save fails.
- booked hold has saved card, policy acceptance, no-show record, and Calendar event.
- admin no-show charge succeeds in sandbox.
- declined no-show charge records failure and alert.
- legacy pending Payment Links still reconcile or manual-review safely.

- [ ] **Step 4: Check docs diff**

Run:

```bash
git diff -- docs/booking-system-architecture-reference.md docs/booking-system-runbook.md docs/square-service-booking-setup.md docs/launch-readiness-checklist.md
```

Expected: docs explain both new card-on-file flow and legacy fallback window.

### Task 18: Full verification matrix

**Files:**

- Modify/create focused unit tests beside changed modules.
- Modify/create Playwright specs under `tests/` only if existing booking E2E patterns support mocked Square SDK.

- [ ] **Step 1: Run unit tests for affected domains**

Run:

```bash
npm run test:unit
```

Expected: PASS.

- [ ] **Step 2: Run lint**

Run:

```bash
npm run lint
```

Expected: PASS.

- [ ] **Step 3: Run build**

Run:

```bash
npm run build
```

Expected: PASS. If it fails at `scripts/validate-sanity-env.mjs`, verify environment/dataset values before changing application code.

- [ ] **Step 4: Run focused Playwright booking smoke**

Run the focused booking spec that covers the booking flow. If no existing spec covers card-on-file, add one with a mocked `window.Square` object and run:

```bash
npx playwright test tests/<booking-card-on-file-spec>.spec.ts --project=chromium
```

Expected: PASS for policy-required, card-save-success, and card-save-failure flows.

- [ ] **Step 5: Square sandbox manual validation**

In staging/sandbox, validate:

1. Web Payments SDK tokenization with STORE intent.
2. Cards API creates card on file and returns brand/last4/expiry.
3. Draft invoice/order creation with `CARD_ON_FILE` and `delivery_method: "EMAIL"`.
4. Publishing/updating invoice charges saved card.
5. Webhook payloads map to local no-show charge record.
6. Failed/declined charge records `charge_failed` and alerts.

Expected: all pass before production flag is enabled.

---

## Rollout Gates

1. **After Phase 0:** deploy legacy hardening. Confirm no new `lh-sq-*` Square API 404s and monitor reports known pending orders.
2. **After Phase 1:** run migration in staging. Confirm no private DB writes store raw card/token data.
3. **After Phase 2:** enable `SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED=true` in staging only. Complete sandbox card-save booking.
4. **After Phase 3:** complete sandbox no-show charge success and decline flows.
5. **After Phase 4:** enable production flag only after legal policy copy is final, Square production credentials/scopes are verified, and staff has the admin no-show procedure.

## Self-Review Notes

- Spec coverage: policy acceptance, Square card save, private DB references/audit metadata, Calendar finalization, draft no-show invoice, admin no-show charge, webhook hardening, return bug fix, alerts, and legacy cleanup are all covered by tasks.
- No sensitive storage: plan stores Square IDs and card display metadata only; tokens are request-only and never persisted.
- Major implementation risk: Square invoice card-on-file behavior must be sandbox-validated. The Payments API fallback client is not wired for no-show enforcement; Square Invoices are the active no-show charge path.
- Execution risk: this should not be implemented as one large PR. Use the phase gates and keep deployable checkpoints.
