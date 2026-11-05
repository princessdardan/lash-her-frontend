# Customer identity: P2-01

The separate Auth.js customer configuration uses Google OIDC and Resend email proofs at `/api/customer-auth/**`. The existing administrator configuration, authorization and `/api/auth/**` cookies are unchanged. Customer authentication remains disabled unless `CUSTOMER_AUTH_ENABLED=true`; this change does not enable any deployed environment.

## Configuration and interfaces

Configure each environment independently using `CUSTOMER_AUTH_URL` (canonical site origin), `CUSTOMER_AUTH_SECRET` (independent random secret of at least 32 bytes), `CUSTOMER_AUTH_GOOGLE_ID`, `CUSTOMER_AUTH_GOOGLE_SECRET`, `CUSTOMER_AUTH_RESEND_KEY` and `CUSTOMER_AUTH_EMAIL_FROM`. Never share the customer Google client or Auth.js secret with administrator authentication. The Google callback is `<origin>/api/customer-auth/callback/google`. Existing `AUTH_URL`/`NEXTAUTH_URL`, if present, must use the same site origin; a conflicting origin fails closed. HTTPS is mandatory except explicit nonproduction loopback development. Existing staging recipient restrictions also apply to sign-in emails.

Migration `0080_customer_identity` adds `customer_users`, `customer_provider_links`, `customer_sessions`, `customer_verification_tokens` and `customer_auth_throttle`. Customer UUIDs are database-generated and never derived from provider subjects, email addresses, submissions or course-signup records. A provider identity belongs to one customer; a customer has at most one Google identity. Only provider identity is retained, not OAuth access, refresh or ID tokens. Customer lifecycle state is checked when creating or reading sessions.

`getCustomerActor()` from `src/lib/customer-auth/session.ts` returns `{ id, email, name }` or `null`. It is a server-only read of the specifically named customer database session. It does not renew a cookie or expiry, reuse an administrator session, or confer administrator permissions. Service JWT subjects must use `id`; token signing remains P2-04. Suspension/deletion commands and preferences remain P2-11.

Sessions have a fixed 30-day lifetime, use HTTP-only SameSite=Lax host-only cookies and store only a SHA-256 digest of the random bearer in PostgreSQL. Every lookup checks expiry and active account state. Expired tokens/sessions/throttle rows are cleaned as part of a later admitted authentication mutation, never during rendering.

Email proofs expire after 15 minutes. Auth.js supplies the secret-bound SHA-256 proof digest; the adapter atomically deletes and returns the matching proof and denies expired/replayed proofs. The sender persists the digest before calling Resend and awaits the bounded provider acknowledgement. It never logs addresses, URLs, bearer tokens, profiles or provider response bodies. Provider or caught database ambiguity remains visible to durable admission even when Auth.js converts its failure to a redirect.

Email requests have the same redirect/body for existing/new accounts, invalid addresses, blocked accounts and throttled requests. Durable HMAC-keyed counters allow five requests per email, 30 mutation requests per client and 60 callbacks per client per 15 minutes. Vercel requires its trusted client address. Customer login does not subscribe anyone to marketing or modify existing marketing contacts/consent.

Sign-in is at `/sign-in`. To add Google to an existing email account, first prove email control with a fresh link, then use `/account/sign-in-methods` to complete Google OIDC while authenticated as that customer. Auth.js validates state, PKCE and nonce, and the application requires Google's verified-email claim and matching provider subject. Matching email addresses alone do not link Google, and an identity already owned by another customer cannot be transferred. An authenticated customer can sign out through this page.

## Writer admission

| Producer | Boundary and behavior |
| --- | --- |
| `/api/customer-auth/csrf`, `/providers`, `/session` | Whole nonstreaming request is admitted as new work; the adapter returns absolute sessions without refresh writes. |
| `/api/customer-auth/signin/google`, `/signin/resend`, `/signout` | Exact-origin POST, bounded body, Auth.js CSRF validation and durable throttling; the full awaited DB/provider operation stays inside admission. |
| `/api/customer-auth/callback/google`, `/callback/resend` | GET callback is admitted before provider exchange, proof consumption, provider linking or session writes. All work is awaited. |
| Adapter mutation helpers | A private async context requires the enclosing customer-auth operation; direct calls outside that boundary throw before writing. |
| `getCustomerActor()` and account page render | Read only; no cleanup, refresh, provider effects or admission ledger mutation. |

Every route response is private/no-store with no-referrer; HEAD explicitly returns 405 so framework fallback cannot consume a proof. Unsupported provider/action paths are not exported through the handler. Refusal returns sanitized retryable 503. No new worker, schedule, service secret or live admission policy is enabled here.

## Evidence and remaining certification

The focused unit and PostgreSQL tests cover origin/CSRF entry boundaries, default disablement, safe redirects, email normalization/enumeration, admission refusal/context, cookie separation, database-generated subjects, hashed absolute sessions, active-state denial, concurrent one-time proofs, expiry, durable throttling, provider uniqueness and discarded credentials. The actual Auth.js Resend sign-in and Google OIDC callback pipelines run against migrated disposable PostgreSQL with intercepted provider endpoints and generated signed OIDC fixtures. They verify successful sign-in, email-only linking refusal, authenticated linking, stable subjects and cross-account takeover refusal.

These tests do not certify live Google/Resend credentials, deployed TLS/host configuration, production database migration, real browser behavior or combined historical-writer drain. P2-12 must certify those staging flows against the exact integrated source after P2-00 qualifies migration/release admission. Do not mark the G2 gate complete from local results.
