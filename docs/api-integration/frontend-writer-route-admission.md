# Product checkout writer admission

P2-00 component only. `POST /api/checkout` now has an opt-in server-only adapter around its existing handler. It is the only application route wired in this change. Admission remains off unless explicitly set to `enforce`; no live settings, bootstrap, grants, deployments or provider configuration were changed. Existing pending frontend SQL release paths remain closed.

## Execution and uncertainty

In enforced mode the adapter validates the dedicated hosted environment, exact source/producer identity and direct PostgreSQL target, opens a dedicated verified-TLS connection, and verifies the actual database, login and server major. It reads the current admission epoch through `frontend_admission.current_policy`, whose security-definer lookup requires the registered physical login, enabled producer and exact source/target binding. A fresh request observes policy again rather than retaining a build-time epoch. `begin_operation` atomically rechecks the epoch and requested class, and commits admission before the handler starts. Closing policy between the lookup and admission refuses before any request effects.

The route is classed as **new-work**, including manual order creation and payment authorization/capture. Admission happens before parsing the request, rate limiting, provider calls or application writes. Closed or invalid admission returns a generic 503 with `Cache-Control: no-store` and `Retry-After: 30`. The adapter does not consume or clone the body. Once admitted, it awaits the entire handler before settlement; it does not acquire the application database connection for business transactions.

The shared Square charge implementation marks caught authorization, finalization, capture, capture-marker, compensation and confirmation-side-effect errors in an operation-local async context. Checkout cleanup failures also mark uncertainty. The marker is sticky across awaits and isolated between concurrent requests. This is deliberately conservative, including an authorization error subsequently compensated successfully: owner review is required before considering that execution resolved. Outside an enforced operation the marker is a no-op and original checkout responses and compensation behavior remain unchanged.

A marked outcome, a returned 5xx, an uncaught exception or lost connection yields a sanitized 503. With a usable connection, a failed callback records `uncertain`; a lost session may retain `active`. Neither state expires. A lost settlement acknowledgement never replays payment work or settlement: the committed operation may already be completed, and actual state must be inspected. The adapter preserves business/provider idempotency keys and adds only an execution UUID. A 503 does not establish that no charge occurred; any new attempt must use the existing reservation and provider idempotency/reconciliation rules. The wrapper performs no automatic retry.

## Configuration contract

All values are server-only. Keep the example mode `off` until a separate live bootstrap and producer qualification are reviewed.

| Setting | Enforced requirement |
| --- | --- |
| `FRONTEND_WRITER_ADMISSION_MODE` | Unset or `off` preserves existing behavior without opening a ledger connection. Only `enforce` enables the adapter; other values refuse. |
| `FRONTEND_WRITER_ADMISSION_TARGET_JSON` | Reviewed object with `environment`, direct DNS `host`, `port`, `database`, runtime `user`, `serverMajor` (16 or 18), and nonzero 64-character `targetSha256`. |
| `FRONTEND_WRITER_PRODUCER_SHA256` | Nonzero 64-character identity registered by the ledger owner. |
| `VERCEL_GIT_COMMIT_SHA` | Exact nonzero 40-character source commit registered for that producer. |
| `FRONTEND_WRITER_ADMISSION_DATABASE_URL` | Runtime secret for the exact target/login with only `sslmode=verify-full`; no pooler, alternate target or connection-option overrides. |
| Hosted identity | Dedicated staging/production Vercel team/project verified by the existing application-environment resolver, with `VERCEL_ENV` and `VERCEL_TARGET_ENV` both `production`. Preview and local enforcement refuse. |

The login needs only schema USAGE and EXECUTE on the ledger routines, with no direct ledger table or DDL access. The separately owned bootstrap SQL includes the policy lookup; there is no application migration, live installation CLI or startup bootstrap. No URL/password or request body enters the operation ledger, retained validation evidence or public errors.

## Qualification and remaining coverage

The [validation record](baselines/2026-11-04-p2-00-route-admission/validation.json) records the unit suite, type checking and owned PostgreSQL16/18 fault checks. These run the actual TypeScript adapter against disposable TLS/SCRAM databases, including committed admission before effects, independent recovery policy, a close/admit race, in-flight work, caught HTTP-success uncertainty, lost acknowledgements and actual backend death. A unit test also passes an untouched signed body through the real Square webhook handler as a future integration check; the webhook export is not wired here. The fixture's native-TypeScript resolution hooks exist only in the test harness. CI mounts the adapter and environment resolver read-only into the existing PostgreSQL18 fixture; no runtime credential or provider access is added.

The local production build compiled and passed its TypeScript stage, then refused page-data collection because `SANITY_API_READ_TOKEN` was unavailable. CI must establish full build/browser qualification with its existing configuration. Local type checking separately passed with dependencies matching the committed lockfile.

Other checkout, booking, webhook, GET mutation, admin, form, server-action and worker entrypoints remain unwired. The generic adapter accepts new-work and recovery for qualification, but supports only non-streaming handlers with every side effect awaited. Next.js redirect exceptions, streaming/deferred work and caught domain-level uncertainty require explicit integration before adoption. It does not infer provider finality from an HTTP status alone.

Application-wide producer classification, historical deployment/provider fencing, live bootstrap, all-writer/whole-provider drain, and the parent migration/deployment/recovery coordinator remain unfinished. The selected historical-login component and this route cannot prove those conditions. No result authorizes SQL or changes `historicalWritersFenced`/`migrationAuthorized` from false. Fresha/410 reservation closure remains in force. Live staging and production are unchanged.
