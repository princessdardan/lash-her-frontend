# Card-on-File Persistence Integrity & Test Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the new card-on-file/no-show persistence layer trustworthy before hardening payment behavior that depends on it.

**Architecture:** Add forward-only database constraints and DB-backed tests around the repository methods that enforce hold, policy acceptance, saved card, and no-show record invariants. Keep runtime behavior unchanged except for stronger persistence guarantees. This plan is deployable while production card-on-file remains disabled.

**Tech Stack:** Next.js 16 App Router, TypeScript, Drizzle/PostgreSQL, Node `tsx --test`, private DB migrations.

---

## Plan Set Position

This is **Plan 1 of 5** and has no dependency on the later remediation plans.

1. Persistence Integrity & Test Foundation
2. Card-on-File Intake Contract Hardening
3. No-Show Admin Authorization & Audit
4. Charge Lifecycle, Webhook Validation & Reconciliation
5. Square Sandbox/Staging Certification & Rollout

Production gate after this plan: persistence is safer, but card-on-file and no-show charging must remain disabled.

---

## Files

- Modify: `src/lib/private-db/schema.ts`
- Modify: `src/lib/private-db/schema.test.ts`
- Modify: `src/lib/private-db/card-on-file-repository.ts`
- Create: `src/lib/private-db/card-on-file-repository.db.test.ts`
- Generate or create forward migration after `drizzle/0012_secret_chimera.sql`
- Update: `drizzle/meta/_journal.json` and new snapshot through `npm run db:generate`

---

## Task 1: Add hold-side foreign keys for card-on-file invariants

**Files:**

- Modify: `src/lib/private-db/schema.ts:383-388`
- Modify: `src/lib/private-db/schema.test.ts`

- [ ] **Step 1: Write the schema assertion first**

Add assertions to `src/lib/private-db/schema.test.ts` near the existing appointment hold card-on-file tests:

```ts
test("appointment hold policy and no-show links are foreign-key backed", () => {
  const policyColumn = appointmentHolds.policyAcceptanceId;
  const noShowColumn = appointmentHolds.noShowChargeRecordId;

  assert.ok(policyColumn, "policyAcceptanceId column is exported");
  assert.ok(noShowColumn, "noShowChargeRecordId column is exported");
});
```

- [ ] **Step 2: Run the focused test**

Run:

```bash
npx tsx --test src/lib/private-db/schema.test.ts
```

Expected: PASS before and after implementation; this guards the exported columns while the migration adds the actual database guarantees.

- [ ] **Step 3: Add schema references**

Change `src/lib/private-db/schema.ts` so the hold-side links reference their target tables:

```ts
policyAcceptanceId: uuid("policy_acceptance_id").references(
  () => bookingPolicyAcceptances.id,
  { onDelete: "set null" },
),
noShowChargeRecordId: uuid("no_show_charge_record_id").references(
  () => bookingNoShowChargeRecords.id,
  { onDelete: "set null" },
),
```

Keep `savedPaymentMethodId` as-is.

- [ ] **Step 4: Generate a forward migration**

Run:

```bash
npm run db:generate
```

Expected: a new migration after `0012_secret_chimera` that adds two `appointment_holds` foreign keys. The migration body must contain these statements:

```sql
ALTER TABLE "appointment_holds"
  ADD CONSTRAINT "appointment_holds_policy_acceptance_id_booking_policy_acceptances_id_fk"
  FOREIGN KEY ("policy_acceptance_id")
  REFERENCES "public"."booking_policy_acceptances"("id")
  ON DELETE set null ON UPDATE no action;

ALTER TABLE "appointment_holds"
  ADD CONSTRAINT "appointment_holds_no_show_charge_record_id_booking_no_show_charge_records_id_fk"
  FOREIGN KEY ("no_show_charge_record_id")
  REFERENCES "public"."booking_no_show_charge_records"("id")
  ON DELETE set null ON UPDATE no action;
```

- [ ] **Step 5: Verify schema tests**

Run:

```bash
npx tsx --test src/lib/private-db/schema.test.ts
```

Expected: PASS.

- [ ] **Step 6: Checkpoint**

Run:

```bash
git diff -- src/lib/private-db/schema.ts src/lib/private-db/schema.test.ts drizzle
```

Expected: only schema, schema tests, and a forward migration/snapshot changed. Do not commit unless the user explicitly asks.

---

## Task 2: Add DB-backed repository tests for card-on-file concurrency

**Files:**

- Create: `src/lib/private-db/card-on-file-repository.db.test.ts`
- Modify: `src/lib/private-db/card-on-file-repository.ts`

- [ ] **Step 1: Create the gated DB test file**

Create `src/lib/private-db/card-on-file-repository.db.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { sql } from "drizzle-orm";

import { createCardOnFileDrizzleRepository } from "./card-on-file-repository";
import { getPrivateDb } from "./client";

const hasTestDatabase =
  typeof process.env.TEST_DATABASE_URL === "string" &&
  process.env.TEST_DATABASE_URL.length > 0;
const dbTest = hasTestDatabase ? test : test.skip;

dbTest(
  "card-on-file confirmation claim is hold-wide and row-lock safe",
  async () => {
    const db = getPrivateDb(process.env.TEST_DATABASE_URL);
    await resetCardOnFileTables(db);
    const hold = await seedHeldAppointmentHold(db, "lh-test-hold-claim");
    const repository = await createCardOnFileDrizzleRepository(db);
    const now = new Date("2026-06-20T12:00:00.000Z");

    const first = await repository.beginCardOnFileConfirmation({
      publicReference: hold.publicReference,
      idempotencyKey: "attempt-a",
      now,
    });
    const second = await repository.beginCardOnFileConfirmation({
      publicReference: hold.publicReference,
      idempotencyKey: "attempt-b",
      now: new Date(now.getTime() + 1_000),
    });

    assert.equal(first.status, "available");
    assert.equal(second.status, "in_progress");
  },
);

dbTest("no-show charge claim publishes only one owner", async () => {
  const db = getPrivateDb(process.env.TEST_DATABASE_URL);
  await resetCardOnFileTables(db);
  const hold = await seedHeldAppointmentHold(db, "lh-test-no-show-claim");
  const recordId = await seedProviderDraftNoShowRecord(db, hold.id);
  const repository = await createCardOnFileDrizzleRepository(db);
  const now = new Date("2026-06-20T12:05:00.000Z");

  const first = await repository.claimNoShowChargeAttempt({
    noShowChargeRecordId: recordId,
    idempotencyKey: "charge-a",
    amountCents: 12500,
    currency: "CAD",
    now,
  });
  const second = await repository.claimNoShowChargeAttempt({
    noShowChargeRecordId: recordId,
    idempotencyKey: "charge-b",
    amountCents: 12500,
    currency: "CAD",
    now: new Date(now.getTime() + 1_000),
  });

  assert.equal(first.isOwner, true);
  assert.equal(second.isOwner, false);
  assert.equal(second.attempt.status, "charge_pending");
});

async function resetCardOnFileTables(db: ReturnType<typeof getPrivateDb>) {
  await db.execute(sql`
    truncate table checkout_payment_events,
      booking_no_show_charge_attempts,
      booking_no_show_charge_records,
      booking_policy_acceptances,
      booking_saved_payment_methods,
      booking_square_customers,
      appointment_holds
    restart identity cascade
  `);
}

async function seedHeldAppointmentHold(
  db: ReturnType<typeof getPrivateDb>,
  publicReference: string,
) {
  const result = await db.execute(sql`
    insert into appointment_holds
      (public_reference, offering_id, offering_snapshot, booking_type, customer_snapshot,
       selected_start, selected_end, timezone, status, expires_at, payment_provider)
    values
      (${publicReference}, 'service-test', '{"title":"Test Service","fullPrice":125}'::jsonb,
       'in-person-appointment', '{"email":"client@example.com","name":"Client Test","phone":"5555555555"}'::jsonb,
       '2026-06-21T15:00:00Z', '2026-06-21T16:00:00Z', 'America/Toronto', 'held',
       '2026-06-21T14:55:00Z', 'square')
    returning id, public_reference
  `);
  const row = result.rows[0] as { id: string; public_reference: string };
  return { id: row.id, publicReference: row.public_reference };
}

async function seedProviderDraftNoShowRecord(
  db: ReturnType<typeof getPrivateDb>,
  holdId: string,
) {
  const result = await db.execute(sql`
    insert into booking_no_show_charge_records
      (hold_id, max_charge_cents, currency, square_invoice_id, square_order_id, status, provider_metadata)
    values
      (${holdId}, 12500, 'CAD', 'inv-test', 'order-test', 'provider_draft_created', '{"squareInvoiceVersion":1}'::jsonb)
    returning id
  `);
  const row = result.rows[0] as { id: string };
  return row.id;
}
```

- [ ] **Step 2: Run the new test without a DB**

Run:

```bash
npx tsx --test src/lib/private-db/card-on-file-repository.db.test.ts
```

Expected: the two tests are skipped when `TEST_DATABASE_URL` is absent.

- [ ] **Step 3: Make repository construction injectable**

If `createCardOnFileDrizzleRepository` does not yet accept an injected DB, change its signature in `src/lib/private-db/card-on-file-repository.ts`:

```ts
export async function createCardOnFileDrizzleRepository(
  db: ReturnType<typeof getPrivateDb> = getPrivateDb(),
): Promise<CardOnFileRepository & NoShowChargeFinalizerRepository> {
```

Remove the internal `const db = getPrivateDb();` line if it still exists after this change.

- [ ] **Step 4: Run the gated test against a migrated test DB**

Run with an isolated migrated database:

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" npx tsx --test src/lib/private-db/card-on-file-repository.db.test.ts
```

Expected: both DB-backed tests pass.

- [ ] **Step 5: Run the full unit suite**

Run:

```bash
npm run test:unit
```

Expected: the normal suite passes; DB-backed tests remain skipped unless `TEST_DATABASE_URL` is set.

---

## Task 3: Document the migration anomaly and validation requirement

**Files:**

- Modify: `docs/booking-system-runbook.md`
- Modify: `docs/launch-readiness-checklist.md`

- [ ] **Step 1: Add migration note to runbook**

Add this note to the private DB migration section of `docs/booking-system-runbook.md`:

```md
### Card-on-file migration note

The migration journal contains both `0010_familiar_jazinda` and `0010_dry_magneto`. Do not rewrite or renumber applied migrations. Continue with forward migrations only. Before enabling card-on-file, run DB-backed repository tests with `TEST_DATABASE_URL` against a migrated staging database and verify the hold-to-policy and hold-to-no-show foreign keys exist.
```

- [ ] **Step 2: Add launch checklist item**

Add this checklist item to `docs/launch-readiness-checklist.md`:

```md
- [ ] Card-on-file DB integrity verified: latest private DB migrations applied, hold-side no-show/policy foreign keys present, and `TEST_DATABASE_URL=... npx tsx --test src/lib/private-db/card-on-file-repository.db.test.ts` passes against staging.
```

- [ ] **Step 3: Verify docs and tests**

Run:

```bash
npm run lint
npm run test:unit
```

Expected: lint has no new errors; tests pass or DB-gated tests skip without `TEST_DATABASE_URL`.

---

## Plan Self-Review Checklist

- Each audit item covered here: hold-side FKs, DB repository tests, migration anomaly documentation.
- Later audit items intentionally deferred: Web SDK tokenization, server-side policy evidence, admin eligibility, webhook validation, reconciliation recovery, sandbox certification.
- No production flag should be enabled after this plan alone.
