# Six historical capability predicates

This is source and owned-fixture qualification. No actual deployment original configuration, external grant, staging application database, provider account, ingress delivery history, or secret was accessed. It does not establish staging retirement or release readiness.

Runtime/test/profile source commit: `6d13640a170a5e68cc2374f5968e41d5816492dd`; checker byte SHA-256 `e924d1d54d505858cd09eb2044b004ab887780a473f7f356c6d72a010b51fc3c`.

The corrected source checks all 33 registered Git revisions and their exact locked SDK identities. `reviewed-six-source-gates.json` records reviewed blob/SHA identities for auth, alternate grant stores, both signed Sanity callbacks, product stock synchronization, Studio/public media, and the four supported direct callers. Regeneration refuses a changed/missing gate file or locked SDK. This review is additive to the complete historical inventory and preserves the four global SQL credential requirement IDs.

## Scope and source findings

| Family | Audited actual source | Positive predicate and limits |
| --- | --- | --- |
| `google.identity` | `src/auth.ts`; `src/lib/admin/{auth,auth-service,developer-mode,developer-mode-config}.ts`; locked `next-auth` environment defaults and `@auth/core` environment/assertion implementations. | All five signing aliases `AUTH_SECRET`, `NEXTAUTH_SECRET`, `AUTH_SECRET_1`, `AUTH_SECRET_2`, `AUTH_SECRET_3` must be absent from the complete original catalog, together with all original SQL and both KV keys. Missing Google client ID alone does not invalidate retained JWTs. Developer access uses its separate signing key; it is not classified as Google authentication. |
| `google.oauth` | `src/lib/booking/google-calendar.ts`, `operational-store.ts`, `google-refresh-token-store.ts`; `/api/booking/oauth/callback`; SQL calendar repository; `admin/calendar-credential-revocation.ts`. | Identity signing must be blocked, at least one exact `getBookingEnv` construction prerequisite absent, every SQL credential absent, and both KV keys absent. Direct best-effort revoke bypasses OAuth client construction and can consume SQL ciphertext. Masked/present keys and configured empty stores remain unresolved. |
| `google.calendar` | Same actual Calendar construction, SQL assignment/grant, legacy Redis refresh, event/hold/checkout continuation paths. | Client construction blocked plus every original SQL credential and both KV keys absent. Current empty SQL/Redis does not settle transient provider requests or lost acknowledgments. Both scoped and unscoped legacy refresh keys are independently observed when configured. |
| `sanity.callbacks` | POST `/api/revalidate` and POST `/api/webhooks/sanity/inventory-sync`; both handlers reject missing hook secret before accepted body/stock mutation; revalidation's product stock action is deferred with `after`. | Original `SANITY_WEBHOOK_SECRET` absent. A retained empty/masked/present key remains unresolved. A current unsigned 401 is not accepted as proof of missing original capability. Configured signed ingress requires actual delivery, deferred continuation, and persistence evidence. |
| `sanity.editorial` | Authenticated-user Studio authoring; separate read/write clients; both product hook paths; tracked migration/backfill scripts. | For deployment scope, every original SQL credential absent or signed SQL hook ingress blocked. External Sanity author identity and editorial writes are explicitly **not declared absent**. Unsupported manual backfills remain unsupported direct callers and cannot borrow deployment predicates. Public/editorial reads alone are not provider mutation evidence. |
| `mux.studio` | Studio plugin configuration, `short-course.ts`, cache-only `mux.videoAsset` revalidation, product-only SQL callback guard, locked Mux input plugin Sanity-addon operations. | No Studio Mux action writes frontend SQL or invokes private Course media handlers. This is a private-SQL scope exclusion, not Mux key/asset/signer retirement. Authenticated Studio/plugin operations, including unrelated signed media settings, remain external editorial capability. Eight exact profiles have neither plugin import nor short-course schema and are source-absent for this family. |

All 33 sources have identical Google auth/Calendar/store blobs. Four Studio/revalidation variants were compared: eight remove the Mux plugin/short-course cache tags, two remove only the services singleton/cache tag, and one adds an editorial landing-page template/tag. None changes the product-only SQL stock guard. The public Mux plugin can operate through authenticated Sanity addon endpoints; lack of frontend Mux environment keys does not mean those external capabilities are absent. SDK archive receipts record official npm archives checked against the actual historical lockfile SHA-512 values, with hashes of inspected implementation files.

The four supported direct callers are the exact Resend template seed/update and HighLevel backfill/config-check scripts. Their source/import scope does not invoke these six deployed mutation families. Arbitrary exported helpers and other tracked scripts are not admitted through this proof. The full source inventory retains those other programs for separate review.

## Observer boundary

`historicalSourceAlternateStoreQueryPlan(requirements)` publishes five literal read-only SQL queries and the fixed Redis metadata operations. `observeHistoricalSourceAlternateStores(requirements, binding, original, sqlEvidence)` accepts only in-process branded source and SQL proofs, privately reuses the original credential-bound peers, and repeats TLS/role/OID/read-only/four-marker validation. SQL rows are read only when every configured credential points to the exact selected parent database descriptor. Alternate database credentials remain metadata-only; the observer refuses application discovery there.

SQL observations count all Google connection rows, retained ciphertext or secret references, hold event references, appointment event records, and checkout Calendar continuations. No credential values, provider IDs, event details, contact data, or SQL rows are returned. Current emptiness is explicitly `unresolved-historical-accepted-request-completeness`.

Redis uses the exact original `KV_REST_API_URL` and `KV_REST_API_TOKEN`, HTTPS certificate validation, no redirects, finite response/time/page bounds, and only `EXISTS`/`SCAN`. It independently checks the original deployment-label refresh key, unscoped refresh key, fixed Calendar lock, and complete bounded OAuth-state/scoped-lock/idempotency scans. It never retrieves refresh token values. Parent verification runs before and finally after every HTTP request, including denial/failure. Snapshots are repeated; unstable state refuses a proof. Partial/masked/empty/unavailable configured stores remain unknown.

The optional fifth `deriveHistoricalSourceCapabilityClosures(..., storeEvidence)` argument accepts only this collector's branded result with identical source/surface/original configuration/provenance/SQL evidence. Retained Google facts block all three Google closures. Serialized, caller-constructed, foreign, or stale-context facts refuse. A complete empty original catalog needs no replacement provider credentials or API reads. Existing global SQL requirements, exact closure requirement unions, canonical evidence IDs, original full-catalog binding, and source branding remain in force.

## Executed evidence

- `unit-qualified.tap`: 20 passing source/configuration/proof tests, no skips, including all 33 actual source getters, SDK/gate checks, every signing alias, all four SQL alternatives, both KV alternatives, signed hook key presence, unsupported manual paths, retained grant/event/checkout contradictions, and forged/foreign/serialized observation rejection.
- `owned-pg16-second.json`: 15 passing actual PostgreSQL 16 checks; all 83 repository migration entries applied statement by statement, four actual TLS/SCRAM read-only original-role peers, actual retained ciphertext and secret-reference grants, selected-parent restriction, and parent marker/role/credential/writable-session refusals. No environment database URL is consumed.
- `owned-https-final.json`: 10 passing actual owned HTTPS checks: empty configured store remains unresolved, scoped/unscoped refresh and lock contradictions, complete two-page state scan, and sanitized 401/redirect/malformed/repeated-cursor/changing-state refusals.
- `regeneration.json`: all 33 profile bytes and checker bytes identical after regeneration.
- `prior-source-control.json`: the actual previous `502b7d2f` source getter/prepare/SQL collector/derive pipeline reproduces the six unresolved families with an otherwise complete empty fixture original catalog. This demonstrates the missing source predicates; it does not convert absent actual evidence into a live result.

Earlier receipts are immutable: the first HTTPS child exited with status 1 while profile regeneration was still in progress; its detailed diagnostic was not captured. The first PG runner failed during cluster/setup, without a detailed cause in its sanitized receipt. The revised runner labels setup phases and executes migration statement breakpoints. Serialized reruns passed. `unit-first.tap` and `unit-final.tap` are earlier passing checks retained before the final manual-caller case. Cleanup awaited child exit, closed owned HTTPS sockets and all SQL peers, stopped the disposable cluster, and removed only owned temporary directories.

Run with Node 24:

```sh
node --test ops/platform/frontend-historical-source.test.mjs
FRONTEND_HISTORICAL_SOURCE_OWNED_TEST=true PG_BIN=/path/to/postgresql-16/bin \
  node docs/api-integration/baselines/2026-11-05-historical-capability-followup/run-owned-pg.mjs
FRONTEND_HISTORICAL_SOURCE_OWNED_HTTPS_TEST=true \
  node docs/api-integration/baselines/2026-11-05-historical-capability-followup/run-owned-https.mjs
```

Configured Google stores, configured Sanity signed ingress, actual historical provider acceptance/lifetime, downstream effects, and external editorial operations still require their own actual bound evidence. This change supplies no provider mutation, credential revocation, historical deletion, migration authorization, production discovery, or staging certification.
