# Frontend operation admission ledger

P2-00 component only. The ledger is implemented and rehearsed on disposable databases. The [product checkout adapter](frontend-writer-route-admission.md) and [training continuation](frontend-training-admission.md) are the first opt-in application entrypoints; other routes, server actions and workers remain unwired. There is no live installation CLI, application migration, startup bootstrap, historical-credential retirement or release-coordinator integration. Existing pending frontend SQL paths continue to refuse.

## Storage and authority

`ops/platform/frontend-admission.sql` is a separately owned bootstrap artifact for the `frontend_admission` schema. It does not alter the public application schema or Drizzle journal. A future reviewed bootstrap must select the exact environment/database/owner, install this artifact once in a transaction, insert the target binding and explicitly register qualified source/deployment producers. Initial new-work and recovery admission are both closed. Installing this artifact on a live database is not an authorized ad hoc migration path.

The owner controls policy, producer registration and reconciliation. Protocol-aware runtime logins receive schema USAGE and EXECUTE on the routines, with no direct table or DDL rights. Security-definer functions use a fixed search path and compare the physical `session_user` role OID with the registered producer. The ledger stores UUIDs, source/producer/target hashes, epochs, state and timestamps; it accepts no request bodies, customer identifiers or raw provider idempotency keys. Operation rows retain source and role identities from admission even if producer registration later changes.

Historical application logins have no admission privileges. That protects this schema only: they may still write application tables or use retained provider access. Neither a closed ledger nor a disabled producer proves historical deployments are fenced. Live adoption still needs exhaustive deployment/provider inventory, actual retirement of bypassing access and reconciliation of work admitted outside this protocol.

The next [database login retirement component](frontend-historical-login-retirement.md) implements selected-role NOLOGIN/session termination on owned databases. It has no live CLI and does not establish provider or whole-operation drain. Application-wide fencing, bootstrap and coordinator integration remain unfinished.

## Admission and operation lifetime

`runFrontendWriterOperation` accepts a dedicated connected PostgreSQL client, exact environment/target binding, a fresh operation UUID, admission epoch, producer/source identity and new-work or recovery class. It calls a procedure that commits the admission record before returning. PostgreSQL refuses the call inside an explicit outer transaction, so an uncommitted admission cannot start effects. Contention on the policy row refuses immediately. There are no automatic retries; an uncertain admission acknowledgement never starts the callback.

The callback receives `defer(work)`. Main work and all registered deferred work, including nested registrations, must finish before settlement. Register work before starting its side effects, and do not use untracked `after`, `waitUntil`, timers or detached promises. After settlement, new deferrals refuse. The client belongs to the ledger operation and must not be reused concurrently or for business transactions; lifecycle and TLS/target verification remain the integrating caller's responsibility.

A main/deferred error records `uncertain` after all registered work settles. A dead process/session leaves its durable operation `active`. Neither state expires. A failed/lost settlement acknowledgement returns a sanitized review-required error, without replaying the callback or settlement. Actual committed state is inspected before any deliberate recovery.

An operation UUID tracks one admitted execution; it does not replace business/provider idempotency keys. Integrations must preserve their existing capture, callback, outbox and reconciliation idempotency rules before attempting another execution under a new UUID.

## Policy and drain

Operator functions in `ops/platform/frontend-admission.mjs` use one dedicated physical connection per transaction. The caller owns environment serialization; nested transactions and connection pools used as query-only adapters are unsupported.

- `changeFrontendAdmission` compares the exact environment, target and current epoch under the policy row lock, then advances the epoch. New-work and recovery controls are independent. Closing a control does not cancel admitted work. Reopening either closed control refuses while any active or uncertain operation remains.
- `observeFrontendDrain` takes the same row lock and counts all active and uncertain operations. A ledger drain requires both controls closed and both counts zero. Old timestamps and elapsed request/lease limits cannot change the result.
- `reconcileFrontendOperation` requires both controls closed, the exact current epoch, an unresolved operation and a nonzero SHA-256 reference to retained reconciliation evidence. It marks only that operation complete. Runtime logins cannot perform this action. The operator must first inspect actual provider/database outcomes and account for any possible still-running process; a hash alone does not establish reconciliation.

Drain results are observations. They always report `historicalWritersFenced: false` and `migrationAuthorized: false`. They cannot be supplied as proof that non-protocol writers stopped, substitute for the 300-second bounded observation/reconciliation plan, or authorize SQL after releasing a lock. A later coordinator must retain its environment/database locks and independently qualify historical access, affected producers and deliberate restoration.

## Verification

The existing owned PostgreSQL migration fixture exercises the ledger in a separate disposable database, using a distinct NOLOGIN owner, protocol runtime login and historical runtime login. CI's owned PostgreSQL18 job runs these checks as part of the same fixture. Local PostgreSQL16 and PostgreSQL18 rehearsals also cover:

- closed bootstrap; role/table/owner/source/target/null-binding refusal;
- refusal inside an outer transaction and on policy-lock contention;
- new-work closure while recovery and already-admitted deferred work finish;
- zero active and uncertain operations before ledger drain;
- duplicate operation refusal, non-expiring uncertainty and deliberate owner reconciliation;
- actual backend termination, lost admission and completion acknowledgements;
- stale epochs, simultaneous policy changes and refusal to reopen unresolved work.

These tests qualify ledger behavior, not application-wide admission, whole-provider drain, historical-deployment fencing or a live bootstrap. P2-00 remains in progress until those integrations and the parent release/recovery path pass their required end-to-end fault tests.
