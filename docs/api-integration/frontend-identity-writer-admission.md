# Identity and account writer admission qualification

The owned fixture invokes the actual customer-auth GET/POST/HEAD exports, real Auth.js Google/Resend flows and PostgreSQL stores. Account command/preferences exports use the real active-session reader and stores inside the installed Next.js request storage. The fixture changes no application auth/account source, schemas, shared parent harness or contracts.

Run with Node 24 and a matching PostgreSQL 16 installation:

```sh
FRONTEND_IDENTITY_LOCAL_TEST=true PG_BIN=/opt/homebrew/opt/postgresql@16/bin node --import tsx ops/platform/test-frontend-identity-local.mjs
```

The launcher creates/removes a disposable loopback TLS/SCRAM database, applies the source migration chain and uses the existing admission fixture. Caller database URLs are not used. Google discovery/keys/token responses and Resend email receipts are synthetic; unexpected external fetches refuse. Existing auth, session-issuance and lifecycle DB cases run afterward, with only this fixture's mutable downstream test deliveries quarantined to avoid cross-scenario worker scans. No live provider, database, schedule or credential is changed.

Qualification checks admission before callback throttles, bounded expired-credential maintenance, single-use token consumption, session/provider-link mutations and email/provider effects. It checks complete positive operations, actual OIDC and email sign-in, sign-out, canonical private sessions, delayed provider/SQL work, missing or changed receipts, actual ledger-backend death and lost admission or SQL commit acknowledgments. Committed outcomes remain stored; unresolved entries require deliberate fixture-owner reconciliation. No automatic provider/SQL replay is accepted.

Account cases cover closed admission, real cookie/session denial, exact command replay, both downstream command rows, missing receipt rollback, blocked writes, stale authentication, concurrent session revocation, deletion and committed commands surviving ledger death. Constructed request storage supplies the real `cookies()` implementation; neither the account session reader nor database store is mocked.

The HTTP bridge maps loopback transport to one fixed synthetic HTTPS origin. Request storage is constructed directly rather than supplied by a running Next.js server. Native server/proxy processing, browser cookie acceptance and cross-tab behavior, real Google/Resend and deployed scheduler/release behavior remain outside this qualification. Browser/native Next checks remain required before P2-12/G2 certification.

Two frozen failed-source records are retained separately: the [original missing token/session inserts](baselines/2026-11-05-p2-00-identity-admission-frozen-findings/validation.json) and [adjacent sign-out/token/link/throttle failures](baselines/2026-11-05-p2-00-identity-admission-adjacent-findings/validation.json). A findings result exits 1 and cannot become a passing qualification. Corrected source must receive its own inventory/hash-bound record; original failures are never overwritten.
