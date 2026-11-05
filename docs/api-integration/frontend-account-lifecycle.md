# Frontend account lifecycle

Source implementation remains disabled by default behind `CUSTOMER_ACCOUNT_LIFECYCLE_ENABLED=true`. This flag does not authorize deployment, recovery scheduling or customer access. Customer authentication additionally requires its existing flags and configuration.

The November 5 [approved policy](decisions/2026-11-05-p2-lifecycle-policy.md) governs this implementation. Migration `0082_customer_account_lifecycle` adds the per-customer safe-integer sequence, immutable commands, independently ordered Course/Community deliveries, private export snapshots and optional learning preferences. It keeps existing business and separate marketing retention unchanged. There is no email-based inference of legacy guest order, booking or marketing ownership.

## Operations and admission inventory

| Producer | Whole operation | Admission |
| --- | --- | --- |
| `POST /api/account/commands` | Active database session, fresh sign-in, closed request, customer-only export/delete, atomic state/session/command/two-delivery transaction | `new-work` |
| `POST /api/account/preferences` | Active session rechecked while holding the customer row lock; preferences persist without creating marketing consent | `new-work` |
| `POST /api/admin/customer-accounts/{userId}/commands` | Exact origin/JSON, canonical UUID, active owner, fresh real Google authentication, immutable requester identity and account transaction | `new-work` |
| Admin export retrieval | Active owner and fresh Google authentication, customer/command ownership, private attachment | `new-work` includes existing admin identity resolution |
| `GET /api/cron/account-lifecycle` | Independent disabled-default flag, bearer authentication, bounded awaited claims, exact-body delivery, receipt binding, persisted dispositions, export assembly and expiry cleanup | `recovery`; receiver-typed P2-04 clients and dedicated lifecycle signers |

`GET /api/account`, customer export retrieval and `/account` rendering are read-only. Exports require the current authenticated customer UUID. No command or delivery receipt includes exported bytes, bearer URLs or provider error text. Direct store and worker mutations require the lifecycle admission context; unadmitted calls refuse.

The coordinator-generated writer inventory includes all added routes and source modules. This table records source coverage, not historical deployment/provider fencing or live qualification.

## State, replay and recovery

Customer-row locking serializes commands, session revocation and preferences with Auth.js session creation. Export/delete require a database session created within 15 minutes. Sign out and complete a new verified sign-in to renew that proof; session reads never renew it. Admin commands require the existing five-minute Google authentication proof and reject developer-mode identities.

Each command increments `accountVersion` once. UUID idempotency keys are scoped to the customer; exact replay returns the original command before terminal-state conflict, while action reuse conflicts. Both receivers receive every action including export. A receiver's next command remains ineligible until all predecessors for that receiver acknowledge. Claims have fenced 90-second leases; interrupted delivery replays the exact command, never a newly allocated sequence. Retryable receiver failures use bounded backoff; rejected deliveries block following commands and require deliberate reconciliation.

Suspend/delete revoke all frontend sessions in the state transaction. Restore leaves frontend status suspended until both receivers acknowledge the latest ordered restore and all its predecessors. A stale claim cannot settle another lease or reopen a later suspension/deletion. A database trigger prevents restoring/deleting a terminal tombstone or adding profile PII to it. Another trigger prevents mutation/deletion of command history.

Exports capture only UUID-owned frontend records and assemble with validated Course/Community snapshots after both command acknowledgments. The frontend expiry is the earliest receiver expiry or 24 hours after assembly. Replay never replaces bytes or extends expiry. Expired ready bytes and pending snapshots older than 24 hours are scrubbed in bounded batches. Deletion removes all frontend export bytes immediately, removes provider links/sessions/email proofs/preferences and pseudonymizes the profile; it retains the immutable UUID and minimal command/delivery references.

## Verification and outstanding work

Seven focused policy/HTTP tests pass for closed bodies, privilege denial, CSRF, bounded input, safe errors, UUID binding and private download headers. Disposable PostgreSQL 16 qualification passed all 83 migrations and six lifecycle database cases covering concurrent idempotency, rollback, session revocation, ordered restore, stale acknowledgments, lease expiry/replay, outage sequencing, export isolation/expiry and terminal deletion guards. The same run passed seven real Auth.js identity cases, 12 interactive admission checks and 10 worker admission checks. Providers were synthetic/intercepted; no live accounts or databases were changed.

The typed production recovery transport is wired to both receivers using their distinct runtime schemas and dedicated signers. `CUSTOMER_ACCOUNT_LIFECYCLE_RECOVERY_ENABLED` independently enables the authenticated minute recovery endpoint; customer sign-in/commands may remain disabled while durable work recovers. Claims are bounded to 20, export assembly to 10, and new work within the run stops after a 60-second budget. All started transport/database work is awaited. Uncertain delivery remains attached to the enclosing admission operation and exact persisted retry command. Expired bytes are denied immediately and scrubbed on the next bounded recovery pass.

For a reviewed staging certification build, `LASH_P2_CERTIFICATION_SCHEDULES=account-lifecycle` selects only this recovery schedule, requires the exact staging project/Production target/source and recovery flag, and rejects production or native-qualification mixing. This does not enable the project's native scheduler. Ordinary schedules remain unchanged unless lifecycle recovery is explicitly enabled; production activation is outside this goal.

P2-11 remains in progress until downstream integration, required checks and deployment/scheduling are certified. P2-00 still requires whole-release and historical/provider fencing evidence. P2-12/G2 require actual staging evidence; these local checks do not establish either gate.

## Independent review corrections

Review reproduced lost local acknowledgment/export SQL receipts being caught as a retry, missing receiver rows satisfying negative readiness checks, and unbounded fresh-key export allocation. Recovery now lets local persistence failures escape its receiver-error catch and preserves uncertainty even if a caller handles the error. Expected domain refusals settle outside the admission callback; they do not fabricate uncertainty.

Command/delivery insertion, claim leases, state changes, session revocation, eligible PII removal and export writes require positive receipts and persisted-state checks. Restore requires both Course and Community acknowledgments for every predecessor; missing delivery rows block the corresponding receiver's later claim and cannot make an export ready. A lost lease is distinguished from an independently observed already-acknowledged delivery.

Exact replay precedes export allocation limits. Each account permits one pending export and at most one new export every 15 minutes; suspension/deletion remain available. Frontend snapshots include at most 100 recent minimal lifecycle commands, explicitly identified in their scope, rather than copying an unbounded full history for every request. Learning record exports retain their receiver-defined scope.

Three new lost-receipt/domain-denial unit regressions pass. The corrected integrated source `847f0b049731b6983c67747a633dca1f76d76399` passed all 16 real PostgreSQL 16 lifecycle cases, including the ten fault/quota cases, suppressed session deletion and eligible PII erasure. The [retained receipt](baselines/2026-11-05-p2-integrated-owned/validation.json) also records 83 migrations, ten identity tests and the actual route/admission fixtures. A separate actual three-repository lifecycle journey against Course `11ea33d` and Community `610a581` passed ten groups with zero findings, zero active operations and three deliberately uncertain operations retained for owner reconciliation. Later authentication receipt fixes have their own qualification. No deployed completion is claimed.
