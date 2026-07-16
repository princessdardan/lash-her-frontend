# Booking Operations Dashboard Recovery and Readiness Review

**Status:** Recovered and locally verified; production enablement gates remain
**Review date:** 2026-07-15
**Recovery branch:** `codex/booking-operations-dashboard-recovery`
**Original empty branch:** `codex/booking-operations-dashboard`
**Base branch:** `staging`
**Reviewed scope:** All discovered booking-system changes for multi-employee and contractor support, including provider-specific services, resources, schedules, calendars, reservations, appointments, Square payments and attribution, Auth.js administration, analytics, migrations, and tests.

## Recovery disposition

The implementation was transferred into a fresh worktree with preserved
provenance and migration checksums. The P1/P2 code findings in this review were
remediated: capture leases and immutable provider intents close the Square
boundary; authorized-provider completion is reconciled; staff assignment and
Square attribution mutations serialize correctly; no-show analytics use the
terminal charged attempt; owner/employee OAuth completion shares duplicate and
token-cleanup behavior; offering-resource administration is owner-only and
snapshot-safe; and the source/DB test runner is reproducible.

Local verification passes TypeScript, lint with baseline warnings only, 1,415
DB-disabled/script tests, 99 serial DB tests, all 23 migrations on a new
database, the production webpack build with React Compiler enabled, and 10
Chromium booking/payment smokes. Three live Auth.js/Google Calendar cases are
explicitly gated. Shared-database inspection, an approved staging-clone
migration, live Google fixture completion, and Square sandbox certification are
still required before production enablement. The machine-readable record is
`docs/booking-operations-dashboard-verification.json`.

## Executive decision

Do not merge, deploy, or enable the V2 booking model from the current branch.

The implementation is recoverable with high confidence, but it was never committed to `codex/booking-operations-dashboard`. The branch and `staging` both point to commit `0818297805d6d95a669b3f78c7859d5464d5e1cf`. The registered `/private/tmp/lash-her-booking-operations-dashboard` worktree is prunable because its Git metadata no longer exists, and the surviving directory contains only part of the implementation.

A forensic reconstruction was assembled at `/private/tmp/lash-her-booking-stage0018.X863uT`. It contains the missing initial implementation, later Square attribution and employee calendar changes, and migrations `0018` through `0021`. This `/private/tmp` artifact is evidence and a recovery source, not a durable development worktree.

Recovery into a fresh worktree is preferred over a rewrite because:

- The recovered source is internally coherent and substantially complete.
- TypeScript and migration-contract checks pass.
- Drizzle reports no schema drift across 32 tables.
- A clean PostgreSQL database accepted the full 22-entry migration journal.
- All 90 tests in the seven database-bearing booking files pass when executed serially in the correct server-only environment.
- The architecture has sound foundations: PostgreSQL authority, immutable booking snapshots, resource reservations, exclusion constraints, provider-scoped calendar routing, durable payment attempts, Auth.js identity, database-backed authorization, and audit logging.

Recovery does not mean shipping the reconstructed code unchanged. The release-blocking findings below must be fixed and verified first.

## Artifact and provenance inventory

### Git state

| Item | State |
| --- | --- |
| `staging` | `0818297805d6d95a669b3f78c7859d5464d5e1cf` |
| `codex/booking-operations-dashboard` | Same commit as `staging`; no committed booking diff |
| Registered `/private/tmp` worktree | Prunable; Git directory is missing |
| Surviving incomplete directory | Approximately 123 TypeScript files |
| Reconstructed forensic tree | Approximately 520 TypeScript files |

No changes from the booking operations implementation are deliverable from the named branch in its current state.

### Recovery evidence

The first implementation session was located at:

`/Users/dardan/.codex/sessions/2026/07/10/rollout-2026-07-10T16-35-33-019f4dbe-2158-7ad2-8964-5be708eb0e06.jsonl`

Related July 10 subagent sessions contain the original patch events, migration-generation commands, focused test commands, and successful outputs. Later July session logs contain the Square Team attribution, employee calendar self-service, analytics, migration `0021`, and final verification work.

The recovered source was produced from:

1. A clean clone of `staging` at the original base commit.
2. Chronological replay of successful patch events from the session logs.
3. Regeneration of migrations at the exact recorded schema-generation points.
4. Reapplication of recorded manual SQL changes.
5. Overlay of surviving final files from `/private/tmp/lash-her-booking-operations-dashboard` where available.
6. Manual restoration of one later successful calendar-routing patch that was present in the logs but absent from the surviving directory.

### Recovered migration chain

The forensic tree contains:

- `drizzle/0018_grey_xorn.sql`
- `drizzle/0019_rainy_lorna_dane.sql`
- `drizzle/0020_eager_stark_industries.sql`
- `drizzle/0021_grey_professor_monster.sql`

`0018` includes the recorded manual changes:

- `CREATE EXTENSION IF NOT EXISTS "btree_gist"`
- A migration-safe `NOT VALID` V2 hold constraint
- The GiST exclusion constraint preventing overlapping active resource reservations

`0019` contains the calendar-assignment role and non-negative add-on duration checks. `0020` contains the booking model version check. `0021` contains Square provider mapping, attribution snapshots, enforcement settings, and calendar credential ownership.

The SQL is reconstructed from the recorded generation output and manual patch events. Snapshot identifiers for `0018` through `0020` were regenerated rather than recovered byte-for-byte. Their `prevId` chain is coherent, and `npm run db:generate` reports no pending schema changes. Preserve the migration filenames, order, SQL, and journal timestamps during recovery.

## Architecture assessment

The intended system has the correct major boundaries:

- **Identity and authorization:** Google OIDC through self-hosted Auth.js provides identity. PostgreSQL remains authoritative for role, account status, and employee resource access. Clerk is not part of the implementation.
- **Operational configuration:** Providers, services, offerings, add-ons, resources, schedules, exceptions, calendar connections, and calendar assignments are stored in PostgreSQL.
- **Public booking:** Availability and holds resolve a provider-specific offering and reserve every required resource, not only the primary provider.
- **Concurrency:** Resource IDs are locked in deterministic order and PostgreSQL exclusion constraints prevent overlapping active reservations.
- **Attribution:** Holds, appointments, payment attempts, and no-show records retain provider and Square Team attribution snapshots.
- **Calendar routing:** Each hold snapshots its write assignment and canonical Google calendar ID. Disabled historical assignments remain usable for already-paid bookings while new bookings use active assignments.
- **Payments:** V2 Square charge-and-store attempts persist authorization before capture and atomically project captured payment evidence with the authoritative appointment.
- **Compatibility:** V1 and V2 flows coexist behind a rollout mode, with direct booking creation remaining disabled.
- **Operations:** The dashboard includes owner/admin/employee roles, audit logging, readiness views, marketing operations, analytics, reconciliation, and retention controls.

The main architectural weakness is the boundary between an expiring resource reservation and an external Square payment operation. Database transactions cannot span Square, so the system needs an explicit durable capture lease and ambiguous-provider-outcome state machine. The current implementation does not fully close that boundary.

## Prioritized findings

### Release blocker: no committed implementation

The named feature branch contains no booking implementation. A PR or deployment created from it would be equivalent to `staging`.

**Required action:** Create a fresh worktree and recovery branch from `staging`, transfer the reconstructed changes, verify the complete diff, and commit it in reviewable units. Do not attempt to repair the prunable worktree in place.

### P1: reservation expiry can race Square capture

The V2 payment flow records an `authorized` Square attempt while leaving the hold in `held` state with its original expiration. The reservation cleanup considers `held`, `payment_pending`, and `paid_pending_booking` holds eligible for expiration based on `expiresAt`; it does not exclude an active payment lease or durable authorized attempt.

The failure sequence is:

```mermaid
sequenceDiagram
    participant Worker as Payment worker
    participant DB as PostgreSQL
    participant Square
    participant Other as Competing hold
    participant Monitor as Reconciliation monitor

    Worker->>DB: Claim hold and mark in-progress metadata
    Worker->>Square: CreatePayment (autocomplete false)
    Square-->>Worker: APPROVED
    Worker->>DB: Persist authorized attempt
    Note over DB: Hold remains held; expiry is unchanged
    Other->>DB: Expire old hold and release reservations
    Other->>DB: Reserve the same resources
    Worker->>Square: CompletePayment
    Square-->>Worker: COMPLETED
    Worker->>DB: Create appointment and captured attempt
    DB-->>Worker: Reject; reservations are no longer active
    Worker-->>Monitor: Authorized local attempt remains
    Note over Monitor: Existing orphan check scans captured attempts only
```

This can produce a captured customer payment without an appointment or owned resource reservation. The local attempt can remain `authorized`, so the existing `captured_payment_without_operational_appointment` monitor does not detect it.

**Required changes:**

- Introduce a durable capture lease or explicit `capture_in_progress` state.
- Acquire the lease and protect/extend all reservations atomically before the provider operation.
- Make reservation expiry explicitly exclude valid capture leases and authorized attempts.
- Revalidate the lease, hold, and reservation set immediately before capture.
- Persist provider-observed `COMPLETED` evidence even when appointment projection fails.
- Reconcile authorized local attempts whose Square state is `COMPLETED`.
- Add a deterministic two-transaction integration test for expiry between authorization and capture.

### P1: stable Square idempotency key is used with mutable request data

V2 derives the Square `CreatePayment` idempotency key solely from the hold ID, while `source_id` and `verification_token` come from the current browser submission. A re-tokenized retry can therefore use the same key with a different request body.

Square documents that retrying the same request with the same key returns the original result, while reusing the key with a changed request can return a previously-used-key error: <https://developer.squareup.com/docs/build-basics/common-api-patterns/idempotency>.

An ambiguous network failure before the provider payment ID is persisted can strand the booking: the application does not know the original payment ID, and the next request can provide a different source token behind the same key.

**Required changes:**

- Persist a durable provider-request intent before calling Square.
- Bind the intent to the immutable amount, currency, customer, reference, team member, and a safe request-body identity.
- Treat ambiguous `CreatePayment` outcomes as reconciliation work, not permission to submit a changed request under the old key.
- Before using a new source token/key, prove that the original provider operation did not create a payment.
- Add tests for connection loss after Square accepts `CreatePayment`, same-body retry, changed-source retry, webhook-before-response, and process restart.

Payment source tokens or raw card data must not be stored in PostgreSQL or logs while implementing this recovery design.

### P1: staff resource assignment guard is reversed

`assignStaffResource` checks whether the employee owns an active calendar assignment for the resource and rejects the operation with an error instructing the operator to disconnect it before **removing** the resource. `unassignStaffResource` performs no corresponding check.

This causes two defects:

- A valid assignment can be rejected when the calendar relationship already exists.
- Resource authorization can be removed while an employee-owned active calendar assignment still depends on it.

**Required changes:** Move the guard to `unassignStaffResource`, lock the employee/resource/assignment rows in the audited transaction, and add positive assignment and protected-removal tests.

### P1: Square attribution enforcement has a readiness race

Enabling `requireSquareTeamAttribution` reads active offering providers and their mapping readiness, then updates the singleton setting. The transaction does not lock the relevant offerings or providers. Concurrent mapping removal or offering activation can interleave with the readiness check and leave enforcement enabled while an active provider is unready.

Public V2 hold creation rechecks the requirement and mapping and therefore fails closed. The result is a booking outage rather than silent misattribution, but the invariant is still not atomic.

**Required changes:** Use a shared PostgreSQL advisory lock or serializable invariant across:

- Enforcement enable/disable
- Provider mapping set/remove/refresh
- Offering activation or provider reassignment

Add a database concurrency test that interleaves enforcement enablement with mapping removal and offering activation.

### P2: no-show analytics use the policy ceiling as charged revenue

The employee attribution query uses `booking_no_show_charge_records.max_charge_cents` for every record in `charged` state. This field is the maximum accepted policy amount. The actual attempt amount is stored in `booking_no_show_charge_attempts.amount_cents`.

Partial, adjusted, or retried no-show charges can therefore be overstated.

**Required changes:** Join the successful terminal attempt and aggregate its actual amount. Define behavior for multiple attempts, voided invoices, refunds, missing terminal attempts, and historical records without attempt rows. Add query-level DB tests rather than only testing the in-memory aggregator.

### P2: owner OAuth lacks duplicate-account and token cleanup parity

The employee OAuth path detects duplicate Google accounts, disables the provisional connection, reconnects an existing same-owner connection, rejects accounts owned elsewhere, and revokes rejected refresh tokens.

The owner path directly updates the provisional row. The unique `(provider, provider_account_id)` index catches duplicates, but the callback returns a generic error, leaves the provisional connection, and does not revoke the new refresh token.

**Required changes:** Share one duplicate-resolution service between owner and employee flows. On rejected or failed persistence, disable the provisional row and revoke the newly issued token best-effort. Preserve explicit ownership-transfer rules and audit outcomes.

### P2: secondary resource support has no production write path

Runtime code reads `booking_service_offering_resources` to calculate readiness, availability, and required reservations. Production code does not create or update those relationships; only tests insert them.

The dashboard can create rooms and equipment but cannot associate them with an offering, so multi-resource conflict protection is not operationally configurable.

**Required changes:** Add owner-only audited mutations and UI for listing, assigning, requiring, and removing offering resources. Prevent removal while active holds or appointments depend on the relationship, or define snapshot-safe removal semantics. Keep V2 offerings requiring secondary resources inactive until this control exists.

### P2: the standard unit runner cannot reliably execute DB tests

`scripts/run-source-unit-tests.mjs` omits `calendar-connection-repository.db.test.ts` from its server-only set. With `TEST_DATABASE_URL` configured, `npm run test:unit` executes that file without `--conditions=react-server` and fails on the `server-only` import.

Database-bearing files also run concurrently despite sharing singleton business settings. This produces intermittent cross-file contamination. The successful historical and forensic DB runs used `--test-concurrency=1`.

**Required changes:**

- Maintain an explicit `DB_TEST_FILES` group.
- Execute it with `--conditions=react-server` and `--test-concurrency=1`.
- Include the calendar connection, appointment finalization, legacy import, public read, reservation, card-on-file, and reconciliation DB files.
- Fail if a file containing `TEST_DATABASE_URL` is not registered in the DB group.
- Keep DB-disabled general execution separate from the authoritative DB suite.

### P2 coverage gap: browser tests do not execute OAuth completion

The three calendar self-service Playwright scenarios are skipped unless employee and owner Auth.js storage states plus a live isolated Google Calendar fixture are supplied. The OAuth scenario intercepts the Google authorization page and then returns to an already-connected fixture. It does not execute:

- OAuth state consumption
- Actor/resource ownership validation
- Token exchange
- Verified Google identity lookup
- Duplicate account resolution
- Refresh-token persistence or revocation
- Callback redirect behavior

**Required changes:** Add callback-level route tests with dependency injection for Google OAuth/profile calls and browser tests against an isolated fixture. Keep live Google execution gated, but make the callback state machine deterministic and mandatory in CI.

## Recovery versus rewrite decision gate

Use recovery unless one of the following conditions is discovered during transfer:

- The reconstructed schema cannot be proven compatible with any database where migrations `0018` through `0021` were applied.
- A material source file cannot be traced to a successful session patch or surviving final file.
- The recovered implementation conflicts with changes made to `staging` after commit `0818297805d6d95a669b3f78c7859d5464d5e1cf`.
- Fixing the payment state machine would require replacing most of the recovered booking flow rather than a bounded redesign.

If none of those conditions applies, rewriting would discard extensive tested behavior and increase regression risk without improving provenance.

If a rewrite is selected, preserve these recovered contracts:

- PostgreSQL remains authoritative for roles and employee resource access.
- Sanity remains public/editorial only.
- Direct booking creation remains disabled.
- Every V2 hold snapshots provider, offering, resource set, calendar route, pricing, and Square attribution.
- Every required resource is reserved atomically.
- Existing V1 bookings remain readable and finalizable during staged cutover.
- External payment operations use durable idempotency and terminal-state protection.
- Calendar credentials remain encrypted and owned by an explicit admin user.
- Customer-facing identifiers must not expose provider, resource, calendar, payment, or internal database IDs.

## Recommended recovery plan

### Phase 0: preserve evidence

- Copy `/private/tmp/lash-her-booking-stage0018.X863uT` to a durable, access-controlled location before cleanup or restart.
- Preserve the relevant session JSONL files and generate checksums for the recovered migration SQL.
- Do not copy `.git`, `.next`, `node_modules`, database files, credentials, environment files, or `.recovery-report.json` into the application branch.
- Record whether migrations `0018` through `0021` have been applied to any shared or production-like database.

### Phase 1: create a real recovery branch

- Create a fresh worktree from the current `staging` commit.
- Use a new branch such as `codex/booking-operations-dashboard-recovery`.
- Transfer the recovered application, migration, test, documentation, and package changes.
- Compare the result against both the forensic tree and current `staging`.
- Inspect every overwritten file for unrelated staging changes.
- Run `git diff --check`, secret scans, and the Clerk prohibition scan before the first commit.

### Phase 2: establish a reproducible baseline

- Fix the source test runner before using its result as release evidence.
- Apply all migrations to a new disposable PostgreSQL database.
- Run `npm run db:generate` and require no schema drift.
- Run TypeScript and lint.
- Run DB-disabled source tests and script tests.
- Run every DB-bearing file serially with React server conditions.
- Produce a machine-readable verification record with exact commands and counts.

### Phase 3: close P1 defects

Implement and test, in order:

1. Reservation/capture lease and orphaned provider-capture reconciliation.
2. Durable Square request-intent and ambiguous `CreatePayment` recovery.
3. Correct staff resource unassignment invariant.
4. Atomic Square attribution enforcement readiness.

Do not enable V2 booking creation or attribution enforcement until this phase passes concurrency tests on PostgreSQL.

### Phase 4: close operational gaps

- Correct no-show analytics.
- Unify owner and employee OAuth duplicate handling.
- Add offering-resource administration.
- Verify calendar ownership transfer, disconnect, disabled assignment, and historical route behavior.
- Review cancellation, rescheduling, refund, and no-show controls against current operations requirements rather than relying on the original V1 boundary list.

### Phase 5: end-to-end readiness

- Run the production build using the supported deployment bundler.
- Investigate the previously observed Turbopack stall; a webpack success is useful evidence but does not by itself resolve a deployment-path stall.
- Run public availability, hold, payment, webhook, appointment, calendar, email, and reconciliation flows end to end.
- Run owner, admin, and employee authorization matrices.
- Run deterministic OAuth callback tests and the isolated Google fixture suite.
- Run a rollback rehearsal and verify that V1 compatibility remains intact.

### Phase 6: commit and review

Prefer bounded commits that make provenance and review easier:

1. Schema and migrations
2. Operational repositories and V1/V2 compatibility
3. Auth.js, RBAC, and audit infrastructure
4. Admin dashboard and calendar ownership
5. Square payment durability and Team attribution
6. Public booking integration
7. Tests, runbooks, and readiness evidence
8. P1/P2 remediation commits, if they are not folded into the relevant implementation commits

Each commit must pass the tests relevant to its scope. The final branch must pass the complete matrix below.

## Verification record

### Completed against the forensic reconstruction

| Check | Result |
| --- | --- |
| TypeScript `--noEmit` | Passed |
| Drizzle schema generation | 32 tables; no changes to generate |
| Migration contract tests | 7/7 passed |
| Clean PostgreSQL migration | All 22 journal entries applied |
| Required constraints | V2 version, calendar role, and reservation overlap constraints verified |
| Seven database-bearing booking files, serial | 90/90 passed |
| DB-disabled source suite | 1,403 passed; 72 skipped |
| Script tests | 19/19 passed |
| `git diff --check` | Passed |
| Production webpack build | Reported passed in prior session; not independently repeated during forensic review |
| Live browser fixture | Not executed during forensic review |

### Required on the recovered branch

- [ ] Branch contains the complete intended diff from `staging`.
- [ ] No secrets, OAuth tokens, payment source IDs, PII fixtures, or database files are committed.
- [ ] `npm run db:generate` reports no drift.
- [ ] Migrations apply to a new database and an approved staging clone.
- [ ] Migration rollback/forward procedure is documented where destructive rollback is not possible.
- [ ] TypeScript passes.
- [ ] Lint has no errors and no unexplained new warnings.
- [ ] DB-disabled unit and script suites pass.
- [ ] Registered DB suite passes serially with zero skips.
- [ ] Reservation/capture concurrency test passes.
- [ ] Ambiguous Square `CreatePayment` recovery tests pass.
- [ ] Attribution enforcement concurrency tests pass.
- [ ] Staff assign/unassign invariant tests pass.
- [ ] Owner and employee duplicate Google account tests pass.
- [ ] No-show analytics DB tests use actual charged attempts.
- [ ] Offering-resource dashboard tests pass.
- [ ] Production build passes through the deployment bundler.
- [ ] Protected admin routes redirect correctly for owner, admin, employee, disabled, and unassigned users.
- [ ] Public V1 and V2 booking smoke matrices pass.
- [ ] Google Calendar fixture tests pass, including callback completion.
- [ ] Square sandbox payment, webhook, recovery, cancellation, and refund-required scenarios pass.
- [ ] Reconciliation detects every provider-paid/local-incomplete state.
- [ ] Operations runbooks and environment documentation match the recovered implementation.

## Production enablement gates

V2 booking creation must remain disabled until:

- The capture/expiry and Square idempotency P1 findings are closed.
- The DB suite is reproducible through a documented command.
- Required provider, resource, schedule, and calendar readiness is verified.
- Reconciliation detects authorized-provider-completed mismatches.

Square Team attribution enforcement must remain disabled until:

- Every active offering provider has a verified unique active mapping.
- Enforcement and mapping mutations share an atomic concurrency control.
- Direct payments verify the captured `team_member_id` against the hold snapshot.
- Unattributed and mismatched provider payments produce actionable operations alerts.

Employee calendar self-service must remain unavailable in production until:

- Staff resource unassignment cannot orphan an active assignment.
- Owner and employee duplicate-account behavior is unified.
- Rejected OAuth grants are revoked best-effort.
- Ownership transfer and disconnect rules pass DB and callback-level tests.

Analytics must not be used for compensation, commissions, payroll, or financial accounting. The current feature is attribution-only, and the no-show amount defect must be fixed even for that limited use.

## Final readiness criteria

The booking operations dashboard is ready for merge only when:

1. The complete recovered or rewritten implementation exists on a real branch with reviewable commits.
2. Every P1 finding is fixed with a deterministic regression test.
3. Every accepted P2 item has either been fixed or documented with an owner, deadline, and operational mitigation.
4. The migration chain is preserved and verified against all relevant database states.
5. The standard verification commands reproduce the claimed results without hidden manual test selection.
6. Payment, reservation, calendar, authorization, and attribution invariants hold under concurrent execution.
7. V1 compatibility and rollback behavior are demonstrated before V2 rollout.
