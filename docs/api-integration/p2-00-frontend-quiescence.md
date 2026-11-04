# P2-00 frontend SQL coordination

Status: implementation in progress. This document records the design before enabling a pending-SQL release path. Existing staging and production entrypoints continue to refuse pending frontend SQL. No SQL, provider configuration, credentials or live admission changes are authorized by this document.

## Required boundary

Owners: frontend and operations, with each API owner responsible for its receiver compatibility. The release must retain the host environment flock and the frontend physical PostgreSQL session/advisory lock from lineage inspection through SQL, schema/grant verification, compatible frontend verification and promotion. A successful database receipt survives a later deployment failure. No failure path reruns SQL, resumes writers or restores a previous database automatically.

An in-process continuation will extend the existing migration component. It receives sanitized, immutable migration evidence rather than a connection, credential or arbitrary shell command. Its success cannot authorize traffic; restoration and admission are separate steps after terminal cleanup succeeds. Standalone component execution remains database-only and cannot claim coordinator acceptance.

## Writer inventory

The source inventory generator includes every exported HTTP method, including GET callbacks, every module-level and inline server action, scheduled definitions, background `after`/`waitUntil` sites and direct PostgreSQL constructors. It records source hashes, not request data or credentials. It deliberately over-includes read handlers: an HTTP method does not establish that a path is read-only. The generated inventory is a review input, not evidence that a deployed writer is fenced.

The release additionally needs an exhaustive provider inventory of every deployment/project sharing the database or provider credentials, including unique historical deployment URLs, aliases, preview builds, manual scripts and callback destinations. The current project, source checkout and nine current cron definitions alone cannot establish that inventory. Unclassified or omitted producers refuse the release.

| Producer family | Required treatment |
| --- | --- |
| Product/training checkout, booking checkout/card setup, private forms and admin mutations | Stop new work before provider side effects and before database writes. Existing Fresha/410 reservation closure stays in force. |
| Square webhooks/returns, capture reconciliation, refunds, shipment reconciliation and entitlement recovery | Keep available under an independent recovery admission control during an unrelated new-work stop. Before SQL affecting their data, fence new entries and account for admitted work. Return a retryable failure rather than acknowledging unpersisted callbacks. |
| Calendar/HighLevel OAuth callbacks, Resend/HighLevel/Sanity webhooks and unsubscribe | Include GET mutations and provider retries. Preserve state/nonces and the existing idempotency rules. |
| Customer email, CRM, marketing, shipping, stock, retention and reconciliation workers | Suspend future claims and native schedules; inspect admitted leases/effects. Scheduler disablement does not release a worker lease. |
| Server actions and historical URLs | Enforce the same fence independently of the domain alias and environment flags. A new deployment does not update old code or old credentials. |
| Course/Community workers | Keep their gateway new-work/recovery controls independent. Suspend any producer affected by the reviewed frontend SQL or receiver compatibility; do not replay their successful migrations. |

## Admission, drain and bounds

Use a durable admission epoch with separate new-work and recovery controls. An admitted operation must be recorded before its first external effect and remain accounted for until all database/provider work completes, including deferred work. A process death or lost completion leaves an uncertain operation. Lease expiry, an empty PostgreSQL activity snapshot or elapsed function time must not silently classify it as drained. Unknown provider effects require reconciliation against their existing idempotency keys before a deliberate retry.

The migration fence must close both controls for affected writers, reject all historical credentials/code that lack the protocol, and prove zero active **and uncertain** affected operations. A cooperative check only in the new private-DB client is insufficient: old deployments bypass it, and a provider call may occur between database operations. Revoking a database login or disabling a project/scheduler alone is also insufficient.

Use an observation budget of 300 seconds for an initial drain attempt, matching the explicitly configured shipping-rate/HighLevel function limits and the customer-email worker's five-minute default lease. This is a maximum wait before refusing, not a universal platform limit or proof of completion. Observe actual operation/lease/provider outcomes; any unresolved work at the deadline leaves the fence closed and SQL unstarted. Longer stock reservations remain business obligations rather than running worker leases and must be preserved. The existing 12-second gateway transport deadline/13-second gateway drain remains specific to gateway requests. C07 observed a cron completion 17.875 seconds after disabling schedules, so its old 16-second wait cannot be reused as a frontend writer-drain proof.

Before live implementation is enabled, bind the admission storage, historical-credential retirement and bootstrap mechanism to the reviewed source/target and prove them on an owned database. The initial admission rollout itself must not depend on applying uncoordinated pending application SQL. An adapter that merely returns a success-shaped JSON object is not a fence.

## Failure and recovery

1. Validate source, complete lineage, exact pending chain, artifact, target and recovery before mutation. Plan mode acquires no credentials and performs no provider/database calls.
2. Record exclusive intent before fencing or provider calls. A reused action/result directory refuses.
3. Under both locks, stop new work, retain safe recovery while it drains, then fence affected recovery and prove the drain. Persist original observations.
4. Apply each reviewed forward migration once; persist full database verification before attempting deployment. Retain both locks while building/verifying/promoting the exact compatible frontend. Check lock/session liveness before each provider mutation; a lost connection makes that stage uncertain.
5. On failure or process death, keep dependent admission closed. Preserve successful SQL and original receipts. Inventory actual database/deployments/aliases/provider effects before a new reviewed recovery action. Never infer rollback safety from the previous application's existence.
6. Verify terminal cleanup before deliberate restoration. Restore only qualified producers and the explicitly selected admission profile. Keep all six rollout capabilities independent and do not enable unfinished features. Interrupted restoration is a failed/uncertain action, not a reason to auto-resume.

## Completion evidence still required

The locked migration continuation and source inventory are foundational changes. P2-00 is not complete until a real admission implementation and its historical-deployment bootstrap, same-environment-lock parent coordinator and deliberate restoration/reconciliation path pass owned-database end-to-end fault tests. Required cases include concurrent release attempts, capture/callback in flight, delayed workers, process death, drain timeout, successful SQL followed by failed or uncertain deployment/promotion, and interrupted restoration. Live staging use needs a separately reviewed exact candidate and plan; existing C07 approval does not authorize this new release.

## Verified foundation

The [source inventory](baselines/2026-11-03-p2-00-foundation/source-inventory.json) covers 55 route files/61 exported HTTP methods, 50 exported actions across seven modules, two deferred-work sites and six direct database constructors across application/maintenance source. It includes nine ordinary native definitions and the alternative qualification probe. Every entry still requires producer classification and a matching actual deployment inventory.

The [validation record](baselines/2026-11-03-p2-00-foundation/validation.json) retains 163 passing platform tests, the 20-test focused subset, 27 existing host coordinator/migration regression tests and owned PostgreSQL16/18 results (14 checks each). The real database tests demonstrate competing-session lock refusal during continuation, release after cleanup and committed SQL preservation after an injected continuation failure. ESLint and diff checks passed. These checkout fixtures do not qualify a new immutable image, live deployment, whole-operation fence or process-death recovery.

Read-only [staging project metadata](baselines/2026-11-03-p2-00-foundation/staging-deployment-observation.json) returned 25 retained deployments, seven marked READY, including the active candidate and six older deployments. The returned project pagination was exhausted. Metadata does not prove that a URL is reachable, which database/provider credentials it retains, or that all shared-database producers belong to this project. Those bindings and actual fencing remain unverified; no retained deployment was removed, paused or reconfigured.

The [PR #68 review validation](baselines/2026-11-03-p2-00-review/validation.json) records two addressed findings: idle PostgreSQL connection errors now retain a sanitized failed terminal outcome, and default-exported server actions retain their public export name in the inventory. Updated checkout verification passed 165 platform tests, ESLint and diff checks, plus 15 checks each on owned PostgreSQL16/18 fixtures, including actual backend termination during continuation. The original foundation evidence above remains historical; these review fixes do not complete P2-00 or change live staging.

PR #68 was approved and merged into `staging` at `82b758a52aa1ce780ca2c8788ba120fb71ac48db`; all ten CI jobs passed on its reviewed head `b2bb73e95e1c6f9c97d5cb3aedf05036b523f53d`. The next [durable admission ledger](frontend-admission-ledger.md) implements separate new-work/recovery controls, committed operation admission, deferred-work accounting and non-expiring active/uncertain records on owned databases. Its [validation](baselines/2026-11-03-p2-00-admission/validation.json) records 170 platform tests and 14 admission checks on each of PostgreSQL16/18, alongside the 15 migration checks. Application wiring, historical-deployment fencing/bootstrap, full producer drain and the parent release/restoration coordinator remain required; the ledger cannot authorize live migration or admission.
