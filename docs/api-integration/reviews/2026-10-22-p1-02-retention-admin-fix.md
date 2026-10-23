# P1-02 retention and admin API replacement candidate

Candidate `staging-rc-p1-02-2026-10-22.3` extends deployed frontend
`d915619f11e198e6e1ef7cc1d4e9a2d644eb615a` in an isolated checkout on
`codex/p1-02-retention-admin-fix`. P1-02 remains **BLOCKED**. This prepares source
for a subsequent staging release; it does not promote staging or retry cleanup.
[Gate register and validation](../baselines/2026-10-22-p1-02-retention-admin-fix.json)
carry every A01-A07 and R01-R04 gate from the
[first-deployment evidence](../baselines/2026-10-23-p1-02-first-deployment.md).

## Source review

This is a sole-developer source review, not independent reviewer approval.
Reviewed the complete delta against d915619, including the moved label handler,
route binding, test registration, destructive-test isolation and release controls.
No unresolved source defect was identified in this bounded change.

- HighLevel retention now casts all four interval-arithmetic parameters to
  `timestamptz`. PostgreSQL previously inferred interval and rejected the receipt
  comparison with SQLSTATE 42883. OAuth expiry, retention periods, strict `<`
  boundaries, count semantics and transaction scope are preserved. No migration
  is needed; ordered SQL, journals, migration pins and dependency lock are unchanged.
- The shipping label route delegates to a testable handler. Its permission check
  translates only typed `AdminAuthError`: unauthenticated -> 401, other denials ->
  403, with generic JSON and `private, no-store`. Authorization remains before
  params, DB shipment access, provider config and provider/download calls.
  Unexpected authentication failures still throw. Authorized generation lookup,
  provider URL restrictions, bounded PDF response and headers are preserved.
- Nine handler regressions cover every admin denial code, unexpected auth errors,
  authorized generation validation/missing shipment and a successful PDF response.
  The regression filename avoids bracketed dynamic route directories because
  Node 24 treats those test arguments as globs and can silently select zero tests.
- The real PostgreSQL regression copies the five migrated table definitions into
  a unique schema and sets its connection search path, isolating the sweep from
  shared test records. It covers OAuth/90-day/395-day/2555-day boundaries, pending
  and null-completion jobs, deleted contacts, affected counts and repeat-run
  consent requeue deduplication under America/Toronto. The schema is dropped afterward.
- CI runs the new branch through existing quality/database/audit/build/browser
  jobs. The protected cloud migration job still excludes it; the release-context
  test explicitly rejects this branch. Publishing source does not update cloud
  pins, advance staging or grant migration permission.

## Executed validation

Under Node 24.18.0:

- Before patching: the new DB test reproduced SQLSTATE 42883; all six auth-denial
  cases failed with uncaught AdminAuthError. After patching: nine label tests and
  the isolated retention regression pass.
- All 2,051 non-DB source/script/security tests and all 188 DB tests pass.
- All 80 existing migrations through 0079 apply to disposable PostgreSQL 18;
  contract integrity/generated types, Drizzle check and 17 release-guard tests pass.
- TypeScript passes; lint has zero errors and eleven existing warnings.
- `npm run build -- --experimental-build-mode=compile` passes with public local
  CMS identifiers and no credentials. This proves compilation, not prerendering,
  live provider integration or deployed cleanup. Full hosted CI must pass on the
  exact candidate revision and is linked in the release notes.

## Staging handoff and remaining gates

The currently deployed source and protected source/migration pins remain d915619.
Its migration receipt cannot certify the replacement SHA. On an allowed release
ref, require exact-revision CI, owner release approval, updated protected migration
expected revision and reviewed recovery evidence; run the existing protected
lineage/runtime-grant verification job and retain the new receipt. With unchanged
migration bytes, no new DDL is expected. Set source and migration pins only after
their respective verification succeeds, then promote staging.

A01 and A07 are **PARTIAL: source fixed, deployed verification pending**. After
promotion verify anonymous 401, non-admin 403 and authorized label behavior.
Separately authorize and record one retention invocation, counts and logs. The
prior failed sweep is not completed retention; earlier independent steps may
have committed. No cleanup was retried for this candidate.

A02 remains partial for non-admin/Calendar/session checks; A03 remains open for
live email/contact refusal and allowed delivery; A04 remains partial for provider
business-event persistence/deduplication and activation; A05 remains partial for
platform-origin schedules, marketing config and recovery beyond the backup scaffold;
A06 remains open for ingress credential rotation before provider activation.
R01-R04 remain open for Course/Community lineage/artifacts, Lightsail host/private
TLS/capacity, separate P1 contracts/gateway/operations evidence, and provider/Mux/
cost/retention/rotation/audit evidence. Shipping and HighLevel remain disabled.
