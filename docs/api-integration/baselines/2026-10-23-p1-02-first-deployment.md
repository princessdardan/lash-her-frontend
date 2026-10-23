# P1-02 first frontend staging deployment

Frontend candidate `d915619f11e198e6e1ef7cc1d4e9a2d644eb615a` is deployed and READY at
[staging.lashher.com](https://staging.lashher.com). Acceptance is **PARTIAL**;
P1-02 remains **BLOCKED** on the named gates below. The deployed source was not changed.

- Project `prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM`, team `team_2Hrn5eMZyZxfAWdmYvyKi9t3`.
- Deployment `dpl_BCyvMh81J8KyGFuas3pJgNCKUkys`; Vercel Production target,
  business `APP_ENV=staging`, Node 24.x, `staging` Git branch. Build took 200 seconds.
- [Immutable candidate](https://github.com/princessdardan/lash-her-frontend/releases/tag/staging-rc-p1-02-2026-10-22.2)
  and [successful CI/protected migration](https://github.com/princessdardan/lash-her-frontend/actions/runs/39878997124).
  Both release pins match d915619. All 80 frontend migrations through
  `0079_highlevel_marketing_ownership` and restricted runtime grants were verified before activation.
- Added the missing `staging` CNAME to Vercel's recommended target. Readback reports
  no domain misconfiguration. Initial negative DNS cache results are not application failures.

## Deployed acceptance

| Check | Result |
| --- | --- |
| Public home/services/products/training/contact and staff sign-in | PASS; home references isolated Sanity project 7o23yrvk, not original project 3auncj84 |
| Square commerce configuration | PASS; sandbox environment and sandbox Web Payments SDK |
| Google owner sign-in and callback | PASS using the specifically approved existing session; DB-backed administrator dashboard loaded |
| Anonymous session/admin page | PASS; empty session, staff sign-in redirect |
| CSRF cookie and platform protection | PASS; Host prefix, Secure, HttpOnly, SameSite=Lax; anonymous platform request redirects to Vercel SSO |
| Fresha cutover | PASS; booking redirect and all four retired booking method/path combinations return 410 |
| Unsigned provider ingress | PASS; Square, Resend and Sanity return 401 |
| Signed provider ingress | PASS within limited scope; all three reject altered bodies; Resend no-op and Sanity cache revalidation repeat safely |
| Square valid signature | PASS to payload validation (400 for signed malformed payload); valid unsupported events reach the disabled service-booking path (404), as expected |
| Native scheduler configuration | PASS; nine deployed definitions exactly match source and this deployment; unauthorized calls return 401/404 |
| Unauthenticated admin label API | FAIL; access is denied but uncaught AdminAuthError returns 500 instead of 401/403 |

The baseline matrix passed 27 of 28 checks. Ten signed-ingress checks passed.
Signed no-op repetition is not business-event persistence/deduplication evidence.
No payment, contact or email was created by these synthetic webhook requests.
Provider subscriptions remain disabled. Shipping and HighLevel remain disabled.

The log scan found the reproduced admin-label error and expected missing-signature
logging from negative Sanity requests. It does not certify long-term monitoring.
Platform-recorded OIDC claims match the staging project and Production target;
actual outbound token verification at the gateway remains P1-03.

## Authenticated scheduled-handler follow-up

Approved by the owner and executed once per handler on **2026-10-22 at 22:59
America/Toronto**. Retained evidence filenames and ISO timestamps use UTC.
Exact deployment/source/pins and disabled shipping/HighLevel flags were checked
before execution. No provider settings were changed and no cleanup was retried.

| Handler | HTTP | Response assessment |
| --- | --- | --- |
| Private-data retention | 503 | FAIL; HighLevel retention query raises SQLSTATE 42883 |
| Backup validation | 200 | SCAFFOLD; validationPerformed=false, manualActionRequired=true |
| Payment reconciliation | 200 | PASS for current empty staging workload; ok=true, zero findings; no subtask failure logs observed |
| Shipping worker | 200 | DISABLED; zero queued/refund work and needsReview=0 |
| Customer-email outbox | 200 | PASS for empty queue; claimed/enqueued/failed/sent/suppressed all zero |
| Stock reservations | 200 | PASS for empty sweep; scanned/released/skipped/failed all zero |
| Marketing contact sync | 404 | DISABLED; route-enabling configuration is missing; worker not exercised |
| Shipping-rate refresh | 200 | DISABLED; updated=0 |
| HighLevel sync | 200 | DISABLED; processed/succeeded/retry/review/dead_letter all zero |

Retention diagnosis used plain `EXPLAIN` without `ANALYZE`, in read-only
transactions against the exact staging database. The deployed query
`received_at < $1 - interval '90 days'` fails because PostgreSQL infers the
parameter as an interval: `operator does not exist: timestamp with time zone < interval`.
Casting the parameter as `timestamptz` allows planning. This is diagnosis, not a
source fix or a completed cleanup. Earlier step-up-proof/shipping-retention steps
may have committed before the HighLevel subtransaction failed; no total-affected
count was returned. The remaining primary retention steps were not reached.

The reviewed run window contained the retention failure and no other
warning/error/fatal entries, including payment-reconciliation subtask errors.
Manual authenticated requests do not prove platform-origin scheduling, missed-run
alerting, queued-work behavior, provider delivery or restored-data recovery.

## Remaining gates

- **P1-02-A01 (OPEN)**: Fix uncaught unauthenticated AdminAuthError on admin label API in a separately reviewed candidate; expect 401/403, not 500. Access remains denied.
- **P1-02-A02 (PARTIAL)**: Staging owner Google sign-in and DB-backed dashboard passed. Complete non-admin authorization and dedicated Calendar OAuth/session-expiry checks.
- **P1-02-A03 (OPEN)**: Exercise deployed transactional-recipient refusal, isolated allowed test delivery, contact flow and staging bulk-delivery block. Source/tests and release preflight alone do not certify live delivery.
- **P1-02-A04 (PARTIAL)**: Signed ingress and body tamper rejection passed for Square, Resend and Sanity. Provider-issued business event persistence/deduplication and activation remain open; review enabled legacy Square preview callback before sandbox payment events.
- **P1-02-A05 (PARTIAL)**: Nine native schedules match source; unauthorized requests fail closed. User-approved one-time authenticated manual runs completed: seven HTTP 200, retention 503 and marketing sync disabled 404. No email sends, refunds or stock releases were reported. Backup remains a manual-action scaffold. Platform-origin invocation, marketing enabling configuration and restored-data recovery evidence remain open; retention is tracked separately in A07.
- **P1-02-A06 (OPEN)**: Rotate existing staging ingress bypass credentials after a diagnostic printed private ingress metadata in chat tool output. No public repository publication is established; retain all-deployment authentication and disabled provider deliveries.
- **P1-02-A07 (OPEN)**: Fix HighLevel retention timestamp/interval parameter inference in a separately reviewed candidate and add a database regression test. Deployed cleanup returns 503; plain read-only EXPLAIN reproduced SQLSTATE 42883, and explicit timestamptz cast plans successfully. Do not count the failed run as completed retention or assume earlier cleanup steps rolled back.
- **P1-02-R01 (OPEN)**: Course/Community exact-target lineage, protected migration jobs, runtime/migration artifacts and release pins; frontend-only migration is complete.
- **P1-02-R02 (OPEN)**: Lightsail host/operator/provisioning, gateway/private TLS/network and measured capacity; no API host created by this frontend release.
- **P1-02-R03 (OPEN)**: P1-01 contract release, P1-03 signed outbound OIDC/gateway verification, P1-04 container readiness and P1-07/P1-08 deployed operations/monitoring evidence remain separate gates.
- **P1-02-R04 (OPEN)**: Complete provider ownership/isolation, Mux environment and itemized paid-resource costs/retention/rotation/audit evidence; shipping and HighLevel remain disabled.

## Evidence and limitations

[Sanitized machine-readable evidence](2026-10-23-p1-02-first-deployment.json)
records the deployed checks and gates. Private screenshots, credentials and raw
project metadata are excluded from repository evidence. A diagnostic printed
private ingress metadata into this chat's tool output; gate A06 records required
rotation before provider activation. No public leak has been established.

This document supersedes earlier no-deployment/no-frontend-cloud-migration status
statements only for this exact frontend revision and target. Course/Community
migration and API host gates remain open. Recovery evidence covers an initially
empty schema, not data-bearing application recovery. No production application
rollout, provider delivery activation or new host provisioning is certified here.
