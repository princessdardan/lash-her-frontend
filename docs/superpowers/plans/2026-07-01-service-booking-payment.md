# Service Booking Payment and Charge-and-Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split service booking into a service-selection hold step and a dedicated Square charge-and-store payment step that captures today’s payment, stores a card for no-show protection, and confirms only after payment, card storage, consent evidence, and booking finalization succeed.

**Architecture:** Keep `/services/[slug]/booking` as a provisional hold creator that stores only service/time/add-on/intake data plus immutable pricing bounds. Move contact, marketing opt-in, payment amount selection, policy consent, Square tokenization, payment capture, card-on-file metadata, and calendar finalization to `/services/[slug]/booking/payment` and a new private `service-charge-and-store` orchestration module. Use existing private PostgreSQL tables and hold `reconciliationMetadata` for checkpoints; do not store private or payment data in Sanity.

**Tech Stack:** Next.js 16 App Router, React client components, Square Web Payments SDK `CHARGE_AND_STORE`, Square Payments API delayed capture, Drizzle/PostgreSQL, Node test runner via `tsx`, Playwright.

---

## Confirmed Product Decisions

- Marketing opt-in is retained and moved to `/services/[slug]/booking/payment`.
- Payment options remain the existing service choices: deposit, full, and custom partial.
- Custom partial remains greater than deposit and less than full service price; selected add-on balance is only included in the full-payment option.
- One optional add-on remains the maximum for this flow.
- The payment form collects full name and derives Square `givenName`/`familyName` for billing contact.
- Hold duration remains `HOLD_DURATION_MINUTES` for the first implementation; the payment page must display the expiration state and may show the timestamp without a countdown.
- Staff alerting uses the existing `createServicePaymentAlertLogger` path.

---

## File Structure

- Modify `src/components/booking/booking-flow.tsx` — remove contact, marketing, and payment amount fields from the booking step; keep service, date/time, add-on, and intake answers; submit only service-related hold data.
- Modify `src/components/booking/booking-flow.test.ts` — convert source-contract tests to assert the split responsibilities and no misleading copy.
- Modify `src/app/(site)/services/[slug]/booking/page.tsx` — update copy to describe selecting time/add-ons/intake before payment.
- Modify `src/app/api/booking/holds/route.ts` — accept only service-related data, create placeholder customer data, snapshot pricing bounds, and return the existing opaque payment URL.
- Modify `src/app/api/booking/holds/route.test.ts` — cover hold creation without contact/payment fields, invalid add-ons, missing required intake, and service-only payload shape.
- Modify `src/lib/booking/payment-session.ts` — resolve provisional holds without selected payment amount, return safe display data, pricing bounds, selected add-on, and expiration.
- Modify `src/lib/booking/payment-session.test.ts` — cover provisional session resolution, expired/mismatched/booked states, and missing payment amount compatibility.
- Add `src/lib/booking/payments/service-payment-selection.ts` — pure cents-based amount validation and selected payment snapshot construction.
- Add `src/lib/booking/payments/service-payment-selection.test.ts` — deposit/full/custom/add-on/mismatch tests.
- Add `src/components/booking/service-booking-payment-form.tsx` — payment-page form for contact, marketing opt-in, payment choice, consent, and Square charge-and-store card entry.
- Add `src/components/booking/square-charge-and-store-form.tsx` — Square script loading, card attach, and `CHARGE_AND_STORE` tokenization with Canadian `billingContact`.
- Modify `src/components/booking/service-booking-payment-shell.tsx` — replace save-card-only UI with payment form, accurate copy, summary, add-on display, and expiration handling.
- Add `src/app/api/booking/payment/confirm/route.ts` — validate completion payload and delegate to the orchestration module.
- Add `src/app/api/booking/payment/confirm/route.test.ts` — route validation, consent-before-Square, expired hold, and response tests.
- Add `src/lib/booking/payments/service-charge-and-store.ts` — domain orchestration for hold claim, consent evidence, Square customer, delayed payment, saved card metadata, no-show record, capture, and calendar finalization.
- Add `src/lib/booking/payments/service-charge-and-store.test.ts` — fake repository/Square/calendar tests for success, decline, duplicate submit, card missing, capture failure, and calendar failure.
- Add `src/lib/private-db/service-booking-payment-repository.ts` — Drizzle adapter for the new charge-and-store orchestration using existing tables.
- Modify `src/lib/payments/square/payments-client.ts` and `src/lib/payments/square/payments-client.test.ts` — add `verification_token`, delayed capture `autocomplete: false`, `completePayment`, and `cancelPayment` support.
- Modify `tests/service-booking-payment-page.spec.ts` — update browser coverage for the split flow and Square `CHARGE_AND_STORE` tokenization details.

---

## Task 1: Split the booking page contract to service-related data only

**Files:**

- Modify: `src/components/booking/booking-flow.test.ts`
- Modify: `src/components/booking/booking-flow.tsx`
- Modify: `src/app/(site)/services/[slug]/booking/page.tsx`

- [ ] **Step 1: Write failing source-contract tests**

In `src/components/booking/booking-flow.test.ts`, replace the tests that expect contact/payment fields on the booking page with these tests:

```ts
it("booking page collects service details only before payment", () => {
  assert.match(bookingFlowSource, /Appointment Details/);
  assert.match(bookingFlowSource, /Optional add-on/);
  assert.match(bookingFlowSource, /intakeQuestions\.map/);
  assert.doesNotMatch(bookingFlowSource, /Full Name/);
  assert.doesNotMatch(bookingFlowSource, /Email Address/);
  assert.doesNotMatch(bookingFlowSource, /Phone Number/);
  assert.doesNotMatch(bookingFlowSource, /Payment Details/);
  assert.doesNotMatch(bookingFlowSource, /marketingOptIn/);
});

it("booking hold creation posts no contact, marketing, or payment amount fields", () => {
  assert.match(bookingFlowSource, /selectedAddOnKey: input\.selectedAddOnKey/);
  assert.doesNotMatch(bookingFlowSource, /email: input\.email/);
  assert.doesNotMatch(bookingFlowSource, /name: input\.name/);
  assert.doesNotMatch(bookingFlowSource, /phone: input\.phone/);
  assert.doesNotMatch(bookingFlowSource, /paymentOption: input\.paymentOption/);
  assert.doesNotMatch(bookingFlowSource, /customAmount: input\.customAmount/);
  assert.doesNotMatch(bookingFlowSource, /marketingConsentText/);
});

it("booking page copy sends customers to payment after service details", () => {
  const serviceBookingPageSource = readFileSync(
    new URL(
      "../../app/(site)/services/[slug]/booking/page.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(
    serviceBookingPageSource,
    /Select your appointment time, add-ons, and service details before payment\./,
  );
  assert.doesNotMatch(serviceBookingPageSource, /confirm your details/i);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npx tsx --test src/components/booking/booking-flow.test.ts`

Expected: FAIL because `booking-flow.tsx` still contains contact, marketing, and payment fields.

- [ ] **Step 3: Update the booking flow state and submit payload**

In `src/components/booking/booking-flow.tsx`, change the service hold input type to:

```ts
interface ServiceHoldInput {
  answers: BookingAnswerInput[];
  fetcher?: typeof fetch;
  serviceSlug: string;
  selectedAddOnKey?: string;
  sourcePath?: string;
  start: string;
}
```

Remove these state variables and all code that reads or renders them:

```ts
const [name, setName] = useState("");
const [email, setEmail] = useState("");
const [phone, setPhone] = useState("");
const [marketingOptIn, setMarketingOptIn] = useState(false);
const [paymentOption, setPaymentOption] =
  useState<PaidServicePaymentOption>("full");
const [customAmount, setCustomAmount] = useState<string>("");
```

Keep `selectedAddOnKey` and `answers`. In `handleSubmit`, validate only service, selected slot, and required intake answers:

```ts
if (!selectedServiceSlug || !selectedSlot) {
  setErrorMessage("Please select an appointment time.");
  return;
}

const missingQuestion = intakeQuestions.find(
  (question) => question.required && !answers[question.id]?.trim(),
);
if (missingQuestion) {
  setErrorMessage(`${missingQuestion.label} is required.`);
  return;
}
```

Call `createBookingHold` with only service-related fields:

```ts
const { paymentPageUrl } = await createBookingHold({
  answers: Object.entries(answers).map(([questionId, answer]) => ({
    questionId,
    answer,
  })),
  serviceSlug: selectedServiceSlug,
  ...(selectedAddOnKey ? { selectedAddOnKey } : {}),
  sourcePath: pathname,
  start: selectedSlot,
});
```

Change the final-step heading from `Your Details` to `Appointment Details`, keep intake questions and the optional add-on picker, and set the submit button copy to `Continue to payment`.

- [ ] **Step 4: Update the hold helper payload**

In `src/components/booking/booking-flow.tsx`, update `createBookingHold` to accept `ServiceHoldInput` and post this body:

```ts
body: JSON.stringify({
  answers: input.answers,
  serviceSlug: input.serviceSlug,
  ...(input.selectedAddOnKey ? { selectedAddOnKey: input.selectedAddOnKey } : {}),
  sourcePath: input.sourcePath,
  start: input.start,
}),
```

Delete `isLikelyEmail` from the file after all email validation is removed.

- [ ] **Step 5: Update booking page copy**

In `src/app/(site)/services/[slug]/booking/page.tsx`, replace the line under the header with:

```tsx
<p className="mt-4 font-body text-sm font-bold uppercase tracking-[0.12em] text-lh-muted">
  Select your appointment time, add-ons, and service details before payment.
</p>
```

- [ ] **Step 6: Run focused tests**

Run: `npx tsx --test src/components/booking/booking-flow.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/booking/booking-flow.tsx src/components/booking/booking-flow.test.ts src/app/(site)/services/[slug]/booking/page.tsx
git commit -m "feat: split service booking details from payment"
```

---

## Task 2: Change hold creation to provisional service-only holds

**Files:**

- Modify: `src/app/api/booking/holds/route.test.ts`
- Modify: `src/app/api/booking/holds/route.ts`

- [ ] **Step 1: Write failing hold route tests**

In `src/app/api/booking/holds/route.test.ts`, add tests that use the existing `createBookingHoldsPostHandler` test setup:

```ts
test("hold creation accepts service data without contact or payment selection", async () => {
  const createdHolds: Array<
    Parameters<BookingHoldsPostHandlerDependencies["createAppointmentHold"]>[0]
  > = [];
  const handler = createBookingHoldsPostHandler({
    ...createBaseDependencies(),
    async createAppointmentHold(input) {
      createdHolds.push(input);
      return {
        ok: true,
        hold: createHoldRecord({
          customer: {
            email: "pending-service-booking@example.invalid",
            name: "Pending service booking customer",
            phone: "0000000000",
          },
          paymentSessionReference: "pay_sess_service_only",
        }),
      };
    },
  });

  const response = await handler(
    new Request("https://example.test/api/booking/holds", {
      method: "POST",
      body: JSON.stringify({
        serviceSlug: "lash-fill",
        start: "2030-01-01T18:00:00.000Z",
        selectedAddOnKey: "addon-removal",
        answers: [{ questionId: "allergies", answer: "No allergies" }],
      }),
    }),
  );

  assert.equal(response.status, 201);
  assert.equal(createdHolds.length, 1);
  assert.deepEqual(createdHolds[0]?.customer, {
    email: "pending-service-booking@example.invalid",
    name: "Pending service booking customer",
    phone: "0000000000",
  });
  assert.equal(createdHolds[0]?.offeringSnapshot.customerStatus, "pending");
  assert.equal(createdHolds[0]?.offeringSnapshot.paymentStatus, "pending");
  assert.equal(createdHolds[0]?.offeringSnapshot.selectedPayment, undefined);
});

test("hold creation rejects contact and payment fields on the provisional endpoint", async () => {
  const handler = createBookingHoldsPostHandler(createBaseDependencies());
  const response = await handler(
    new Request("https://example.test/api/booking/holds", {
      method: "POST",
      body: JSON.stringify({
        serviceSlug: "lash-fill",
        start: "2030-01-01T18:00:00.000Z",
        name: "Client Name",
        email: "client@example.test",
        phone: "5551234567",
        paymentOption: "full",
      }),
    }),
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "Contact and payment details belong on the payment step.",
    fieldErrors: {
      email: "Enter contact details on the payment page",
      name: "Enter contact details on the payment page",
      paymentOption: "Choose payment amount on the payment page",
      phone: "Enter contact details on the payment page",
    },
  });
});
```

- [ ] **Step 2: Run route tests and verify failure**

Run: `npx tsx --test src/app/api/booking/holds/route.test.ts`

Expected: FAIL because the route still requires contact and payment fields.

- [ ] **Step 3: Update request parsing and validation**

In `src/app/api/booking/holds/route.ts`, replace `BookingHoldRequestInput` with:

```ts
interface BookingHoldRequestInput {
  answers: BookingAnswerInput[];
  rejectedStepFields: Record<string, string>;
  serviceSlug: string;
  selectedAddOnKey?: string;
  sourcePath?: string;
  start: string;
}
```

Add constants near the top:

```ts
const PENDING_CUSTOMER = {
  email: "pending-service-booking@example.invalid",
  name: "Pending service booking customer",
  phone: "0000000000",
} as const;
```

Update `toBookingHoldRequestInput` so it only keeps service data and records rejected fields:

```ts
const rejectedStepFields: Record<string, string> = {};
if (toStringValue(record.name).trim().length > 0) {
  rejectedStepFields.name = "Enter contact details on the payment page";
}
if (toStringValue(record.email).trim().length > 0) {
  rejectedStepFields.email = "Enter contact details on the payment page";
}
if (toStringValue(record.phone).trim().length > 0) {
  rejectedStepFields.phone = "Enter contact details on the payment page";
}
if (record.paymentOption !== undefined || record.customAmount !== undefined) {
  rejectedStepFields.paymentOption =
    "Choose payment amount on the payment page";
}
if (
  record.marketingOptIn !== undefined ||
  record.marketingConsentText !== undefined
) {
  rejectedStepFields.marketingOptIn =
    "Choose marketing preferences on the payment page";
}
```

Return `rejectedStepFields` with `answers`, `serviceSlug`, `selectedAddOnKey`, `sourcePath`, and `start`.

In `validateHoldRequestInput`, remove name/email/phone checks and add:

```ts
Object.assign(fieldErrors, input.rejectedStepFields);
```

Before the existing generic field-error response, add:

```ts
const hasStepFieldErrors = Object.keys(input.rejectedStepFields).length > 0;
if (hasStepFieldErrors) {
  return Response.json(
    {
      error: "Contact and payment details belong on the payment step.",
      fieldErrors,
    },
    { status: 400 },
  );
}
```

- [ ] **Step 4: Snapshot immutable pricing bounds instead of selected payment**

Delete `BookingPaymentSelectionSnapshot`, `getPaymentSelection`, `resolveFixedPaymentSelection`, `parsePaymentOption`, and `parseOptionalAmount` from `src/app/api/booking/holds/route.ts`.

Change the hold creation call to:

```ts
const holdResult = await dependencies.createAppointmentHold({
  bookingType: SERVICE_BOOKING_TYPE,
  customer: PENDING_CUSTOMER,
  offeringId: service._id,
  offeringSnapshot: toServiceSnapshot(service, input, selectedAddOn),
  selectedEnd,
  selectedStart,
  timezone: settings.timezone,
  now,
});
```

Replace `toServiceSnapshot` with:

```ts
function toServiceSnapshot(
  service: TService,
  input: BookingHoldRequestInput,
  selectedAddOn: BookingAddOnSelectionSnapshot | null,
): Record<string, unknown> {
  return {
    id: service._id,
    slug: service.slug,
    serviceSlug: service.slug,
    title: service.title,
    bookingType: SERVICE_BOOKING_TYPE,
    durationMinutes: service.durationMinutes,
    customerStatus: "pending",
    paymentStatus: "pending",
    pricing: {
      depositAmount: service.depositAmount,
      fullPrice: service.fullPrice,
      currency: service.currency,
      customAmountMinimum: service.depositAmount,
      customAmountMaximum: service.fullPrice,
      addOnPrice: selectedAddOn?.price ?? 0,
    },
    ...(selectedAddOn ? { selectedAddOn } : {}),
    answers: normalizeAnswers(input.answers),
    ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
  };
}
```

Remove `recordBookingMarketingChoice` from this route’s dependency interface, default handler, and submit path; marketing is persisted on payment completion.

- [ ] **Step 5: Run focused route tests**

Run: `npx tsx --test src/app/api/booking/holds/route.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/booking/holds/route.ts src/app/api/booking/holds/route.test.ts
git commit -m "feat: create provisional service booking holds"
```

---

## Task 3: Resolve payment sessions with pricing bounds and add-on summary

**Files:**

- Modify: `src/lib/booking/payment-session.test.ts`
- Modify: `src/lib/booking/payment-session.ts`

- [ ] **Step 1: Write failing resolver tests**

Replace the active-session expectation in `src/lib/booking/payment-session.test.ts` with a provisional snapshot that has no selected payment:

```ts
offeringSnapshot: {
  serviceSlug: "classic-fill",
  title: "Classic Fill",
  pricing: {
    depositAmount: 50,
    fullPrice: 130,
    currency: "CAD",
    customAmountMinimum: 50,
    customAmountMaximum: 130,
    addOnPrice: 25,
  },
  selectedAddOn: {
    key: "addon-removal",
    name: "Removal",
    description: "Gentle removal before fill",
    price: 25,
    currency: "CAD",
  },
},
```

Assert the session shape:

```ts
const expected: ServiceBookingPaymentSessionDisplay = {
  currency: "CAD",
  expiresAt: "2030-01-01T18:10:00.000Z",
  paymentSessionReference: "pay_sess_1",
  pricing: {
    addOnPriceCents: 2500,
    customAmountMaximumCents: 13000,
    customAmountMinimumCents: 5000,
    depositAmountCents: 5000,
    fullPriceCents: 13000,
  },
  selectedAddOn: {
    description: "Gentle removal before fill",
    key: "addon-removal",
    name: "Removal",
    priceCents: 2500,
  },
  selectedEnd: "2030-01-02T20:00:00.000Z",
  selectedStart: "2030-01-02T19:00:00.000Z",
  serviceSlug: "classic-fill",
  serviceTitle: "Classic Fill",
  timezone: "America/Toronto",
};
```

Add a test named `rejects active sessions without pricing bounds` that uses `offeringSnapshot: { serviceSlug: "classic-fill", title: "Classic Fill" }` and expects `{ status: "not_found" }`.

- [ ] **Step 2: Run resolver tests and verify failure**

Run: `npx tsx --test src/lib/booking/payment-session.test.ts`

Expected: FAIL because `payment-session.ts` still reads `payment.amount`, returns `customerName`, and returns `totalCents`.

- [ ] **Step 3: Update session display types**

In `src/lib/booking/payment-session.ts`, replace `ServiceBookingPaymentSessionDisplay` with:

```ts
export interface ServiceBookingPaymentSessionDisplay {
  currency: "CAD";
  expiresAt: string;
  paymentSessionReference: string;
  pricing: {
    addOnPriceCents: number;
    customAmountMaximumCents: number;
    customAmountMinimumCents: number;
    depositAmountCents: number;
    fullPriceCents: number;
  };
  selectedAddOn?: {
    description: string;
    key: string;
    name: string;
    priceCents: number;
  };
  selectedEnd: string;
  selectedStart: string;
  serviceSlug: string;
  serviceTitle: string;
  timezone: string;
}
```

Update `readServiceSnapshot` to read `snapshot.pricing`, validate all amounts with `toPositiveAmount`, and return the pricing object in cents. Delete `customerName` and `totalCents` from the session return value.

Use this helper for optional add-ons:

```ts
function readSelectedAddOn(snapshot: Record<string, unknown>) {
  const addOn = isRecord(snapshot.selectedAddOn)
    ? snapshot.selectedAddOn
    : null;
  if (addOn === null) return undefined;
  const price = toPositiveAmount(addOn.price);
  if (
    typeof addOn.key !== "string" ||
    typeof addOn.name !== "string" ||
    typeof addOn.description !== "string" ||
    price === null
  ) {
    return undefined;
  }

  return {
    description: addOn.description,
    key: addOn.key,
    name: addOn.name,
    priceCents: Math.round(price * 100),
  };
}
```

- [ ] **Step 4: Run resolver tests**

Run: `npx tsx --test src/lib/booking/payment-session.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/booking/payment-session.ts src/lib/booking/payment-session.test.ts
git commit -m "feat: resolve provisional booking payment sessions"
```

---

## Task 4: Add pure server-side payment amount calculation

**Files:**

- Create: `src/lib/booking/payments/service-payment-selection.ts`
- Create: `src/lib/booking/payments/service-payment-selection.test.ts`

- [ ] **Step 1: Write the pure calculation tests**

Create `src/lib/booking/payments/service-payment-selection.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveServicePaymentSelection,
  type ServicePaymentPricingSnapshot,
} from "./service-payment-selection";

const pricing: ServicePaymentPricingSnapshot = {
  addOnPriceCents: 2500,
  currency: "CAD",
  customAmountMaximumCents: 13000,
  customAmountMinimumCents: 5000,
  depositAmountCents: 5000,
  fullPriceCents: 13000,
  serviceTitle: "Classic Fill",
  selectedAddOnName: "Removal",
};

test("resolves deposit amount without add-on charge", () => {
  assert.deepEqual(
    resolveServicePaymentSelection({
      pricing,
      selection: { option: "deposit" },
    }),
    {
      ok: true,
      payment: {
        amountCents: 5000,
        currency: "CAD",
        description: "Classic Fill deposit; Removal add-on balance due later",
        option: "deposit",
        purpose: "appointment_deposit",
        sku: "BOOKING-DEPOSIT",
      },
    },
  );
});

test("resolves full amount including add-on", () => {
  const result = resolveServicePaymentSelection({
    pricing,
    selection: { option: "full" },
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.payment.amountCents, 15500);
});

test("resolves custom partial between deposit and full service price", () => {
  const result = resolveServicePaymentSelection({
    pricing,
    selection: { option: "customPartial", customAmountCents: 9000 },
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.payment.amountCents, 9000);
});

test("rejects custom partial at or below deposit", () => {
  assert.deepEqual(
    resolveServicePaymentSelection({
      pricing,
      selection: { option: "customPartial", customAmountCents: 5000 },
    }),
    { ok: false, error: "Custom amount must be greater than the deposit." },
  );
});

test("rejects custom partial at or above full service price", () => {
  assert.deepEqual(
    resolveServicePaymentSelection({
      pricing,
      selection: { option: "customPartial", customAmountCents: 13000 },
    }),
    {
      ok: false,
      error: "Custom amount must be less than the full service price.",
    },
  );
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npx tsx --test src/lib/booking/payments/service-payment-selection.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Add the pure calculation module**

Create `src/lib/booking/payments/service-payment-selection.ts`:

```ts
import type { CheckoutOrderPurpose } from "@/lib/private-db/schema";

export type ServicePaymentOption = "deposit" | "full" | "customPartial";

export interface ServicePaymentPricingSnapshot {
  addOnPriceCents: number;
  currency: "CAD";
  customAmountMaximumCents: number;
  customAmountMinimumCents: number;
  depositAmountCents: number;
  fullPriceCents: number;
  selectedAddOnName?: string;
  serviceTitle: string;
}

export interface ServicePaymentSelectionInput {
  option: ServicePaymentOption;
  customAmountCents?: number;
}

export interface ResolvedServicePaymentSelection {
  amountCents: number;
  currency: "CAD";
  description: string;
  option: ServicePaymentOption;
  purpose: CheckoutOrderPurpose;
  sku: "BOOKING-DEPOSIT" | "BOOKING-FULL" | "BOOKING-CUSTOM-PARTIAL";
}

export function resolveServicePaymentSelection(input: {
  pricing: ServicePaymentPricingSnapshot;
  selection: ServicePaymentSelectionInput;
}):
  | { ok: true; payment: ResolvedServicePaymentSelection }
  | { ok: false; error: string } {
  const { pricing, selection } = input;

  if (
    !isPositiveInteger(pricing.depositAmountCents) ||
    !isPositiveInteger(pricing.fullPriceCents)
  ) {
    return { ok: false, error: "Booking pricing is not configured." };
  }

  if (selection.option === "deposit") {
    return {
      ok: true,
      payment: {
        amountCents: pricing.depositAmountCents,
        currency: "CAD",
        description: pricing.selectedAddOnName
          ? `${pricing.serviceTitle} deposit; ${pricing.selectedAddOnName} add-on balance due later`
          : `${pricing.serviceTitle} deposit`,
        option: "deposit",
        purpose: "appointment_deposit",
        sku: "BOOKING-DEPOSIT",
      },
    };
  }

  if (selection.option === "full") {
    const amountCents =
      pricing.fullPriceCents + Math.max(pricing.addOnPriceCents, 0);
    return {
      ok: true,
      payment: {
        amountCents,
        currency: "CAD",
        description: pricing.selectedAddOnName
          ? `${pricing.serviceTitle} full payment with ${pricing.selectedAddOnName}`
          : `${pricing.serviceTitle} full payment`,
        option: "full",
        purpose: "appointment_full",
        sku: "BOOKING-FULL",
      },
    };
  }

  const customAmountCents = selection.customAmountCents;
  if (!isPositiveInteger(customAmountCents)) {
    return { ok: false, error: "Custom amount is required." };
  }
  if (customAmountCents <= pricing.customAmountMinimumCents) {
    return {
      ok: false,
      error: "Custom amount must be greater than the deposit.",
    };
  }
  if (customAmountCents >= pricing.customAmountMaximumCents) {
    return {
      ok: false,
      error: "Custom amount must be less than the full service price.",
    };
  }

  return {
    ok: true,
    payment: {
      amountCents: customAmountCents,
      currency: "CAD",
      description: pricing.selectedAddOnName
        ? `${pricing.serviceTitle} custom partial payment; ${pricing.selectedAddOnName} add-on balance due later`
        : `${pricing.serviceTitle} custom partial payment`,
      option: "customPartial",
      purpose: "appointment_custom_partial",
      sku: "BOOKING-CUSTOM-PARTIAL",
    },
  };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
```

- [ ] **Step 4: Run tests**

Run: `npx tsx --test src/lib/booking/payments/service-payment-selection.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/booking/payments/service-payment-selection.ts src/lib/booking/payments/service-payment-selection.test.ts
git commit -m "feat: calculate service booking payment selections"
```

---

## Task 5: Build the payment page form and Square charge-and-store tokenization

**Files:**

- Add: `src/components/booking/square-charge-and-store-form.tsx`
- Add: `src/components/booking/service-booking-payment-form.tsx`
- Modify: `src/components/booking/service-booking-payment-shell.tsx`
- Modify: `src/components/booking/booking-flow.test.ts`

- [ ] **Step 1: Write failing source-contract tests for payment UI**

In `src/components/booking/booking-flow.test.ts`, add:

```ts
it("payment page owns contact, marketing, payment, consent, and Square card entry", () => {
  const paymentFormSource = readFileSync(
    new URL("./service-booking-payment-form.tsx", import.meta.url),
    "utf8",
  );
  const chargeAndStoreSource = readFileSync(
    new URL("./square-charge-and-store-form.tsx", import.meta.url),
    "utf8",
  );

  assert.match(paymentFormSource, /Full Name/);
  assert.match(paymentFormSource, /Email Address/);
  assert.match(paymentFormSource, /Phone Number/);
  assert.match(paymentFormSource, /Marketing/);
  assert.match(paymentFormSource, /Payment Option/);
  assert.match(
    paymentFormSource,
    /I authorize Lash Her to charge today’s booking payment/,
  );
  assert.match(chargeAndStoreSource, /intent: "CHARGE_AND_STORE"/);
  assert.match(chargeAndStoreSource, /countryCode: "CA"/);
  assert.match(chargeAndStoreSource, /billingContact/);
  assert.doesNotMatch(chargeAndStoreSource, /intent: "STORE"/);
});

it("payment copy does not promise that no payment is taken today", () => {
  assert.doesNotMatch(
    serviceBookingPaymentShellSource,
    /No payment is taken today/i,
  );
  assert.match(
    serviceBookingPaymentShellSource,
    /Pay and confirm your booking/,
  );
  assert.match(
    serviceBookingPaymentShellSource,
    /Today’s payment secures your appointment/,
  );
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npx tsx --test src/components/booking/booking-flow.test.ts`

Expected: FAIL because the new files do not exist and shell copy is still card-on-file-only.

- [ ] **Step 3: Add Square charge-and-store component**

Create `src/components/booking/square-charge-and-store-form.tsx` by copying the safe script-loading structure from `square-card-on-file-form.tsx`, but expose this submit API:

```ts
export interface SquareChargeAndStoreBuyerDetails {
  amountCents: number;
  email: string;
  fullName: string;
  phone: string;
}

export interface SquareChargeAndStoreTokenResult {
  sourceId: string;
  verificationToken?: string;
}
```

The component props must be:

```ts
interface SquareChargeAndStoreFormProps {
  buyer: SquareChargeAndStoreBuyerDetails;
  disabled: boolean;
  onError: (message: string) => void;
  onTokenized: (result: SquareChargeAndStoreTokenResult) => Promise<void>;
}
```

Use this exact verification details shape before calling `cardRef.current.tokenize(verificationDetails)`:

```ts
const [givenName, familyName] = splitFullName(buyer.fullName);
const verificationDetails: SquareVerificationDetails = {
  amount: formatCentsAsSquareAmount(buyer.amountCents),
  currencyCode: "CAD",
  intent: "CHARGE_AND_STORE",
  customerInitiated: true,
  sellerKeyedIn: false,
  billingContact: {
    givenName,
    familyName,
    email: buyer.email,
    phone: buyer.phone,
    countryCode: "CA",
  },
};
```

Use this label near the card container: `Secure card entry, including postal code when required by your card issuer`. Do not use the word `ZIP`.

- [ ] **Step 4: Add the payment form component**

Create `src/components/booking/service-booking-payment-form.tsx`. It must:

- Keep state for `fullName`, `email`, `phone`, `marketingOptIn`, `paymentOption`, `customAmount`, `policyAccepted`, `errorMessage`, and `isSubmitting`.
- Default `paymentOption` to `full`.
- Compute the selected amount in cents from `session.pricing` using the same rules as `service-payment-selection.ts`.
- Block submission before tokenization when name/email/phone are invalid or consent is unchecked.
- Render the retained marketing checkbox on the payment page.
- Pass buyer details to `SquareChargeAndStoreForm` only after the required fields are present.
- Submit to `/api/booking/payment/confirm` with `paymentSessionReference`, contact details, `marketingOptIn`, payment selection, `policy.accepted`, `sourceId`, `verificationToken`, and `idempotencyKey`.

Use this client request body shape:

```ts
const body = {
  paymentSessionReference: session.paymentSessionReference,
  customer: {
    email,
    marketingOptIn,
    name: fullName,
    phone,
  },
  payment: {
    option: paymentOption,
    ...(paymentOption === "customPartial"
      ? { customAmountCents: selectedAmountCents }
      : {}),
    expectedAmountCents: selectedAmountCents,
  },
  policy: {
    accepted: true,
    policyTextHash,
    policyVersion: SERVICE_NO_SHOW_POLICY_VERSION,
  },
  sourceId: token.sourceId,
  verificationToken: token.verificationToken,
  idempotencyKey,
};
```

Use this checkbox copy:

```tsx
I authorize Lash Her to charge today’s booking payment and store my card for no-show or late-cancellation protection according to the booking policy.
```

Use this button copy: `Pay and confirm booking`.

- [ ] **Step 5: Update the payment shell**

In `src/components/booking/service-booking-payment-shell.tsx`, remove `SquareCardOnFileForm`, `startLegacySquareCheckout`, fallback checkout state, and `No payment is taken today` copy. Render:

```tsx
<h1 className="section-heading mb-4">Pay and confirm your booking</h1>
<p className="mb-6 text-sm font-bold leading-6 text-lh-muted">
  Today’s payment secures your appointment. Your card will also be stored for no-show and late-cancellation protection according to the booking policy.
</p>
<ServiceBookingPaymentForm session={session} onSuccess={handleSuccess} onExpired={handleExpired} />
```

In the summary, display service title, selected add-on when present, selected time, deposit, full price, and hold expiration. Label the amount section `Amount due today is selected below` because the payment amount is chosen in the form.

- [ ] **Step 6: Run component tests**

Run: `npx tsx --test src/components/booking/booking-flow.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/booking/square-charge-and-store-form.tsx src/components/booking/service-booking-payment-form.tsx src/components/booking/service-booking-payment-shell.tsx src/components/booking/booking-flow.test.ts
git commit -m "feat: add service booking payment form"
```

---

## Task 6: Extend Square Payments client for charge, complete, and cancel

**Files:**

- Modify: `src/lib/payments/square/payments-client.test.ts`
- Modify: `src/lib/payments/square/payments-client.ts`

- [ ] **Step 1: Write failing Square client tests**

In `src/lib/payments/square/payments-client.test.ts`, add tests that mock `global.fetch` and assert:

```ts
assert.equal(requestBody.autocomplete, false);
assert.equal(requestBody.verification_token, "verf:test");
assert.equal(requestBody.source_id, "cnon:test");
```

Add tests for these paths:

```ts
POST / v2 / payments / payment - id / complete;
POST / v2 / payments / payment - id / cancel;
```

Expected response shape for complete/cancel tests:

```json
{
  "payment": {
    "id": "payment-id",
    "status": "COMPLETED",
    "amount_money": { "amount": 5000, "currency": "CAD" },
    "card_details": { "card": { "id": "ccof:test" } }
  }
}
```

- [ ] **Step 2: Run and verify failure**

Run: `npx tsx --test src/lib/payments/square/payments-client.test.ts`

Expected: FAIL because the client lacks these fields and methods.

- [ ] **Step 3: Update the Square Payments client types and methods**

In `src/lib/payments/square/payments-client.ts`, add optional fields to `SquareCreatePaymentRequest`:

```ts
verification_token?: string;
autocomplete?: boolean;
```

Extend `SquarePayment` with:

```ts
version_token?: string;
card_details?: { card?: { id?: string } };
```

Extend `SquarePaymentsClient`:

```ts
completePayment(paymentId: string, versionToken?: string): Promise<SquareGetPaymentResponse>;
cancelPayment(paymentId: string): Promise<SquareGetPaymentResponse>;
```

Implement methods using `postSquare`:

```ts
async completePayment(paymentId, versionToken) {
  const query = versionToken ? `?version_token=${encodeURIComponent(versionToken)}` : "";
  return postSquare<Record<string, never>, SquareGetPaymentResponse>(
    env,
    `/v2/payments/${encodeURIComponent(paymentId)}/complete${query}`,
    {},
    isSquareGetPaymentResponse,
  );
},
async cancelPayment(paymentId) {
  return postSquare<Record<string, never>, SquareGetPaymentResponse>(
    env,
    `/v2/payments/${encodeURIComponent(paymentId)}/cancel`,
    {},
    isSquareGetPaymentResponse,
  );
},
```

- [ ] **Step 4: Run Square client tests**

Run: `npx tsx --test src/lib/payments/square/payments-client.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/payments/square/payments-client.ts src/lib/payments/square/payments-client.test.ts
git commit -m "feat: support Square delayed capture payments"
```

---

## Task 7: Add charge-and-store orchestration with test fakes

**Files:**

- Add: `src/lib/booking/payments/service-charge-and-store.ts`
- Add: `src/lib/booking/payments/service-charge-and-store.test.ts`

- [ ] **Step 1: Write orchestration tests**

Create `src/lib/booking/payments/service-charge-and-store.test.ts` with fake repository, Square, and calendar dependencies. Cover these named tests:

```ts
test("persists consent before creating Square payment", async () => {});
test("captures payment only after Square card id is available", async () => {});
test("returns booked only after payment, card, no-show record, and calendar finalization", async () => {});
test("rejects unchecked consent before Square calls", async () => {});
test("rejects client amount mismatch before Square calls", async () => {});
test("cancels authorization when card id is missing before capture", async () => {});
test("marks refund required when a completed payment lacks card storage", async () => {});
test("returns existing terminal confirmation for duplicate submits", async () => {});
test("marks manual follow-up when calendar finalization fails after capture", async () => {});
```

Each fake must record an `events: string[]` array. The first success test must assert:

```ts
assert.deepEqual(events.slice(0, 4), [
  "claimHold",
  "persistPolicyAcceptance",
  "createSquareCustomer",
  "createPayment",
]);
```

- [ ] **Step 2: Run and verify failure**

Run: `npx tsx --test src/lib/booking/payments/service-charge-and-store.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Add orchestration types**

Create `src/lib/booking/payments/service-charge-and-store.ts` with exported request/result types:

```ts
export interface ChargeAndStoreBookingRequestBody {
  customer: {
    email: string;
    marketingOptIn: boolean;
    name: string;
    phone: string;
  };
  idempotencyKey: string;
  payment: {
    customAmountCents?: number;
    expectedAmountCents: number;
    option: "deposit" | "full" | "customPartial";
  };
  paymentSessionReference: string;
  policy: { accepted: true; policyTextHash: string; policyVersion: string };
  sourceId: string;
  verificationToken?: string;
  ipAddress?: string;
  userAgent?: string;
}

export type ChargeAndStoreBookingResult =
  | {
      ok: true;
      bookingStatus: "booked" | "manual_followup";
      holdReference: string;
      paymentStatus: "captured";
      card: {
        last4?: string;
        brand?: string;
        expMonth?: number;
        expYear?: number;
      };
    }
  | {
      ok: false;
      error:
        | "invalid_request"
        | "hold_unavailable"
        | "payment_declined"
        | "square_api_error"
        | "infrastructure_error";
      message: string;
    };
```

Define repository methods for the saga:

```ts
export interface ChargeAndStoreRepository {
  claimPaymentAttempt(input: {
    paymentSessionReference: string;
    idempotencyKey: string;
    now: Date;
  }): Promise<
    | { status: "available"; hold: BookingHoldRecord }
    | {
        status: "confirmed";
        confirmation: Extract<ChargeAndStoreBookingResult, { ok: true }>;
      }
    | { status: "in_progress" }
    | { status: "unavailable" }
  >;
  persistCustomerAndSelection(input: {
    holdId: string;
    customer: ChargeAndStoreBookingRequestBody["customer"];
    payment: ResolvedServicePaymentSelection;
    now: Date;
  }): Promise<void>;
  persistPolicyAcceptance(input: {
    holdId: string;
    policyVersion: string;
    policyTextHash: string;
    maxChargeCents: number;
    currency: "CAD";
    customerEmail: string;
    customerName: string;
    ipHash?: string;
    userAgentHash?: string;
    now: Date;
  }): Promise<{ id: string }>;
  persistSquareCustomer(input: {
    email: string;
    name: string;
    phone: string;
    squareCustomerId: string;
    now: Date;
  }): Promise<{ id: string; squareCustomerId: string }>;
  findSquareCustomerByEmail(
    email: string,
  ): Promise<{ id: string; squareCustomerId: string } | null>;
  persistSavedPaymentMethod(input: {
    squareCustomerRecordId: string;
    squareCardId: string;
    brand: string;
    last4: string;
    expMonth: number;
    expYear: number;
    now: Date;
  }): Promise<{
    id: string;
    squareCardId: string;
    brand?: string;
    last4?: string;
    expMonth?: number;
    expYear?: number;
  }>;
  createNoShowChargeRecord(input: {
    holdId: string;
    savedPaymentMethodId: string;
    policyAcceptanceId: string;
    squareCustomerId: string;
    squareCardId: string;
    maxChargeCents: number;
    currency: "CAD";
    status: "ready";
    now: Date;
  }): Promise<{ id: string; status: "ready" }>;
  markHoldBooked(input: {
    holdId: string;
    confirmation: Extract<ChargeAndStoreBookingResult, { ok: true }>;
    googleEventId: string;
    now: Date;
  }): Promise<BookingHoldRecord>;
  markHoldManualFollowup(input: {
    holdId: string;
    confirmation: Extract<ChargeAndStoreBookingResult, { ok: true }>;
    reason: string;
    now: Date;
  }): Promise<BookingHoldRecord>;
  markHoldPaymentFailed(input: {
    holdId: string;
    reason: string;
    now: Date;
  }): Promise<void>;
  markHoldRefundRequired(input: {
    holdId: string;
    squarePaymentId: string;
    reason: string;
    now: Date;
  }): Promise<void>;
}
```

- [ ] **Step 4: Implement orchestration order**

Implement `confirmChargeAndStoreBooking(input, dependencies)` with this order:

1. Validate request shape, contact fields, consent, idempotency key, and source token.
2. Claim hold by payment session reference.
3. Reject unless hold is active and `offeringSnapshot.customerStatus === "pending"` or this is a retry with the same terminal confirmation.
4. Read pricing from hold snapshot and call `resolveServicePaymentSelection`.
5. Reject when `input.payment.expectedAmountCents !== resolved.payment.amountCents`.
6. Persist customer and selected payment onto the hold.
7. Persist policy acceptance evidence.
8. Create or reuse Square customer.
9. Create Square payment with `autocomplete: false`, `verification_token`, `source_id`, customer id, amount, and idempotency key.
10. If Square payment status is not `APPROVED`, mark payment failed and return `payment_declined`.
11. Extract `payment.card_details.card.id`. If missing and status is `APPROVED`, call `cancelPayment` and return `square_api_error` without confirmation.
12. Persist saved payment method and no-show charge record.
13. Call `completePayment` to capture.
14. If capture fails, mark `manual_followup` or `refund_required` according to whether Square reports a completed payment in the caught context; do not return normal `booked`.
15. Finalize calendar booking.
16. Return `booked` only when the captured payment, saved card, policy acceptance, no-show record, and calendar event are complete.
17. Return `manual_followup` only after captured payment and saved card exist but calendar finalization requires staff action.

Use `getCanonicalServiceNoShowPolicyEvidence` for policy version/hash normalization and existing `ServicePaymentAlertLogger` for all manual/refund states.

- [ ] **Step 5: Run orchestration tests**

Run: `npx tsx --test src/lib/booking/payments/service-charge-and-store.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/booking/payments/service-charge-and-store.ts src/lib/booking/payments/service-charge-and-store.test.ts
git commit -m "feat: orchestrate service charge and store bookings"
```

---

## Task 8: Add private DB repository and payment confirmation API route

**Files:**

- Add: `src/lib/private-db/service-booking-payment-repository.ts`
- Add: `src/app/api/booking/payment/confirm/route.ts`
- Add: `src/app/api/booking/payment/confirm/route.test.ts`

- [ ] **Step 1: Write route tests**

Create `src/app/api/booking/payment/confirm/route.test.ts` with tests:

```ts
test("rejects missing customer details before orchestration", async () => {});
test("rejects unchecked consent before orchestration", async () => {});
test("passes client IP and user agent to orchestration", async () => {});
test("maps hold_unavailable to 409", async () => {});
test("maps payment_declined to 402", async () => {});
test("returns safe confirmation response without provider identifiers", async () => {});
```

The success response assertion must verify that `sourceId`, `verificationToken`, `squarePaymentId`, and `squareCardId` are absent.

- [ ] **Step 2: Run route tests and verify failure**

Run: `npx tsx --test src/app/api/booking/payment/confirm/route.test.ts`

Expected: FAIL because the route does not exist.

- [ ] **Step 3: Add the route handler**

Create `src/app/api/booking/payment/confirm/route.ts` with `runtime = "nodejs"`. Export `createServiceBookingPaymentConfirmPostHandler(dependencies)` for tests and `POST` for production.

The parser must require:

```ts
paymentSessionReference: non-empty string
customer.name: non-empty string
customer.email: email-like string
customer.phone: non-empty string
customer.marketingOptIn: boolean
payment.option: "deposit" | "full" | "customPartial"
payment.expectedAmountCents: positive integer
policy.accepted: true
policy.policyVersion: non-empty string
policy.policyTextHash: non-empty string
sourceId: non-empty string
idempotencyKey: non-empty string
verificationToken: optional non-empty string
```

Map orchestration failures:

```ts
invalid_request -> 400
hold_unavailable -> 409
payment_declined -> 402
square_api_error -> 502
infrastructure_error -> 503
```

- [ ] **Step 4: Add production dependencies**

In the route’s default `POST`, require `SERVICE_BOOKING_SQUARE_ENABLED=true`; otherwise return 404.

Create dependencies by importing:

```ts
getSquareServiceBookingRuntimeEnv from "@/lib/booking/square-runtime"
createSquarePaymentsClient from "@/lib/payments/square/payments-client"
createSquareCustomersClient from "@/lib/payments/square/customers-client"
createCardOnFileCalendarFinalizer from "@/lib/booking/payments/service-card-on-file-calendar-finalizer"
createServiceBookingPaymentRepository from "@/lib/private-db/service-booking-payment-repository"
createServicePaymentAlertLogger from "@/lib/booking/payments/service-payment-alerts"
```

- [ ] **Step 5: Add repository adapter**

Create `src/lib/private-db/service-booking-payment-repository.ts`. Reuse patterns from `card-on-file-repository.ts`:

- Lock the hold row with `for("update")` in `claimPaymentAttempt`.
- Use `reconciliationMetadata.chargeAndStoreInProgress` as a hold-wide marker with a 30-second TTL.
- Store terminal confirmation at `reconciliationMetadata.chargeAndStoreConfirmation`.
- Update `appointment_holds.customer_snapshot` with real customer only in `persistCustomerAndSelection`.
- Store selected payment details under `offering_snapshot.selectedPayment` and set `offering_snapshot.customerStatus = "captured"`, `offering_snapshot.paymentStatus = "selected"`.
- Insert policy acceptance into `bookingPolicyAcceptances`.
- Insert or reuse Square customers and saved payment methods using existing tables.
- Insert no-show records into `bookingNoShowChargeRecords`.
- Mark booked/manual/refund states on `appointmentHolds` using existing status columns and safe reconciliation metadata.

- [ ] **Step 6: Run route tests**

Run: `npx tsx --test src/app/api/booking/payment/confirm/route.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/booking/payment/confirm/route.ts src/app/api/booking/payment/confirm/route.test.ts src/lib/private-db/service-booking-payment-repository.ts
git commit -m "feat: add service booking payment confirmation api"
```

---

## Task 9: Wire payment form to API and preserve marketing opt-in privately

**Files:**

- Modify: `src/components/booking/service-booking-payment-form.tsx`
- Modify: `src/lib/private-db/service-booking-payment-repository.ts`
- Modify: `src/app/api/booking/payment/confirm/route.test.ts`

- [ ] **Step 1: Add route test for marketing opt-in**

In `src/app/api/booking/payment/confirm/route.test.ts`, add:

```ts
test("passes retained marketing opt-in from payment page", async () => {
  let captured: ChargeAndStoreBookingRequestBody | null = null;
  const handler = createServiceBookingPaymentConfirmPostHandler({
    async confirm(input) {
      captured = input;
      return {
        ok: true,
        bookingStatus: "booked",
        card: { last4: "1111" },
        holdReference: "hold_1",
        paymentStatus: "captured",
      };
    },
  });

  const response = await handler(
    createValidRequest({ customer: { marketingOptIn: true } }),
  );
  assert.equal(response.status, 200);
  assert.equal(captured?.customer.marketingOptIn, true);
});
```

- [ ] **Step 2: Ensure form submits marketing choice**

In `service-booking-payment-form.tsx`, ensure the JSON request includes:

```ts
customer: {
  email,
  marketingOptIn,
  name: fullName,
  phone,
},
```

- [ ] **Step 3: Persist marketing choice as private contact side effect**

In `service-booking-payment-repository.ts`, after real customer details are persisted on the hold, call the existing private marketing store from the route orchestration layer, not from Sanity. If the repository should not import marketing code directly, add a `recordMarketingChoice` dependency to the route’s production runner and pass:

```ts
{
  answers: hold.offeringSnapshot.answers,
  bookingType: "in-person-appointment",
  consentText: "I would like to receive updates and offers from Lash Her by Nataliea.",
  email: input.customer.email,
  marketingOptIn: input.customer.marketingOptIn,
  name: input.customer.name,
  phone: input.customer.phone,
  sourcePath: hold.offeringSnapshot.sourcePath,
}
```

Log failures with `log("error", "[booking payment] Marketing consent persistence failed", ...)` and do not block payment confirmation.

- [ ] **Step 4: Run focused tests**

Run: `npx tsx --test src/app/api/booking/payment/confirm/route.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/booking/service-booking-payment-form.tsx src/app/api/booking/payment/confirm/route.ts src/app/api/booking/payment/confirm/route.test.ts src/lib/private-db/service-booking-payment-repository.ts
git commit -m "feat: retain service booking marketing choice on payment"
```

---

## Task 10: Update browser coverage for the full split flow

**Files:**

- Modify: `tests/service-booking-payment-page.spec.ts`

- [ ] **Step 1: Update Playwright mocks**

In `tests/service-booking-payment-page.spec.ts`, update the fake inserted hold snapshot so it has `pricing` instead of `payment`:

```ts
JSON.stringify({
  serviceSlug: SERVICE_SLUG,
  title: "Lash Fill",
  customerStatus: "pending",
  paymentStatus: "pending",
  pricing: {
    depositAmount: 50,
    fullPrice: 130,
    currency: "CAD",
    customAmountMinimum: 50,
    customAmountMaximum: 130,
    addOnPrice: 0,
  },
});
```

Update the page route mock for `/api/booking/holds` to assert no contact/payment fields:

```ts
const body = await route.request().postDataJSON();
expect(body.name).toBeUndefined();
expect(body.email).toBeUndefined();
expect(body.phone).toBeUndefined();
expect(body.paymentOption).toBeUndefined();
```

- [ ] **Step 2: Update Square SDK mock to capture verification details**

In the Square script mock, set:

```js
window.__squareVerificationDetails = null;
```

and implement tokenize:

```js
tokenize: async function (verificationDetails) {
  window.__squareVerificationDetails = verificationDetails;
  return { status: "OK", token: "cnon:test", verificationToken: "verf:test" };
}
```

- [ ] **Step 3: Mock payment confirmation API**

Add a route mock:

```ts
await page.route("**/api/booking/payment/confirm", async (route) => {
  const body = await route.request().postDataJSON();
  expect(body.customer.name).toBe("Playwright Test");
  expect(body.customer.email).toBe("client@example.test");
  expect(body.customer.phone).toBe("5550100000");
  expect(body.customer.marketingOptIn).toBe(true);
  expect(body.policy.accepted).toBe(true);
  expect(body.sourceId).toBe("cnon:test");
  expect(body.verificationToken).toBe("verf:test");
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      bookingStatus: "booked",
      card: { last4: "1111" },
      holdReference: publicReference,
      paymentStatus: "captured",
    }),
  });
});
```

- [ ] **Step 4: Update user interactions**

Remove contact field filling from the booking page. After the redirect to payment page, fill contact fields, select marketing opt-in, check consent, and click `Pay and confirm booking`.

Assert Square tokenization details:

```ts
const verificationDetails = await page.evaluate(
  () => window.__squareVerificationDetails,
);
expect(verificationDetails.intent).toBe("CHARGE_AND_STORE");
expect(verificationDetails.currencyCode).toBe("CAD");
expect(verificationDetails.billingContact.countryCode).toBe("CA");
expect(verificationDetails.billingContact.email).toBe("client@example.test");
```

Assert no misleading copy:

```ts
await expect(page.getByText(/No payment is taken today/i)).toHaveCount(0);
await expect(page.getByText(/postal code/i)).toBeVisible();
await expect(page.getByText(/ZIP/i)).toHaveCount(0);
```

- [ ] **Step 5: Run focused browser test**

Run: `npx playwright test tests/service-booking-payment-page.spec.ts --project=chromium`

Expected: PASS when `SERVICE_BOOKING_PAYMENT_E2E_DB_WRITES=true` and `DATABASE_URL` are available; otherwise the DB-write test self-skips after validating the skip precondition.

- [ ] **Step 6: Commit**

```bash
git add tests/service-booking-payment-page.spec.ts
git commit -m "test: cover service booking charge and store payment"
```

---

## Task 11: Run integration verification and final review

**Files:**

- Review all changed files from Tasks 1-10.

- [ ] **Step 1: Run focused unit suites**

Run:

```bash
npx tsx --test src/components/booking/booking-flow.test.ts
npx tsx --test src/app/api/booking/holds/route.test.ts
npx tsx --test src/lib/booking/payment-session.test.ts
npx tsx --test src/lib/booking/payments/service-payment-selection.test.ts
npx tsx --test src/lib/payments/square/payments-client.test.ts
npx tsx --test src/lib/booking/payments/service-charge-and-store.test.ts
npx tsx --test src/app/api/booking/payment/confirm/route.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run broader unit tests for touched domains**

Run:

```bash
npm run test:unit
```

Expected: PASS.

- [ ] **Step 3: Run lint**

Run:

```bash
npm run lint
```

Expected: PASS.

- [ ] **Step 4: Run build**

Run:

```bash
npm run build
```

Expected: PASS. If `scripts/validate-sanity-env.mjs` fails, fix environment dataset alignment before rerunning.

- [ ] **Step 5: Security/privacy review**

Search changed files and confirm none persist or expose raw Square source tokens, verification tokens, card numbers, CVV, provider secrets, or private payment data in Sanity:

```bash
git diff -- src components tests | rg "sourceId|verificationToken|cnon:|verf:|card_number|cvv|secret|Sanity"
```

Expected: matches only request parsing/transient API payload handling, tests, and redaction assertions; no Sanity writes and no token persistence.

- [ ] **Step 6: Request code review**

Use the `requesting-code-review` skill or delegate to code review with this focus:

```text
Review the service booking payment split for: privacy boundaries, Square charge-and-store ordering, consent-before-capture, idempotency, failure states, and misleading payment copy removal.
```

- [ ] **Step 7: Commit final fixes**

If review or verification requires fixes, apply them and commit:

```bash
git add <fixed-files>
git commit -m "fix: harden service booking payment flow"
```

---

## Plan Self-Review

- Spec coverage: The tasks cover booking page field removal, provisional holds, payment session resolution, payment page fields, Square `CHARGE_AND_STORE` with Canadian billing contact, consent-before-tokenization and consent-before-capture, private DB persistence, no Sanity storage, accurate copy, recovery states, idempotency, and unit/browser tests.
- Placeholder scan: The plan contains no placeholder markers, no deferred implementation steps, and no unspecified test commands.
- Type consistency: `ServicePaymentOption`, `ServicePaymentPricingSnapshot`, `ChargeAndStoreBookingRequestBody`, and session pricing fields use cents consistently after the payment session boundary.
- Remaining implementation risk: Square `CHARGE_AND_STORE` card id availability is handled by delayed-capture cancellation when missing and by `refund_required`/manual follow-up only when Square reports an already completed captured payment.
