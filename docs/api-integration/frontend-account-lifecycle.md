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
| Lifecycle recovery | Bounded awaited claims, exact-body delivery, receipt binding, persisted dispositions, export assembly and expiry cleanup | `recovery`; fixed production transport wiring follows the P2-04 package |

`GET /api/account`, customer export retrieval and `/account` rendering are read-only. Exports require the current authenticated customer UUID. No command or delivery receipt includes exported bytes, bearer URLs or provider error text. Direct store and worker mutations require the lifecycle admission context; unadmitted calls refuse.

The coordinator-generated writer inventory includes all added routes and source modules. This table records source coverage, not historical deployment/provider fencing or live qualification.

## State, replay and recovery

Customer-row locking serializes commands, session revocation and preferences with Auth.js session creation. Export/delete require a database session created within 15 minutes. Sign out and complete a new verified sign-in to renew that proof; session reads never renew it. Admin commands require the existing five-minute Google authentication proof and reject developer-mode identities.

Each command increments `accountVersion` once. UUID idempotency keys are scoped to the customer; exact replay returns the original command before terminal-state conflict, while action reuse conflicts. Both receivers receive every action including export. A receiver's next command remains ineligible until all predecessors for that receiver acknowledge. Claims have fenced 90-second leases; interrupted delivery replays the exact command, never a newly allocated sequence. Retryable receiver failures use bounded backoff; rejected deliveries block following commands and require deliberate reconciliation.

Suspend/delete revoke all frontend sessions in the state transaction. Restore leaves frontend status suspended until both receivers acknowledge the latest ordered restore and all its predecessors. A stale claim cannot settle another lease or reopen a later suspension/deletion. A database trigger prevents restoring/deleting a terminal tombstone or adding profile PII to it. Another trigger prevents mutation/deletion of command history.

Exports capture only UUID-owned frontend records and assemble with validated Course/Community snapshots after both command acknowledgments. The frontend expiry is the earliest receiver expiry or 24 hours after assembly. Replay never replaces bytes or extends expiry. Expired ready bytes and pending snapshots older than 24 hours are scrubbed in bounded batches. Deletion removes all frontend export bytes immediately, removes provider links/sessions/email proofs/preferences and pseudonymizes the profile; it retains the immutable UUID and minimal command/delivery references.

## Verification and outstanding work

Seven focused policy/HTTP tests pass for closed bodies, privilege denial, CSRF, bounded input, safe errors, UUID binding and private download headers. Disposable PostgreSQL 16 qualification passed all 83 migrations and six lifecycle database cases covering concurrent idempotency, rollback, session revocation, ordered restore, stale acknowledgments, lease expiry/replay, outage sequencing, export isolation/expiry and terminal deletion guards. The same run passed seven real Auth.js identity cases, 12 interactive admission checks and 10 worker admission checks. Providers were synthetic/intercepted; no live accounts or databases were changed.

P2-11 remains in progress until the typed production recovery transport, downstream receivers and deployment/scheduling are integrated and certified. P2-00 still requires whole-release and historical/provider fencing evidence. P2-12/G2 require actual staging evidence; these local checks do not establish either gate.
