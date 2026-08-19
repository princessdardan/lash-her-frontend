---
name: create-migration
description: Create a Drizzle migration the project-safe way — edit schema, generate, review, apply, and add reconciliation indexes. Use when adding or changing tables/columns in src/lib/private-db, or when the user says "create a migration" / "add a column" / "change the schema".
disable-model-invocation: true
---

# Create a Drizzle migration

Follow this exact order. Never hand-edit an already-committed `drizzle/NNNN_*.sql` — CI enforces migration-hash lineage and fails closed. Regenerate instead.

## Steps

1. **Edit the schema** — make the change in `src/lib/private-db/schema.ts` only. Use integer minor units for money, server-side timestamps, and explicit `on delete` behavior on foreign keys (restrict/retain for financial or audit rows).

2. **Generate the migration:**

   ```bash
   npm run db:generate
   ```

   This writes a new `drizzle/NNNN_*.sql` and updates `drizzle/meta/`. Review the generated SQL — confirm it matches intent and does nothing destructive you did not ask for.

3. **Review before applying** — invoke the `migration-reviewer` subagent (or review manually) for backward-compatibility, destructive ops, and index coverage. For expand/contract changes (new NOT NULL column, renames, drops), split into two migrations so running instances don't break.

4. **Reconciliation indexes** — if the change touches payment/reconciliation tables and adds a queried column or FK, add the index to `scripts/create-payment-reconciliation-indexes.ts` rather than only in the migration, and note whether it should run concurrently in production.

5. **Apply locally:**

   ```bash
   npm run db:migrate
   ```

   Runs against the current `DATABASE_URL`. Confirm it applies cleanly from the current state.

6. **Verify the CI gate locally** (optional but recommended before pushing) — CI runs a zero-to-latest migration plus a hash-divergence check. Run the unit + DB suite:
   ```bash
   npm run test:unit:all
   ```

## Guardrails

- Only `src/lib/private-db/schema.ts` is edited by hand; SQL is always generated.
- Private form/contact, payment, booking, and enrollment data lives in PostgreSQL — never migrate this kind of data into Sanity.
- Commit the generated `drizzle/NNNN_*.sql` **and** the `drizzle/meta/` snapshot together with the schema change.
