# Service Booking Dedicated Payment Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move service booking card-on-file payment to `/services/[slug]/booking/payment?session=...`, fix the Square iframe attach race, and trace the availability route deprecation warning.

**Architecture:** Extend existing `appointment_holds` with an opaque `paymentSessionReference` used only for the dedicated payment handoff. The booking intake page creates a hold/session and redirects to a dynamic payment page; the payment page resolves private hold state server-side and owns Square card-on-file, retry, expiration, and legacy checkout fallback behavior.

**Tech Stack:** Next.js 16 App Router, React client components, Drizzle/PostgreSQL, Node test runner via `tsx`, Playwright, Square Web Payments SDK.

---

## File Structure

- Modify `src/lib/private-db/schema.ts` — add `appointment_holds.payment_session_reference` and a unique index.
- Add `drizzle/0015_service_booking_payment_session.sql` — SQL migration for the new column/index.
- Modify `src/lib/private-db/schema.test.ts` — assert schema exposes the new column and index.
- Modify `src/lib/booking/holds.ts` — include `paymentSessionReference` in records, generate it when creating holds, and add lookup by session.
- Modify `src/lib/booking/holds.test.ts` — cover generated payment session references and lookup behavior.
- Modify `src/app/api/booking/holds/route.ts` and `src/app/api/booking/holds/route.test.ts` — return payment page handoff data.
- Modify `src/components/booking/booking-flow.tsx` and `src/components/booking/booking-flow.test.ts` — redirect to the dedicated payment page after hold creation and remove inline Square form ownership.
- Add `src/lib/booking/payment-session.ts` and `src/lib/booking/payment-session.test.ts` — create safe payment-session display/resolution helpers.
- Add `src/app/(site)/services/[slug]/booking/payment/page.tsx` — dynamic server route for payment session validation.
- Add `src/components/booking/service-booking-payment-shell.tsx` — client payment-page UI shell.
- Modify `src/components/booking/square-card-on-file-form.tsx` — accept session reference, keep card container mounted before Square attach, and preserve error/retry states.
- Modify `src/app/api/booking/card-on-file/route.ts`, `src/lib/booking/payments/service-card-on-file.ts`, and `src/lib/private-db/card-on-file-repository.ts` — confirm by payment session reference while keeping hold-reference compatibility.
- Modify `src/app/api/booking/checkout/route.ts` — allow legacy fallback to start from payment session reference.
- Modify focused tests in `src/app/api/booking/card-on-file/route.test.ts`, `src/lib/booking/payments/service-card-on-file.test.ts`, and `src/app/api/booking/checkout/route.test.ts`.
- Add/update Playwright coverage in `tests/booking-card-on-file-config.spec.ts` or a new `tests/service-booking-payment-page.spec.ts`.
- Add `docs/superpowers/reports/2026-07-01-availability-deprecation-trace.md` — document DEP0169 source and remediation.

---

### Task 1: Add payment session reference to private DB schema

**Files:**

- Modify: `src/lib/private-db/schema.ts`
- Modify: `src/lib/private-db/schema.test.ts`
- Create: `drizzle/0015_service_booking_payment_session.sql`

- [ ] **Step 1: Write the failing schema test**

In `src/lib/private-db/schema.test.ts`, add assertions beside existing `appointment_holds` index assertions:

```ts
test("appointment holds expose opaque payment session handoff reference", () => {
  const schemaSource = readFileSync(
    new URL("./schema.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    schemaSource,
    /paymentSessionReference:\s*text\("payment_session_reference"\)\.notNull\(\)/,
  );
  assert.match(
    schemaSource,
    /uniqueIndex\("appointment_holds_payment_session_reference_idx"\)\.on\(\s*table\.paymentSessionReference\s*\)/s,
  );
});
```

- [ ] **Step 2: Run the schema test and verify it fails**

Run: `npx tsx --test src/lib/private-db/schema.test.ts`

Expected: FAIL because `paymentSessionReference` and `appointment_holds_payment_session_reference_idx` are not present.

- [ ] **Step 3: Add the schema column and index**

In `src/lib/private-db/schema.ts`, add the column after `publicReference`:

```ts
    paymentSessionReference: text("payment_session_reference").notNull(),
```

Add the unique index after `appointment_holds_public_reference_idx`:

```ts
    uniqueIndex("appointment_holds_payment_session_reference_idx").on(
      table.paymentSessionReference,
    ),
```

- [ ] **Step 4: Add SQL migration**

Create `drizzle/0015_service_booking_payment_session.sql`:

```sql
ALTER TABLE "appointment_holds" ADD COLUMN "payment_session_reference" text;--> statement-breakpoint
UPDATE "appointment_holds"
SET "payment_session_reference" = 'pay_sess_' || replace("id"::text, '-', '')
WHERE "payment_session_reference" IS NULL;--> statement-breakpoint
ALTER TABLE "appointment_holds" ALTER COLUMN "payment_session_reference" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_holds_payment_session_reference_idx" ON "appointment_holds" USING btree ("payment_session_reference");
```

- [ ] **Step 5: Run the schema test and migration generation check**

Run: `npx tsx --test src/lib/private-db/schema.test.ts`

Expected: PASS.

Run: `npm run db:generate`

Expected: Either no generated changes or a generated migration equivalent to `0015_service_booking_payment_session.sql`. If Drizzle creates a duplicate migration, keep one migration and ensure `drizzle` metadata remains consistent with repository conventions.

- [ ] **Step 6: Commit**

```bash
git add src/lib/private-db/schema.ts src/lib/private-db/schema.test.ts drizzle/0015_service_booking_payment_session.sql
git commit -m "feat: add booking payment session reference"
```

---

### Task 2: Generate and resolve payment session references on appointment holds

**Files:**

- Modify: `src/lib/booking/holds.ts`
- Modify: `src/lib/booking/holds.test.ts`

- [ ] **Step 1: Write failing hold tests**

In `src/lib/booking/holds.test.ts`, add tests near the existing hold creation and lookup tests:

```ts
test("createBookingHold creates an opaque payment session reference", async () => {
  const repository = new InMemoryAppointmentHoldRepository();
  const result = await createBookingHold({
    bookingType: "in-person-appointment",
    customer: {
      email: "client@example.com",
      name: "Client Name",
      phone: "5551234567",
    },
    offeringId: "service-1",
    offeringSnapshot: { title: "Lash Fill" },
    selectedStart: new Date("2030-01-01T18:00:00.000Z"),
    selectedEnd: new Date("2030-01-01T19:00:00.000Z"),
    timezone: "America/Toronto",
    now: new Date("2030-01-01T17:00:00.000Z"),
    repository,
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.match(
      result.hold.paymentSessionReference,
      /^pay_sess_[A-Za-z0-9_-]{16}$/,
    );
    assert.notEqual(
      result.hold.paymentSessionReference,
      result.hold.publicReference,
    );
  }
});

test("getAppointmentHoldByPaymentSessionReference resolves payment sessions", async () => {
  const repository = new InMemoryAppointmentHoldRepository();
  const created = await createBookingHold({
    bookingType: "in-person-appointment",
    customer: {
      email: "client@example.com",
      name: "Client Name",
      phone: "5551234567",
    },
    offeringId: "service-1",
    offeringSnapshot: { title: "Lash Fill" },
    selectedStart: new Date("2030-01-01T18:00:00.000Z"),
    selectedEnd: new Date("2030-01-01T19:00:00.000Z"),
    timezone: "America/Toronto",
    now: new Date("2030-01-01T17:00:00.000Z"),
    repository,
  });

  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("Expected hold creation to succeed");

  const resolved = await getAppointmentHoldByPaymentSessionReference(
    created.hold.paymentSessionReference,
    repository,
  );

  assert.equal(resolved?.id, created.hold.id);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npx tsx --test src/lib/booking/holds.test.ts`

Expected: FAIL because `paymentSessionReference` and `getAppointmentHoldByPaymentSessionReference` do not exist.

- [ ] **Step 3: Update hold types and repository interface**

In `src/lib/booking/holds.ts`, add to `BookingHoldRecord` after `publicReference`:

```ts
paymentSessionReference: string;
```

Add to `CreateBookingHoldRecordInput` after `bookingType` or before `customer`:

```ts
  paymentSessionReference?: string;
```

Add to `BookingHoldRepository`:

```ts
  getByPaymentSessionReference?(paymentSessionReference: string): Promise<BookingHoldRecord | null>;
```

- [ ] **Step 4: Generate session reference during creation**

In `createBookingHold` or the call path that builds the record for `createConflictSafeHold`, include:

```ts
    paymentSessionReference:
      input.paymentSessionReference ?? generatePaymentSessionReference(),
```

Add near `generateAppointmentHoldReference()`:

```ts
function generatePaymentSessionReference(): string {
  return `pay_sess_${nanoid(16)}`;
}
```

- [ ] **Step 5: Persist and map the new field**

In `createDrizzleAppointmentHoldRepository().createConflictSafeHold`, insert:

```ts
            paymentSessionReference: input.paymentSessionReference ?? generatePaymentSessionReference(),
```

In `toBookingHoldRecord`, add:

```ts
    paymentSessionReference: row.paymentSessionReference,
```

- [ ] **Step 6: Add lookup function**

In `src/lib/booking/holds.ts`, add:

```ts
export async function getAppointmentHoldByPaymentSessionReference(
  paymentSessionReference: string,
  repository: AppointmentHoldLifecycleRepository = createDrizzleAppointmentHoldRepository(),
): Promise<BookingHoldRecord | null> {
  if (repository.getByPaymentSessionReference !== undefined) {
    return repository.getByPaymentSessionReference(paymentSessionReference);
  }

  return getAppointmentHoldByPaymentSessionReferenceFromDb(
    paymentSessionReference,
  );
}

async function getAppointmentHoldByPaymentSessionReferenceFromDb(
  paymentSessionReference: string,
): Promise<BookingHoldRecord | null> {
  const [row] = await (await getAppointmentHoldDb())
    .select()
    .from(appointmentHolds)
    .where(
      eq(appointmentHolds.paymentSessionReference, paymentSessionReference),
    )
    .limit(1);

  return row === undefined ? null : toBookingHoldRecord(row);
}
```

Also add `getByPaymentSessionReference` to the returned Drizzle repository object:

```ts
    async getByPaymentSessionReference(paymentSessionReference) {
      return getAppointmentHoldByPaymentSessionReferenceFromDb(paymentSessionReference);
    },
```

- [ ] **Step 7: Update in-memory test repository records**

In `src/lib/booking/holds.test.ts`, update the in-memory repository record creation to include:

```ts
paymentSessionReference: input.paymentSessionReference ?? `pay_sess_${this.records.length + 1}`,
```

Add method:

```ts
async getByPaymentSessionReference(paymentSessionReference: string) {
  return this.records.find((record) => record.paymentSessionReference === paymentSessionReference) ?? null;
}
```

- [ ] **Step 8: Run hold tests**

Run: `npx tsx --test src/lib/booking/holds.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/booking/holds.ts src/lib/booking/holds.test.ts
git commit -m "feat: resolve booking payment sessions"
```

---

### Task 3: Return payment page handoff data from booking holds API

**Files:**

- Modify: `src/app/api/booking/holds/route.ts`
- Modify: `src/app/api/booking/holds/route.test.ts`
- Modify: `src/components/booking/booking-flow.tsx`
- Modify: `src/components/booking/booking-flow.test.ts`

- [ ] **Step 1: Write failing route test for payment session handoff**

In `src/app/api/booking/holds/route.test.ts`, update the successful hold test expected response to include:

```ts
assert.equal(body.hold.paymentSessionReference, "pay_sess_test_1");
assert.equal(
  body.hold.paymentPageUrl,
  "/services/classic-fill/booking/payment?session=pay_sess_test_1",
);
assert.equal(body.hold.reference, undefined);
```

Ensure the mocked hold includes:

```ts
paymentSessionReference: "pay_sess_test_1",
```

- [ ] **Step 2: Run route test and verify failure**

Run: `npx tsx --test src/app/api/booking/holds/route.test.ts`

Expected: FAIL because the response returns `reference` and not `paymentSessionReference`/`paymentPageUrl`.

- [ ] **Step 3: Change holds API response shape**

In `src/app/api/booking/holds/route.ts`, replace the hold response block with:

```ts
          hold: {
            paymentSessionReference: holdResult.hold.paymentSessionReference,
            paymentPageUrl: `/services/${service.slug}/booking/payment?${new URLSearchParams({
              session: holdResult.hold.paymentSessionReference,
            }).toString()}`,
            expiresAt: holdResult.hold.expiresAt.toISOString(),
            start: holdResult.hold.selectedStart.toISOString(),
            end: holdResult.hold.selectedEnd.toISOString(),
            service: {
              slug: service.slug,
              title: service.title,
            },
          },
```

- [ ] **Step 4: Update client hold result type and navigation**

In `src/components/booking/booking-flow.tsx`, change `createBookingHold` return type to:

```ts
export async function createBookingHold(
  input: PaidServiceCheckoutInput,
): Promise<{ paymentPageUrl: string; paymentSessionReference: string }> {
```

Change hold data parsing to:

```ts
const holdData = (await holdRes.json()) as {
  hold?: { paymentPageUrl?: unknown; paymentSessionReference?: unknown };
};
const paymentPageUrl = holdData.hold?.paymentPageUrl;
const paymentSessionReference = holdData.hold?.paymentSessionReference;

if (
  typeof paymentPageUrl !== "string" ||
  paymentPageUrl.length === 0 ||
  typeof paymentSessionReference !== "string" ||
  paymentSessionReference.length === 0
) {
  throw new Error("Failed to hold appointment time");
}

return { paymentPageUrl, paymentSessionReference };
```

In `handleSubmit`, replace inline card-on-file state with navigation:

```ts
const { paymentPageUrl } = await createBookingHold({
  answers: Object.entries(answers).map(([questionId, answer]) => ({
    questionId,
    answer,
  })),
  email,
  marketingConsentText,
  marketingOptIn,
  name,
  paymentOption,
  phone,
  serviceSlug: selectedServiceSlug,
  ...(selectedAddOnKey ? { selectedAddOnKey } : {}),
  sourcePath: pathname,
  start: selectedSlot,
  ...(parsedCustomAmount ? { customAmount: parsedCustomAmount } : {}),
});

window.location.assign(paymentPageUrl);
```

- [ ] **Step 5: Remove inline Square status rendering from booking details**

In `src/components/booking/booking-flow.tsx`, remove the inline `<SquareCardOnFileForm>` status panel from the details form. Keep `startLegacySquareCheckout` exported for fallback tests and payment shell reuse. Remove unused state/callbacks caused by the inline removal.

- [ ] **Step 6: Update booking-flow tests**

In `src/components/booking/booking-flow.test.ts`, replace assertions that expect inline card-on-file rendering in `BookingFlow` with source assertions:

```ts
it("redirects service booking holds to a dedicated payment page", () => {
  assert.match(bookingFlowSource, /paymentPageUrl/);
  assert.match(bookingFlowSource, /window\.location\.assign\(paymentPageUrl\)/);
  assert.doesNotMatch(bookingFlowSource, /cardOnFileHoldReference/);
});
```

Update `createBookingHold` fetcher tests to expect:

```ts
return Response.json({
  hold: {
    paymentPageUrl:
      "/services/classic-fill/booking/payment?session=pay_sess_test_1",
    paymentSessionReference: "pay_sess_test_1",
  },
});
```

Expected result:

```ts
assert.deepEqual(result, {
  paymentPageUrl:
    "/services/classic-fill/booking/payment?session=pay_sess_test_1",
  paymentSessionReference: "pay_sess_test_1",
});
```

- [ ] **Step 7: Run focused tests**

Run: `npx tsx --test src/app/api/booking/holds/route.test.ts src/components/booking/booking-flow.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/app/api/booking/holds/route.ts src/app/api/booking/holds/route.test.ts src/components/booking/booking-flow.tsx src/components/booking/booking-flow.test.ts
git commit -m "feat: route service bookings to payment page"
```

---

### Task 4: Add payment session resolver and dedicated payment page

**Files:**

- Create: `src/lib/booking/payment-session.ts`
- Create: `src/lib/booking/payment-session.test.ts`
- Create: `src/app/(site)/services/[slug]/booking/payment/page.tsx`

- [ ] **Step 1: Write resolver tests**

Create `src/lib/booking/payment-session.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { resolveServiceBookingPaymentSession } from "./payment-session";
import type { BookingHoldRecord } from "./holds";

const activeHold = createHold({
  state: "held",
  expiresAt: new Date("2030-01-01T18:10:00.000Z"),
});

test("resolves active payment sessions into safe display data", async () => {
  const result = await resolveServiceBookingPaymentSession({
    serviceSlug: "classic-fill",
    sessionReference: "pay_sess_1",
    now: new Date("2030-01-01T18:00:00.000Z"),
    getHoldByPaymentSessionReference: async () => activeHold,
  });

  assert.deepEqual(result, {
    status: "active",
    session: {
      paymentSessionReference: "pay_sess_1",
      serviceSlug: "classic-fill",
      serviceTitle: "Classic Fill",
      selectedStart: "2030-01-02T19:00:00.000Z",
      selectedEnd: "2030-01-02T20:00:00.000Z",
      timezone: "America/Toronto",
      expiresAt: "2030-01-01T18:10:00.000Z",
      customerName: "Client Name",
      totalCents: 13000,
      currency: "CAD",
    },
  });
});

test("rejects slug mismatches", async () => {
  const result = await resolveServiceBookingPaymentSession({
    serviceSlug: "volume-fill",
    sessionReference: "pay_sess_1",
    now: new Date("2030-01-01T18:00:00.000Z"),
    getHoldByPaymentSessionReference: async () => activeHold,
  });

  assert.deepEqual(result, { status: "not_found" });
});

test("returns expired for expired sessions", async () => {
  const result = await resolveServiceBookingPaymentSession({
    serviceSlug: "classic-fill",
    sessionReference: "pay_sess_1",
    now: new Date("2030-01-01T18:11:00.000Z"),
    getHoldByPaymentSessionReference: async () => activeHold,
  });

  assert.deepEqual(result, { status: "expired", serviceSlug: "classic-fill" });
});

test("returns confirmed for already booked sessions", async () => {
  const result = await resolveServiceBookingPaymentSession({
    serviceSlug: "classic-fill",
    sessionReference: "pay_sess_1",
    now: new Date("2030-01-01T18:00:00.000Z"),
    getHoldByPaymentSessionReference: async () =>
      createHold({ state: "booked" }),
  });

  assert.deepEqual(result, { status: "confirmed", paymentStatus: "booked" });
});

function createHold(overrides: Partial<BookingHoldRecord>): BookingHoldRecord {
  return {
    bookingType: "in-person-appointment",
    createdAt: new Date("2030-01-01T17:59:00.000Z"),
    customer: {
      email: "client@example.com",
      name: "Client Name",
      phone: "5551234567",
    },
    expiresAt: new Date("2030-01-01T18:10:00.000Z"),
    googleEventId: null,
    id: "hold-id-1",
    offeringId: "service-1",
    offeringSnapshot: {
      serviceSlug: "classic-fill",
      title: "Classic Fill",
      payment: { amount: 130, currency: "CAD" },
    },
    paidAt: null,
    payment: null,
    paymentProvider: "square",
    publicReference: "hold_public_1",
    paymentSessionReference: "pay_sess_1",
    selectedEnd: new Date("2030-01-02T20:00:00.000Z"),
    selectedStart: new Date("2030-01-02T19:00:00.000Z"),
    state: "held",
    timezone: "America/Toronto",
    updatedAt: new Date("2030-01-01T17:59:00.000Z"),
    ...overrides,
  };
}
```

- [ ] **Step 2: Run resolver test and verify failure**

Run: `npx tsx --test src/lib/booking/payment-session.test.ts`

Expected: FAIL because `payment-session.ts` does not exist.

- [ ] **Step 3: Implement resolver helper**

Create `src/lib/booking/payment-session.ts`:

```ts
import type { BookingHoldRecord } from "./holds";
import {
  getAppointmentHoldByPaymentSessionReference,
  isActiveHold,
} from "./holds";

export interface ServiceBookingPaymentSessionDisplay {
  currency: "CAD";
  customerName: string;
  expiresAt: string;
  paymentSessionReference: string;
  selectedEnd: string;
  selectedStart: string;
  serviceSlug: string;
  serviceTitle: string;
  timezone: string;
  totalCents: number;
}

export type ServiceBookingPaymentSessionResult =
  | { status: "active"; session: ServiceBookingPaymentSessionDisplay }
  | { status: "expired"; serviceSlug: string }
  | { status: "confirmed"; paymentStatus: "booked" | "manual_followup" }
  | { status: "not_found" };

export async function resolveServiceBookingPaymentSession(input: {
  getHoldByPaymentSessionReference?: (
    reference: string,
  ) => Promise<BookingHoldRecord | null>;
  now?: Date;
  serviceSlug: string;
  sessionReference: string;
}): Promise<ServiceBookingPaymentSessionResult> {
  const now = input.now ?? new Date();
  const hold = await (
    input.getHoldByPaymentSessionReference ??
    getAppointmentHoldByPaymentSessionReference
  )(input.sessionReference);

  if (hold === null) return { status: "not_found" };

  const snapshot = readServiceSnapshot(hold.offeringSnapshot);
  if (snapshot.serviceSlug !== input.serviceSlug)
    return { status: "not_found" };

  if (hold.state === "booked")
    return { status: "confirmed", paymentStatus: "booked" };
  if (hold.state === "manual_followup")
    return { status: "confirmed", paymentStatus: "manual_followup" };
  if (!isActiveHold(hold, now))
    return { status: "expired", serviceSlug: input.serviceSlug };

  return {
    status: "active",
    session: {
      currency: snapshot.currency,
      customerName: hold.customer.name,
      expiresAt: hold.expiresAt.toISOString(),
      paymentSessionReference: hold.paymentSessionReference,
      selectedEnd: hold.selectedEnd.toISOString(),
      selectedStart: hold.selectedStart.toISOString(),
      serviceSlug: snapshot.serviceSlug,
      serviceTitle: snapshot.title,
      timezone: hold.timezone,
      totalCents: Math.round(snapshot.amount * 100),
    },
  };
}

function readServiceSnapshot(snapshot: Record<string, unknown>): {
  amount: number;
  currency: "CAD";
  serviceSlug: string;
  title: string;
} {
  const serviceSlug =
    typeof snapshot.serviceSlug === "string" ? snapshot.serviceSlug : "";
  const title = typeof snapshot.title === "string" ? snapshot.title : "Service";
  const payment = snapshot.payment;
  const amount =
    payment !== null &&
    typeof payment === "object" &&
    "amount" in payment &&
    typeof (payment as { amount?: unknown }).amount === "number"
      ? (payment as { amount: number }).amount
      : 0;

  return { amount, currency: "CAD", serviceSlug, title };
}
```

- [ ] **Step 4: Add dedicated payment page**

Create `src/app/(site)/services/[slug]/booking/payment/page.tsx`:

```tsx
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ServiceBookingPaymentShell } from "@/components/booking/service-booking-payment-shell";
import { resolveServiceBookingPaymentSession } from "@/lib/booking/payment-session";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function ServiceBookingPaymentPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ session?: string }>;
}) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const sessionReference =
    typeof query.session === "string" ? query.session.trim() : "";

  if (sessionReference.length === 0) {
    notFound();
  }

  const result = await resolveServiceBookingPaymentSession({
    serviceSlug: slug,
    sessionReference,
  });

  if (result.status === "not_found") {
    notFound();
  }

  if (result.status === "confirmed") {
    redirect(`/booking/confirmation?payment=${result.paymentStatus}`);
  }

  if (result.status === "expired") {
    return (
      <section
        className="min-h-screen bg-lh-neutral-2 py-12 lg:py-24"
        aria-label="Service booking payment expired"
      >
        <div className="content-container mx-auto max-w-3xl text-center">
          <p className="eyebrow-label mb-3">Secure payment</p>
          <h1 className="section-heading mb-4">This payment session expired</h1>
          <p className="mb-8 text-lh-muted">
            Please choose another appointment time so we can create a fresh
            private hold.
          </p>
          <Link
            href={`/services/${result.serviceSlug}/booking`}
            className="btn-primary inline-flex rounded-full px-7 py-4"
          >
            Choose another time
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section
      className="min-h-screen bg-lh-neutral-2 py-12 lg:py-24"
      aria-label="Service booking payment"
    >
      <div className="content-container mx-auto max-w-5xl">
        <ServiceBookingPaymentShell session={result.session} />
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Create temporary shell stub for compilation**

Create `src/components/booking/service-booking-payment-shell.tsx`:

```tsx
"use client";

import type { ServiceBookingPaymentSessionDisplay } from "@/lib/booking/payment-session";

export function ServiceBookingPaymentShell({
  session,
}: {
  session: ServiceBookingPaymentSessionDisplay;
}) {
  return <div>{session.serviceTitle}</div>;
}
```

- [ ] **Step 6: Run resolver and route-adjacent tests**

Run: `npx tsx --test src/lib/booking/payment-session.test.ts`

Expected: PASS.

Run: `npm run lint`

Expected: PASS for changed files.

- [ ] **Step 7: Commit**

```bash
git add src/lib/booking/payment-session.ts src/lib/booking/payment-session.test.ts "src/app/(site)/services/[slug]/booking/payment/page.tsx" src/components/booking/service-booking-payment-shell.tsx
git commit -m "feat: add service booking payment page"
```

---

### Task 5: Refactor Square form for stable container and session confirmation

**Files:**

- Modify: `src/components/booking/square-card-on-file-form.tsx`
- Modify: `src/components/booking/service-booking-payment-shell.tsx`
- Modify: `src/components/booking/booking-flow.test.ts`

- [ ] **Step 1: Write failing source regression test for stable container**

In `src/components/booking/booking-flow.test.ts`, add:

```ts
it("keeps the Square card container mounted while initializing", () => {
  assert.doesNotMatch(
    cardOnFileFormSource,
    /if \(isConfigLoading \|\| isInitializing\) \{[\s\S]*?return \(/,
  );
  assert.match(cardOnFileFormSource, /cardContainerId/);
  assert.match(
    cardOnFileFormSource,
    /await card\.attach\(`#\$\{cardContainerId\}`\)/,
  );
});
```

- [ ] **Step 2: Run source test and verify failure**

Run: `npx tsx --test src/components/booking/booking-flow.test.ts`

Expected: FAIL because the form currently returns early and uses `#square-card-container`.

- [ ] **Step 3: Change Square form props**

In `src/components/booking/square-card-on-file-form.tsx`, replace props with:

```ts
interface SquareCardOnFileFormProps {
  cardholderName: string;
  maxChargeCents: number;
  paymentSessionReference: string;
  onSuccess: (result: CardOnFileConfirmationResult) => void;
  onError: (message: string) => void;
  onHoldExpired?: () => void;
  onConfigUnavailable?: () => void;
}
```

Add import:

```ts
import { useId } from "react";
```

Change current import to:

```ts
import { useEffect, useId, useRef, useState } from "react";
```

- [ ] **Step 4: Use unique container id and attach after it is rendered**

Inside `SquareCardOnFileForm`, add:

```ts
const reactId = useId();
const cardContainerId = `square-card-container-${reactId.replace(/:/g, "")}`;
```

Replace:

```ts
await card.attach("#square-card-container");
```

with:

```ts
await card.attach(`#${cardContainerId}`);
```

Update the effect dependency array:

```ts
  }, [cardContainerId, config]);
```

- [ ] **Step 5: Remove loading early return and keep container rendered**

Delete the early return block:

```tsx
if (isConfigLoading || isInitializing) {
  return (
    <div className="rounded-[18px] border border-lh-line bg-lh-neutral-2 p-5 text-center shadow-sm">
      <p className="font-body text-sm font-bold leading-6 text-lh-muted">
        Loading secure card form...
      </p>
    </div>
  );
}
```

Replace the card container section with:

```tsx
{
  (isConfigLoading || isInitializing) && (
    <p className="text-center text-sm font-bold text-lh-muted">
      Loading secure card form...
    </p>
  );
}
<section
  id={cardContainerId}
  className="min-h-[120px] rounded-xl border border-lh-line bg-white p-4"
  aria-label="Secure card entry"
/>;
```

Set the button disabled state to:

```tsx
          disabled={isSubmitting || isConfigLoading || isInitializing || cardRef.current === null}
```

- [ ] **Step 6: Send session reference to confirmation API**

In `handleSaveCard`, replace `holdReference` in the `confirmCardOnFileBooking` call with:

```ts
        paymentSessionReference,
```

Update local `CardOnFileBookingRequestBody` interface to:

```ts
paymentSessionReference: string;
```

Update `confirmCardOnFileBooking` body:

```ts
    paymentSessionReference: input.paymentSessionReference,
```

- [ ] **Step 7: Implement payment shell UI**

Replace `src/components/booking/service-booking-payment-shell.tsx` stub with:

```tsx
"use client";

import Link from "next/link";
import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import { formatCad } from "@/lib/commerce/money";
import type { ServiceBookingPaymentSessionDisplay } from "@/lib/booking/payment-session";

import {
  SquareCardOnFileForm,
  startLegacySquareCheckout,
  BookingHoldExpiredError,
} from "./square-card-on-file-form";
import type { CardOnFileConfirmationResult } from "./square-card-on-file-form";

export function ServiceBookingPaymentShell({
  session,
}: {
  session: ServiceBookingPaymentSessionDisplay;
}) {
  const [errorMessage, setErrorMessage] = useState("");
  const [isExpired, setIsExpired] = useState(
    new Date(session.expiresAt).getTime() <= Date.now(),
  );
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);

  const handleSuccess = useCallback((result: CardOnFileConfirmationResult) => {
    const status =
      result.bookingStatus === "booked" ? "booked" : "manual_followup";
    window.location.assign(`/booking/confirmation?payment=${status}`);
  }, []);

  const handleError = useCallback((message: string) => {
    setErrorMessage(message);
  }, []);

  const handleExpired = useCallback(() => {
    setIsExpired(true);
    setErrorMessage("Hold expired, choose another time.");
  }, []);

  const handleConfigUnavailable = useCallback(() => {
    startLegacySquareCheckout(session.paymentSessionReference)
      .then((checkout) => {
        setFallbackUrl(checkout.checkoutUrl);
        window.location.assign(checkout.checkoutUrl);
      })
      .catch((error: unknown) => {
        if (error instanceof BookingHoldExpiredError) {
          handleExpired();
          return;
        }
        setErrorMessage(
          error instanceof Error
            ? error.message
            : "Failed to start checkout. Please try again.",
        );
      });
  }, [handleExpired, session.paymentSessionReference]);

  return (
    <section className="flex flex-col gap-8 lg:flex-row">
      <section className="min-w-0 flex-1 rounded-xl border border-lh-line bg-white p-6">
        <Link
          href={`/services/${session.serviceSlug}/booking`}
          className="mb-6 inline-flex text-lh-muted hover:text-black"
        >
          ← Back to details
        </Link>
        <p className="eyebrow-label mb-2">Secure payment</p>
        <h1 className="section-heading mb-4">Save your card to confirm</h1>
        <p className="mb-6 text-sm font-bold leading-6 text-lh-muted">
          Your card is stored for no-show protection. No payment is taken today.
        </p>
        {isExpired ? (
          <div className="rounded-[18px] border border-lh-line bg-lh-neutral-2 p-5 text-center">
            <p className="mb-4 font-heading text-lg uppercase tracking-[0.12em] text-lh-accent">
              Hold expired, choose another time
            </p>
            <Button asChild variant="outline">
              <Link href={`/services/${session.serviceSlug}/booking`}>
                Choose another time
              </Link>
            </Button>
          </div>
        ) : (
          <SquareCardOnFileForm
            cardholderName={session.customerName}
            maxChargeCents={session.totalCents}
            paymentSessionReference={session.paymentSessionReference}
            onSuccess={handleSuccess}
            onError={handleError}
            onHoldExpired={handleExpired}
            onConfigUnavailable={handleConfigUnavailable}
          />
        )}
        {errorMessage && (
          <p
            role="alert"
            className="mt-4 text-center text-sm font-medium text-red-600"
          >
            {errorMessage}
          </p>
        )}
        {fallbackUrl && (
          <Button asChild type="button" variant="dark" className="mt-4 w-full">
            <a href={fallbackUrl}>Continue to secure Square checkout</a>
          </Button>
        )}
      </section>
      <aside className="w-full shrink-0 lg:w-80">
        <section className="sticky top-24 rounded-xl border border-lh-line bg-white p-6">
          <h2 className="section-subheading mb-4 text-xl md:text-xl lg:text-xl">
            Summary
          </h2>
          <div className="space-y-4">
            <div className="flex justify-between text-sm">
              <span className="font-medium text-black">
                {session.serviceTitle}
              </span>
              <span className="text-black">
                {formatCad(session.totalCents / 100)}
              </span>
            </div>
            <div className="border-t border-lh-line pt-4">
              <p className="mb-1 text-sm font-medium text-black">
                Selected Time
              </p>
              <p className="text-sm text-lh-muted">
                {new Intl.DateTimeFormat("en-US", {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                  timeZone: session.timezone,
                }).format(new Date(session.selectedStart))}
              </p>
            </div>
            <div className="border-t border-lh-line pt-4">
              <div className="flex justify-between font-medium text-black">
                <span>Total</span>
                <span>{formatCad(session.totalCents / 100)}</span>
              </div>
            </div>
          </div>
        </section>
      </aside>
    </section>
  );
}
```

- [ ] **Step 8: Export fallback helper from Square form or move it**

If `startLegacySquareCheckout` remains in `booking-flow.tsx`, move it to `square-card-on-file-form.tsx` or a new shared `src/components/booking/service-booking-payment-client.ts` so `service-booking-payment-shell.tsx` imports from a file without pulling in `BookingFlow`. Use this exact shared signature:

```ts
export async function startLegacySquareCheckout(
  paymentSessionReference: string,
  fetcher: typeof fetch = fetch,
): Promise<PaidServiceCheckoutResult> {
  const checkoutRes = await fetcher("/api/booking/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paymentSessionReference }),
  });
  // keep existing response validation and BookingHoldExpiredError handling
}
```

- [ ] **Step 9: Run focused tests**

Run: `npx tsx --test src/components/booking/booking-flow.test.ts`

Expected: PASS.

Run: `npm run lint`

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/components/booking/square-card-on-file-form.tsx src/components/booking/service-booking-payment-shell.tsx src/components/booking/booking-flow.test.ts
git commit -m "fix: stabilize Square card container"
```

---

### Task 6: Confirm card-on-file bookings by payment session reference

**Files:**

- Modify: `src/lib/booking/payments/service-card-on-file.ts`
- Modify: `src/lib/private-db/card-on-file-repository.ts`
- Modify: `src/app/api/booking/card-on-file/route.ts`
- Modify: `src/app/api/booking/card-on-file/route.test.ts`
- Modify: `src/lib/booking/payments/service-card-on-file.test.ts`

- [ ] **Step 1: Write failing API test for session reference**

In `src/app/api/booking/card-on-file/route.test.ts`, add a test that posts `paymentSessionReference` without `holdReference`:

```ts
test("card-on-file confirmation accepts payment session references", async () => {
  let capturedInput: CardOnFileBookingRequestBody | undefined;
  const handler = createCardOnFilePostHandler({
    alerts: createNoopAlerts(),
    runCardOnFileBooking: async (input) => {
      capturedInput = input;
      return {
        ok: true,
        bookingStatus: "booked",
        card: { brand: "VISA", last4: "4242" },
        holdReference: "hold_public_1",
        noShowChargeStatus: "ready",
      };
    },
  });

  const response = await handler(
    new Request("http://localhost/api/booking/card-on-file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paymentSessionReference: "pay_sess_1",
        cardholderName: "Client Name",
        idempotencyKey: "idem-1",
        sourceId: "cnon:token",
        policy: { accepted: true, maxChargeCents: 13000 },
      }),
    }) as unknown as NextRequest,
  );

  assert.equal(response.status, 200);
  assert.equal(capturedInput?.paymentSessionReference, "pay_sess_1");
  assert.equal(capturedInput?.holdReference, undefined);
});
```

- [ ] **Step 2: Run card-on-file route test and verify failure**

Run: `npx tsx --test src/app/api/booking/card-on-file/route.test.ts`

Expected: FAIL because `paymentSessionReference` is not accepted.

- [ ] **Step 3: Update service request type**

In `src/lib/booking/payments/service-card-on-file.ts`, change `CardOnFileBookingRequestBody` to:

```ts
export interface CardOnFileBookingRequestBody {
  cardholderName: string;
  holdReference?: string;
  paymentSessionReference?: string;
  idempotencyKey: string;
  ipAddress?: string;
  policy: {
    accepted: true;
    maxChargeCents: number;
  };
  sourceId: string;
  userAgent?: string;
  verificationToken?: string;
}
```

Change `CardOnFileRepository.beginCardOnFileConfirmation` input to:

```ts
  beginCardOnFileConfirmation(input: {
    publicReference?: string;
    paymentSessionReference?: string;
    idempotencyKey: string;
    now: Date;
  }): Promise<BeginCardOnFileConfirmationResult>;
```

- [ ] **Step 4: Resolve hold by session in repository**

In `src/lib/private-db/card-on-file-repository.ts`, replace the `where(eq(appointmentHolds.publicReference, input.publicReference))` clause with:

```ts
          .where(
            input.paymentSessionReference !== undefined
              ? eq(appointmentHolds.paymentSessionReference, input.paymentSessionReference)
              : eq(appointmentHolds.publicReference, input.publicReference ?? ""),
          )
```

- [ ] **Step 5: Call begin confirmation with session**

In `confirmCardOnFileBooking`, replace the existing begin call input with:

```ts
      publicReference: input.holdReference,
      paymentSessionReference: input.paymentSessionReference,
      idempotencyKey: input.idempotencyKey,
      now,
```

Before that call, validate that exactly one reference exists:

```ts
if (
  (input.holdReference === undefined) ===
  (input.paymentSessionReference === undefined)
) {
  return {
    ok: false,
    error: "invalid_request",
    message: "A valid booking payment session is required",
  };
}
```

- [ ] **Step 6: Parse session in API route**

In `src/app/api/booking/card-on-file/route.ts`, parse:

```ts
const holdReference = parseOptionalString(body.holdReference);
const paymentSessionReference = parseOptionalString(
  body.paymentSessionReference,
);
```

Replace required-reference validation with:

```ts
    (holdReference === null && paymentSessionReference === null) ||
    (holdReference !== null && paymentSessionReference !== null) ||
```

Return:

```ts
    ...(holdReference !== null ? { holdReference } : {}),
    ...(paymentSessionReference !== null ? { paymentSessionReference } : {}),
```

- [ ] **Step 7: Update service tests**

In `src/lib/booking/payments/service-card-on-file.test.ts`, add a test where request input uses:

```ts
paymentSessionReference: "pay_sess_1",
```

and fake repository `beginCardOnFileConfirmation` asserts:

```ts
assert.equal(input.paymentSessionReference, "pay_sess_1");
assert.equal(input.publicReference, undefined);
```

- [ ] **Step 8: Run focused tests**

Run: `npx tsx --test src/app/api/booking/card-on-file/route.test.ts src/lib/booking/payments/service-card-on-file.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/booking/payments/service-card-on-file.ts src/lib/private-db/card-on-file-repository.ts src/app/api/booking/card-on-file/route.ts src/app/api/booking/card-on-file/route.test.ts src/lib/booking/payments/service-card-on-file.test.ts
git commit -m "feat: confirm card on file by payment session"
```

---

### Task 7: Start legacy Square checkout fallback by payment session reference

**Files:**

- Modify: `src/app/api/booking/checkout/route.ts`
- Modify: `src/app/api/booking/checkout/route.test.ts`
- Modify: shared client fallback helper from Task 5

- [ ] **Step 1: Write failing fallback route test**

In `src/app/api/booking/checkout/route.test.ts`, add:

```ts
test("booking checkout starts from payment session reference", async () => {
  const hold = createHold({ paymentSessionReference: "pay_sess_1" });
  const handler = createBookingCheckoutPostHandler({
    createSquareServiceBookingCheckout: async ({ hold: inputHold }) => ({
      checkoutUrl: "https://square.link/u/test",
      holdReference: inputHold.publicReference,
      orderId: "lh-sq-test",
      paymentProvider: "square",
      reused: false,
      squarePaymentLinkId: "plink_test",
    }),
    getAppointmentHoldByPublicReference: async () => null,
    getAppointmentHoldByPaymentSessionReference: async (reference) => {
      assert.equal(reference, "pay_sess_1");
      return hold;
    },
    releaseHeldAppointmentHold: async () => null,
  });

  const response = await handler(
    new Request("http://localhost/api/booking/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentSessionReference: "pay_sess_1" }),
    }) as unknown as NextRequest,
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.checkoutUrl, "https://square.link/u/test");
});
```

- [ ] **Step 2: Run checkout route test and verify failure**

Run: `npx tsx --test src/app/api/booking/checkout/route.test.ts`

Expected: FAIL because dependencies and parser do not accept payment session references.

- [ ] **Step 3: Update route dependencies and parser**

In `src/app/api/booking/checkout/route.ts`, change request body interface:

```ts
interface BookingCheckoutRequestBody {
  holdReference?: string;
  paymentSessionReference?: string;
}
```

Add dependency:

```ts
getAppointmentHoldByPaymentSessionReference: (
  paymentSessionReference: string,
) => Promise<BookingHoldRecord | null>;
```

Change lookup:

```ts
hold =
  checkoutRequest.paymentSessionReference !== undefined
    ? await dependencies.getAppointmentHoldByPaymentSessionReference(
        checkoutRequest.paymentSessionReference,
      )
    : await dependencies.getAppointmentHoldByPublicReference(
        checkoutRequest.holdReference ?? "",
      );
```

Change default dependencies:

```ts
    getAppointmentHoldByPaymentSessionReference: holdsModule.getAppointmentHoldByPaymentSessionReference,
```

Change parser:

```ts
const holdReference = parseOptionalString(body.holdReference);
const paymentSessionReference = parseOptionalString(
  body.paymentSessionReference,
);

if ((holdReference === null) === (paymentSessionReference === null)) {
  return null;
}

return {
  ...(holdReference !== null ? { holdReference } : {}),
  ...(paymentSessionReference !== null ? { paymentSessionReference } : {}),
};
```

Add helper:

```ts
function parseOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmedValue = value.trim();
  return trimmedValue.length > 0 ? trimmedValue : null;
}
```

- [ ] **Step 4: Run checkout tests**

Run: `npx tsx --test src/app/api/booking/checkout/route.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/booking/checkout/route.ts src/app/api/booking/checkout/route.test.ts
git commit -m "feat: start Square fallback from payment session"
```

---

### Task 8: Trace and document availability route DEP0169 warning

**Files:**

- Create: `docs/superpowers/reports/2026-07-01-availability-deprecation-trace.md`
- Modify only if app-owned deprecated parsing is found: exact source file containing `url.parse()`

- [ ] **Step 1: Search for app-owned deprecated URL parsing**

Run: `rg "url\.parse|from ['\"]url['\"]|require\(['\"]url['\"]\)" src tests scripts next.config.ts`

Expected: No app-owned `url.parse()` use in `/api/booking/availability` path. If a match appears, replace that exact parsing with `new URL(...)` and add a focused test for the file.

- [ ] **Step 2: Run availability tests with trace deprecation**

Run: `NODE_OPTIONS=--trace-deprecation npx tsx --test src/app/api/booking/availability/route.test.ts`

Expected: Tests pass. If DEP0169 stack appears, capture the stack in the report and identify whether the top app-owned frame exists.

- [ ] **Step 3: Create trace report**

Create `docs/superpowers/reports/2026-07-01-availability-deprecation-trace.md`:

```md
# Availability Route DEP0169 Trace

## Commands

- `rg "url\.parse|from ['\"]url['\"]|require\(['\"]url['\"]\)" src tests scripts next.config.ts`
- `NODE_OPTIONS=--trace-deprecation npx tsx --test src/app/api/booking/availability/route.test.ts`

## Finding

`src/app/api/booking/availability/route.ts` parses request URLs with `new URL(req.url).searchParams`, not deprecated `url.parse()`.

## Source

Document the trace result here as either:

- `No DEP0169 trace reproduced during focused route tests`, or
- `DEP0169 originates from <package/file stack>, outside app-owned booking availability code`.

## Remediation

No application code change is needed unless an app-owned `url.parse()` stack frame is found. Existing availability route behavior remains unchanged.
```

- [ ] **Step 4: Run availability tests**

Run: `npx tsx --test src/app/api/booking/availability/route.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/reports/2026-07-01-availability-deprecation-trace.md
git commit -m "docs: trace availability URL deprecation warning"
```

---

### Task 9: Add focused browser coverage for dedicated payment page

**Files:**

- Create: `tests/service-booking-payment-page.spec.ts`
- Modify if needed: existing Playwright mocks in `tests/booking-card-on-file-config.spec.ts`

- [ ] **Step 1: Add Playwright test for payment URL and Square container**

Create `tests/service-booking-payment-page.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

test("service booking redirects to dedicated payment page and mounts Square container", async ({
  page,
}) => {
  await page.route("**/api/booking/availability?**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        slots: [
          {
            start: "2030-07-01T23:00:00.000Z",
            end: "2030-07-02T00:30:00.000Z",
          },
        ],
      }),
    });
  });

  await page.route("**/api/booking/holds", async (route) => {
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        hold: {
          paymentSessionReference: "pay_sess_browser_1",
          paymentPageUrl:
            "/services/lash-fill/booking/payment?session=pay_sess_browser_1",
          expiresAt: "2030-07-01T23:10:00.000Z",
          start: "2030-07-01T23:00:00.000Z",
          end: "2030-07-02T00:30:00.000Z",
          service: { slug: "lash-fill", title: "Lash Fill" },
        },
      }),
    });
  });

  await page.addInitScript(() => {
    window.Square = {
      payments: async () => ({
        card: async () => ({
          attach: async (selector: string) => {
            if (document.querySelector(selector) === null) {
              throw new Error(`Missing ${selector}`);
            }
          },
          destroy: () => {},
          tokenize: async () => ({
            status: "OK",
            token: "cnon:test",
            verificationToken: "verf:test",
          }),
        }),
      }),
    } as typeof window.Square;
  });

  await page.goto("/services/lash-fill/booking");
  await page
    .getByRole("button", { name: /7:00 PM|Select/i })
    .first()
    .click();
  await page.getByRole("button", { name: /Continue/i }).click();
  await page.getByLabel(/Full Name/i).fill("Dardan Demiri");
  await page.getByLabel(/Email Address/i).fill("dardemiri@gmail.com");
  await page.getByLabel(/Phone Number/i).fill("2498771704");
  await page
    .getByRole("button", { name: /Continue to secure Square checkout/i })
    .click();

  await expect(page).toHaveURL(
    /\/services\/lash-fill\/booking\/payment\?session=pay_sess_browser_1/,
  );
  await expect(page.locator("[id^='square-card-container']")).toBeVisible();
  await expect(
    page.getByText(/The element #square-card-container was not found/i),
  ).toHaveCount(0);
});
```

- [ ] **Step 2: Run the browser test and verify failures are actionable**

Run: `npx playwright test tests/service-booking-payment-page.spec.ts --project=chromium`

Expected before implementation is fully wired: FAIL at route/page lookup or selectors. After prior tasks: PASS. If selectors differ from rendered service data, adjust selectors to existing accessible labels without weakening the URL/container assertions.

- [ ] **Step 3: Run focused browser test after adjustments**

Run: `npx playwright test tests/service-booking-payment-page.spec.ts --project=chromium`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/service-booking-payment-page.spec.ts
git commit -m "test: cover service booking payment page"
```

---

### Task 10: Final verification and review

**Files:**

- Review all changed files.

- [ ] **Step 1: Run focused unit tests**

Run:

```bash
npx tsx --test \
  src/lib/private-db/schema.test.ts \
  src/lib/booking/holds.test.ts \
  src/app/api/booking/holds/route.test.ts \
  src/lib/booking/payment-session.test.ts \
  src/components/booking/booking-flow.test.ts \
  src/app/api/booking/card-on-file/route.test.ts \
  src/lib/booking/payments/service-card-on-file.test.ts \
  src/app/api/booking/checkout/route.test.ts \
  src/app/api/booking/availability/route.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run lint**

Run: `npm run lint`

Expected: PASS.

- [ ] **Step 3: Run focused Playwright test**

Run: `npx playwright test tests/service-booking-payment-page.spec.ts --project=chromium`

Expected: PASS.

- [ ] **Step 4: Run build**

Run: `npm run build`

Expected: PASS. If `scripts/validate-sanity-env.mjs` fails due to missing local environment variables, record the exact output and run all other verification commands successfully.

- [ ] **Step 5: Inspect git diff**

Run: `git diff --stat && git diff --check`

Expected: files match this plan; `git diff --check` reports no whitespace errors.

- [ ] **Step 6: Request final code review**

Use the code-reviewer quality gate with this focus:

```text
Review the dedicated service booking payment page changes for: payment token/PII leakage, Square iframe attach lifecycle, session/hold expiry handling, fallback checkout behavior, route validation, and test coverage.
```

- [ ] **Step 7: Commit final verification notes if a report changed**

```bash
git add docs/superpowers/reports/2026-07-01-availability-deprecation-trace.md
git commit -m "docs: record payment page verification notes"
```

Only run this commit if the report changed after Task 8.

---

## Self-Review

- Spec coverage: the plan covers dedicated payment route, opaque session handoff, stable Square container, session-based card-on-file confirmation, legacy fallback, expiration/retry behavior, availability warning trace, and tests.
- Placeholder scan: no unresolved marker text or unspecified implementation steps remain.
- Type consistency: plan uses `paymentSessionReference` consistently in schema, hold records, APIs, client form props, and fallback checkout.
