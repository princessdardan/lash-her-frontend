# No-Show Admin Authorization & Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure manual no-show charge intent is staff-authorized, appointment-eligible, and durably auditable before any provider-side charge is attempted.

**Architecture:** Extend the no-show record and admin route with operator identity, reason, eligibility checks, and audit persistence. The admin route remains bearer-secret protected, but the request must also name an operator and prove the appointment has ended. Charge execution still depends on the charge lifecycle plan.

**Tech Stack:** Next.js App Router route handlers, TypeScript, Drizzle/PostgreSQL, Node `tsx --test`.

---

## Plan Set Position

This is **Plan 3 of 5** and depends on `2026-06-20-card-on-file-persistence-test-foundation.md`.

Production gate after this plan: staff no-show intent is auditable, but provider charge execution remains disabled until Plan 4 and Plan 5 are complete.

---

## Files

- Modify: `src/lib/private-db/schema.ts`
- Modify: `src/lib/private-db/schema.test.ts`
- Generate or create forward migration after the latest migration
- Modify: `src/lib/private-db/card-on-file-repository.ts`
- Modify: `src/lib/booking/payments/service-no-show-invoice.ts`
- Modify: `src/lib/booking/payments/service-no-show-invoice.test.ts`
- Modify: `src/app/api/admin/appointments/[id]/no-show/route.ts`
- Modify: `src/app/api/admin/appointments/[id]/no-show/route.test.ts`
- Modify: `docs/booking-system-runbook.md`

---

## Task 1: Add admin audit columns to no-show records

**Files:**

- Modify: `src/lib/private-db/schema.ts:549-588`
- Modify: `src/lib/private-db/schema.test.ts`
- Add generated migration

- [ ] **Step 1: Add schema test**

In `src/lib/private-db/schema.test.ts`, add:

```ts
test("no-show charge records expose admin audit fields", () => {
  assert.ok(bookingNoShowChargeRecords.adminActionAt);
  assert.ok(bookingNoShowChargeRecords.adminOperatorId);
  assert.ok(bookingNoShowChargeRecords.adminReason);
  assert.ok(bookingNoShowChargeRecords.adminEligibilityCheckedAt);
});
```

- [ ] **Step 2: Add schema fields**

In `bookingNoShowChargeRecords`, add:

```ts
adminOperatorId: text("admin_operator_id"),
adminReason: text("admin_reason"),
adminEligibilityCheckedAt: timestamp("admin_eligibility_checked_at", { withTimezone: true }),
```

Keep existing `adminActionAt`.

- [ ] **Step 3: Generate migration**

Run:

```bash
npm run db:generate
```

Expected: a forward migration adds `admin_operator_id`, `admin_reason`, and `admin_eligibility_checked_at` to `booking_no_show_charge_records`.

- [ ] **Step 4: Run schema tests**

Run:

```bash
npx tsx --test src/lib/private-db/schema.test.ts
```

Expected: PASS.

---

## Task 2: Require operator identity and ended appointment eligibility in admin route

**Files:**

- Modify: `src/app/api/admin/appointments/[id]/no-show/route.ts`
- Modify: `src/app/api/admin/appointments/[id]/no-show/route.test.ts`

- [ ] **Step 1: Add route validation tests**

Add tests to `route.test.ts`:

```ts
test("admin no-show route rejects missing operator identity", async () => {
  const handler = createAdminNoShowPostHandler(createNoShowRouteDeps());
  const response = await handler(makeNoShowRequest({ operatorId: undefined }));
  assert.equal(response.status, 400);
});

test("admin no-show route rejects appointments that have not ended", async () => {
  const deps = createNoShowRouteDeps({
    appointment: {
      ...bookedAppointmentFixture(),
      selectedEnd: new Date("2026-06-20T13:00:00Z"),
    },
    now: new Date("2026-06-20T12:00:00Z"),
  });
  const handler = createAdminNoShowPostHandler(deps);

  const response = await handler(
    makeNoShowRequest({ operatorId: "staff-nataliea" }),
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "Appointment is not eligible for no-show charge",
    code: "NO_SHOW_APPOINTMENT_NOT_ENDED",
  });
});
```

Use local test helpers if existing names differ.

- [ ] **Step 2: Extend request and dependency types**

In `route.ts`, change request body:

```ts
export interface AdminNoShowRequestBody {
  amountCents: number;
  confirmPolicyCharge: true;
  idempotencyKey: string;
  operatorId: string;
  reason: string;
}
```

Extend appointment lookup:

```ts
export interface BookedAppointmentWithNoShowRecord {
  appointmentId: string;
  chargeStatus: NoShowChargeStatus;
  hasSavedCard: boolean;
  holdId: string;
  maxChargeCents: number;
  noShowChargeRecordId: string;
  selectedEnd: Date;
}
```

Add `getNow: () => Date` to `AdminNoShowDependencies` and default it to `() => new Date()`.

- [ ] **Step 3: Validate operator and required reason**

Add constants:

```ts
const OPERATOR_ID_PATTERN = /^[a-zA-Z0-9._:@-]{2,120}$/;
```

Update `parseAdminNoShowRequestBody`:

```ts
const operatorId =
  typeof body.operatorId === "string" ? body.operatorId.trim() : "";
if (!OPERATOR_ID_PATTERN.test(operatorId)) {
  return null;
}

if (
  typeof body.reason !== "string" ||
  CONTROL_CHARACTER_PATTERN.test(body.reason) ||
  body.reason.trim().length === 0 ||
  body.reason.trim().length > NO_SHOW_REASON_MAX_LENGTH
) {
  return null;
}
```

Return `operatorId` and trimmed `reason`.

- [ ] **Step 4: Enforce ended appointment eligibility**

After loading appointment and before amount comparison:

```ts
if (appointment.selectedEnd.getTime() > dependencies.getNow().getTime()) {
  return Response.json(
    {
      error: "Appointment is not eligible for no-show charge",
      code: "NO_SHOW_APPOINTMENT_NOT_ENDED",
    },
    { status: 409 },
  );
}
```

Pass `operatorId` into the charge command:

```ts
operatorId: parsedBody.operatorId,
reason: parsedBody.reason,
```

- [ ] **Step 5: Load selectedEnd in default DB lookup**

In `defaultFindBookedAppointmentWithNoShowRecord`, select and return `appointmentHolds.selectedEnd`:

```ts
selectedEnd: appointmentHolds.selectedEnd,
```

Return it in the result object:

```ts
selectedEnd: row.selectedEnd,
```

- [ ] **Step 6: Run route tests**

Run:

```bash
npx tsx --test src/app/api/admin/appointments/no-show-route-proxy.test.ts src/app/api/admin/appointments/[id]/no-show/route.test.ts
```

Expected: PASS.

---

## Task 3: Persist admin no-show action before provider publish

**Files:**

- Modify: `src/lib/booking/payments/service-no-show-invoice.ts`
- Modify: `src/lib/private-db/card-on-file-repository.ts`
- Modify: `src/lib/booking/payments/service-no-show-invoice.test.ts`

- [ ] **Step 1: Add repository contract**

Extend `NoShowInvoiceRepository`:

```ts
recordNoShowAdminAction(input: {
  noShowChargeRecordId: string;
  operatorId: string;
  reason: string;
  now: Date;
}): Promise<void>;
```

- [ ] **Step 2: Add service test**

In `service-no-show-invoice.test.ts`, add:

```ts
test("chargeNoShowInvoice records admin action before Square publish", async () => {
  const fixture = createNoShowInvoiceFixture();

  await chargeNoShowInvoice(
    {
      amountCents: fixture.record.maxChargeCents,
      idempotencyKey: "admin-action-before-publish",
      noShowChargeRecordId: fixture.record.id,
      operatorId: "staff-nataliea",
      reason: "Client did not attend the appointment.",
    },
    fixture.dependencies,
  );

  assert.deepEqual(fixture.repository.adminActions[0], {
    noShowChargeRecordId: fixture.record.id,
    operatorId: "staff-nataliea",
    reason: "Client did not attend the appointment.",
    now: fixture.now,
  });
  assert.equal(fixture.squareInvoices.publishCalls.length, 1);
});
```

- [ ] **Step 3: Implement admin action persistence in service**

In `chargeNoShowInvoice`, after the amount check and before `claimNoShowChargeAttempt`, add:

```ts
if (input.operatorId === undefined || input.reason === undefined) {
  throw new NoShowInvoiceChargeError(
    "No-show admin operator and reason are required",
  );
}

await repository.recordNoShowAdminAction({
  noShowChargeRecordId: input.noShowChargeRecordId,
  operatorId: input.operatorId,
  reason: input.reason,
  now,
});
```

- [ ] **Step 4: Implement repository method**

In `card-on-file-repository.ts`, add:

```ts
async recordNoShowAdminAction(input) {
  await db
    .update(bookingNoShowChargeRecords)
    .set({
      adminActionAt: input.now,
      adminEligibilityCheckedAt: input.now,
      adminOperatorId: input.operatorId,
      adminReason: input.reason,
      updatedAt: input.now,
    })
    .where(eq(bookingNoShowChargeRecords.id, input.noShowChargeRecordId));
},
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
npx tsx --test src/lib/booking/payments/service-no-show-invoice.test.ts src/app/api/admin/appointments/no-show-route-proxy.test.ts
```

Expected: PASS.

---

## Task 4: Update staff runbook for no-show action evidence

**Files:**

- Modify: `docs/booking-system-runbook.md`

- [ ] **Step 1: Add admin evidence requirements**

Add this to the no-show charge procedure:

```md
Before submitting a no-show charge, staff must confirm the appointment end time has passed, enter their operator identifier, and record a concise reason. The system stores `admin_operator_id`, `admin_reason`, `admin_action_at`, and `admin_eligibility_checked_at` before calling Square. If any of these fields are missing, do not retry the charge; correct the admin request first.
```

- [ ] **Step 2: Run validation**

Run:

```bash
npm run lint
npm run test:unit
```

Expected: lint has no new errors and tests pass.

---

## Plan Self-Review Checklist

- Covers: no-show eligibility, required operator identity, required reason, durable audit fields, route validation, service persistence.
- Defers by design: provider publish retry/recovery, webhook financial validation, reconciliation checks, sandbox certification.
- No production no-show charge capture is authorized by this plan alone.
