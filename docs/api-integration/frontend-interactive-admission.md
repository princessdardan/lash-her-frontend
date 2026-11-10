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
| Booking card-on-file and charge-and-store confirmation | New work | Before body consumption and all customer/card/payment/Calendar/persistence/email effects |
| Booking promotion mutation | New work | Before Redis rate limiting and hold snapshot updates |
| Admin no-show initiation | New work | Before authentication/body and all invoice/charge/audit effects |
| Manual transactional email retry | Recovery | Before authentication/body and all lookup/token/notification/persistence effects |
| Product refund reservation, manual fulfillment, postage purchase/refund reservation, package-profile mutations | New work | Whole HTTP request before authorization and private transaction/audit work |
| Existing postage-label download | Recovery | Whole authenticated provider lookup and bounded download; no detached response stream |

Administrative renders are persistent producers because actor resolution refreshes the authenticated identity. `runAdminAuthorizationOperation` now encloses the complete actor resolution, identity persistence, subsequent resource lookup and permission-denial audit, including the protected layout's permission call. It reuses only its own semantic parent. Confirmed authorization errors settle before page redirects; caught audit/persistence uncertainty cannot complete. Existing-user identity refresh is recovery so an already-authorized OAuth callback can finish while new work is closed; the independent repository gates still require new work for identity bootstrap/binding. These authorization boundaries do not qualify provider continuations or other effects later in a page. Course authoring pages use their separate whole-page boundary; Calendar discovery continuations are being qualified separately.

Independent nested operations are retained. An inner failure marks its caller's uncertainty after the inner context restores, including authentication fallbacks and denied permission paths. No existing-context skip is introduced. The enclosing action/route remains authoritative for its whole-operation classification.

## Outcome accounting

Public form and legacy signup catches retain uncertain limiter/persistence/cookie/email outcomes. Popup admin notification and durable-email delivery catches cannot acknowledge successful drain. Provider/database siblings in the administrative mutation dependency graph are awaited with all-settled semantics before a failure propagates.

OAuth cleanup failures, retained unpersisted grants, credential errors and caught callback errors retain uncertainty even behind an ordinary error redirect. Failed Google token revocation acknowledgements remain uncertain while local credential deletion remains authoritative. Booking/payment/no-show services conservatively retain caught persistence, provider, checkpoint and fallback failures, including manual-follow-up and pending initiation outcomes. All started Calendar lookups and asynchronous alert effects settle before the outer boundary. Booking checkout remains a read-only historical-link lookup; availability/hold/create exports remain the existing unconditional Fresha 410 handlers.

Auditing failures remain non-blocking for the original application behavior when admission is off, and mark admitted operations uncertain.

## Evidence and limits

Focused tests exercise actual form/signup and Calendar callback control flow with injected domain dependencies, and the real admission runner against an in-memory protocol peer. Tests include policy refusal before effects, sibling settlement, caught failures, clean redirects, known-user recovery versus bootstrap gating and propagation from nested writer contexts. Existing authorization, step-up, revocation and OAuth regression tests are included.

Actual exported actions/routes against the owned TLS ledger and migrated business database still require qualification by the integration fixture. Provider responses in focused tests are synthetic. Other direct/manual callers, shipping service internals and workers (including externally owned PR #91), remaining workers, provider inventories and historical sources remain separate requirements. No live provider, credential, schedule or admission state is changed.

## Direct and maintenance entry points

Exported operational admin, employee Calendar, service-promotion and Square-team mutation functions have independent boundaries before their authorization/provider/database work. Credential-save and provisional-cleanup callbacks use recovery; configuration, staff, scheduling and promotion changes use new work. Step-up issuance uses recovery and consumption uses new work. Direct audit writes and existing credential revocation use recovery. Nested refusals or uncertainty propagate to an enclosing operation; no context-based admission bypass is added.

Manual transactional email retries use recovery and the default no-show command uses new work when called independently. Legacy booking bootstrap and operational-cutover scripts acquire new-work admission for `--execute` before inventory reads; their dry-run paths remain read-only. Other marketing/stock scripts are owned by the worker component. These wrappers preserve off-mode application behavior and do not establish provider/historical/script inventory completeness.

## Owned-database qualification

`ops/platform/harness/owned-frontend-interactive-admission.mjs` is a child of the existing disposable migration fixture. The parent supplies only its generated loopback port/password/major and TLS CA after applying business migrations and ledger grants. It refuses ordinary configured URLs and intercepts every allowed provider call.

The candidate passed PostgreSQL16 qualification with 80 business migrations and 12 interactive checks: real exported form persistence/consent, both email effects, provider rejection/missing acknowledgements, failed SQL/missing insert receipt, delayed sibling work, blocked business transaction, actual ledger-backend termination, the actual booking-promotion HTTP export/missing update receipt, and closed-policy refusal by direct admin exports. The fixture verifies the source inventory is unchanged during execution and emits the application inventory and harness hashes with its inspected-row reconciliation evidence.

The form runs through an HTTP fixture bridge calling the actual server-action export. This does not qualify Next.js's deployed server-action dispatch. Provider responses are intercepted; immutable deployment execution, admin/Auth.js/OAuth browser behavior, PostgreSQL18 reruns and integrated-source evidence remain required. All drain results explicitly retain `historicalWritersFenced=false` and `migrationAuthorized=false`.
