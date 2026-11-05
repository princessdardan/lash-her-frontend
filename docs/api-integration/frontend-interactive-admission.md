# Interactive writer admission component

This component adds disabled-by-default boundaries to public forms, legacy course signup, administrative actions and OAuth/authentication continuations. It does not establish all-writer drain, historical deployment fencing, coordinator readiness or authority to apply frontend SQL.

## Candidate boundaries

| Producer | Admission class | Boundary |
| --- | --- | --- |
| General inquiry, training contact, contact popup | New work | Before validation/rate-limit bookkeeping, private persistence and awaited email/outbox work |
| Legacy course signup | New work | Before Redis limiter, private signup and access cookie; access confirmation remains read-only |
| Operational admin actions, service promotions | New work | Before authorization/mutation task; settle before framework redirect/revalidation |
| Campaign draft/test/send, HighLevel administrative actions | New work | Entire action callback, including authorization, provider work and audits |
| Calendar OAuth starts | New work | Before authorization and Redis state creation; return an HTTP redirect after work settles |
| Calendar and HighLevel OAuth callbacks | Recovery | Before state consumption, provider exchange, credential persistence and audit |
| Admin authentication route | New work for initiation; recovery for callback/session/sign-out | Before Auth.js handler; its HTTP redirect is a returned Response |
| Admin authentication actions | New work for initiation/developer authorization; recovery for sign-out | Auth.js uses redirect=false; framework redirects happen after settlement |
| Admin step-up completion | Recovery | Before actor resolution, proof persistence and cookies |
| Admin identity bootstrap/binding | New work | Independent repository write boundary, including implicit-provider synchronization |
| Known-admin identity refresh | Recovery | Independent repository write boundary, including implicit-provider synchronization |
| Permission-denial audit | Recovery | Independent audit callback boundary |

Administrative renders are persistent producers because actor resolution refreshes the authenticated identity. Repository-level boundaries cover those writes even outside a server action. They do not qualify the whole render or unrelated helpers. Existing-user identity refresh is recovery so an already-authorized OAuth callback can finish while new work is closed; identity bootstrap/binding cannot use that permission.

Independent nested operations are retained. An inner failure marks its caller's uncertainty after the inner context restores, including authentication fallbacks and denied permission paths. No existing-context skip is introduced. The enclosing action/route remains authoritative for its whole-operation classification.

## Outcome accounting

Public form and legacy signup catches retain uncertain limiter/persistence/cookie/email outcomes. Popup admin notification and durable-email delivery catches cannot acknowledge successful drain. Provider/database siblings in the administrative mutation dependency graph are awaited with all-settled semantics before a failure propagates.

OAuth cleanup failures, retained unpersisted grants, credential errors and caught callback errors retain uncertainty even behind an ordinary error redirect. Failed Google token revocation acknowledgements remain uncertain while local credential deletion remains authoritative. Auditing failures remain non-blocking for the original application behavior when admission is off, and mark admitted operations uncertain.

## Evidence and limits

Focused tests exercise actual form/signup and Calendar callback control flow with injected domain dependencies, and the real admission runner against an in-memory protocol peer. Tests include policy refusal before effects, sibling settlement, caught failures, clean redirects, known-user recovery versus bootstrap gating and propagation from nested writer contexts. Existing authorization, step-up, revocation and OAuth regression tests are included.

Actual exported actions/routes against the owned TLS ledger and migrated business database still require qualification by the integration fixture. Provider responses in focused tests are synthetic. Direct/manual callers of operational mutation helpers, other interactive payment/booking continuations, shipping (including externally owned PR #91), remaining workers, provider inventories and historical sources remain separate requirements. No live provider, credential, schedule or admission state is changed.
