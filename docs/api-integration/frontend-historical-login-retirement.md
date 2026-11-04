# Historical frontend database login retirement

P2-00 database-side component only. `ops/platform/frontend-historical-logins.mjs` is implemented and rehearsed on disposable PostgreSQL16/18 databases. It has no credential acquisition, live CLI, application startup hook or release entrypoint. Existing pending frontend SQL remains refused.

## Selected scope

The pure preparation function accepts a staging action/source, reviewed cluster-scope artifact hash, exact direct database target, protected operator/current-runtime/admission-owner roles, and an explicit list of historical login names and role OIDs. Unknown fields are excluded from receipts. Production, pooler targets, empty/duplicate lists, unsafe identifiers, protected roles and malformed bindings refuse. Preparation performs no database/provider calls and reads no environment credentials.

PostgreSQL roles are cluster-wide. A target database name does not narrow `ALTER ROLE` to that database. Before a live parent can use this component, its cluster-scope artifact must account for every database/branch and producer affected by the selected roles, including retained deployments, previews, manual scripts, callbacks and provider access. The hash binds that reviewed artifact; this component does not discover or validate its completeness.

The parent must qualify source and target, own the environment release lock, supply one dedicated idle physical PostgreSQL client with bounded statement/lock deadlines, hold the existing frontend migration advisory lock on that client, and provide a new private action directory with exclusive durable receipt writes. Query-only pool adapters and nested transactions are unsupported. The component verifies authenticated TLS, connection host/port, actual database/user/server version, physical backend identity and held lock. It neither acquires nor releases the parent's locks or connection.

## Execution and failure

1. Record exclusive intent before any database query. An existing/unavailable intent stops without appending a new outcome to that earlier action.
2. Verify every selected role's exact OID and LOGIN state. Refuse privileged/inheriting roles, membership relationships, owned objects anywhere in the cluster, or selected sessions in another database. Recheck role scope at the mutation transaction boundary. Do not change memberships, object ownership, grants or application data to make a refusal disappear.
3. Under the same physical lock, disable all selected logins in one transaction. Commit and re-read their actual attributes before recording the disabled-login receipt. A failed/lost commit acknowledgement stops here and leaves the actual state for inspection.
4. Refresh selected sessions and record their PID/role-OID/database/backend-start identities before sending signals. Refuse more than 256 selected sessions. Before each signal, recheck session identity/TLS/lock. Guard the termination query by all recorded identities so a recycled PID cannot select another backend.
5. Use `pg_terminate_backend(pid,1000)` and require its positive acknowledgement, or an observed session already absent. The positive timeout waits for actual termination rather than merely acknowledging a signal, as documented in [PostgreSQL's administration functions](https://www.postgresql.org/docs/16/functions-admin.html#FUNCTIONS-ADMIN-SIGNAL). A false/lost response stops without retry.
6. Independently recheck NOLOGIN, the held physical lock and zero currently observed selected sessions before recording success.

The ownership guard uses `pg_shdepend` ownership dependencies, covering objects in other databases even if there is no active session there; see [PostgreSQL's shared dependency catalog](https://www.postgresql.org/docs/16/catalog-pg-shdepend.html). Catalog visibility/permission errors refuse rather than silently omitting those checks.

Failures retain original receipts and disabled logins. The component never issues LOGIN, retries a role change/signal, reapplies SQL, closes the parent's connection or restores traffic. A reused/partially completed action is not a supported continuation. The later recovery coordinator must inspect actual role/session/provider outcomes and create a new deliberate recovery action. No fixed wait or empty activity snapshot establishes provider or whole-operation drain.

## Boundary to the admission ledger

NOLOGIN prevents fresh authentication; it does not end existing sessions. The fixture demonstrates that an old session remains usable after NOLOGIN commits and before explicit termination. Termination also rolls back an open database transaction. That rollback is not evidence that an earlier capture/email/provider mutation was undone. Any affected external work must remain uncertain until reconciled through its original business/provider idempotency keys.

Successful results report only selected logins disabled and zero currently observed selected sessions. They always retain `historicalWritersFenced: false`, `providerEffectsDrained: false` and `migrationAuthorized: false`. They are not exhaustive deployment inventory, authentication-in-flight fencing, provider-key retirement, operation-drain or migration-authorization evidence. Do not infer that all old deployment URLs are safe from one database observation.

The [durable ledger](frontend-admission-ledger.md) still needs application/worker wiring and a reviewed initial bootstrap. The parent must coordinate affected new-work/recovery controls, actual historical deployment/provider retirement, uncertainty reconciliation, migration/deployment under both locks and deliberate restoration. No live pending-SQL path is enabled by this component.

## Owned verification

The existing owned migration fixture runs the component against a separate disposable database, using generated local credentials. Tests cover wrong OIDs, memberships, ownership in the current and another database, cross-database sessions, new-login refusal with an existing session still alive, termination of idle/writing sessions, rollback of an open transaction, lost commit/termination acknowledgements, replay refusal and parent-lock retention. The ordinary platform tests also cover TLS/host/lock mismatch, unavailable intent receipts, transaction-boundary role drift and socket failure. No live role, provider or admission changes are made.
