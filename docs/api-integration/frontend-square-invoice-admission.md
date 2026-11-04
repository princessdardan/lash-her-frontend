# Square training invoice recovery admission

Status: source component only. Admission remains disabled by default; P2-00 remains incomplete. No deployment, live database/provider settings, bootstrap, pending SQL or admission enablement is authorized.

## Boundary

`POST /api/webhooks/square` adds recovery admission only for signature-verified `invoice.payment_made` events whose local order is a Square training invoice. The existing refund adapter remains independent. Body limiting, exact raw signature verification, parsing, invoice-ID extraction and a read-only order lookup precede the new effect boundary. A closed recovery control still permits that classification SELECT; this component does not fence all SQL reads or the entire Square route. The finalizer repeats its own order lookup inside admission and verifies the authoritative Square invoice/order before finalization.

Admission starts before the receipt claim and awaits:

1. The sanitized event insert or existing receipt lookup.
2. Square invoice/order GETs and validation against local invoice, customer, correlation, amount, currency and payment identity.
3. The paid transition, idempotent enrollment creation, scheduling-token lookup/assignment and enrollment reload, or duplicate notification recovery.
4. The email claim, sequential customer/staff sends and their persistence/failure records. Existing Resend idempotency keys remain unchanged.
5. The processed-event update after an acceptable finalizer result.

There is no new charge, invoice publication, refund issuance, Calendar effect, CRM enqueue or detached/deferred callback in this selected chain. Dynamic-import fan-outs load modules; the business operations are awaited. Receipt deduplication does not skip recovery: both `received` and `processed` duplicate events still call the finalizer and recover missing notifications. Independent callers, delivery webhooks, administrative retries and workers are separate executions.

The production route supplies the adapter; ordinary factory callers retain direct execution by default. Independent recovery remains available with new work closed. Existing shared source/producer/database/login/TLS binding applies. Ledger arguments contain operation identity and bindings, without invoice/event identifiers, signatures, payloads or email data.

## Outcome audit and fixes

Three confirmed gaps were fixed sequentially, each with a failed-before/passed-after targeted regression:

- A null notification claim previously returned normally even with pending notifications. Another claim or concurrent state change is not proof of completion. It now marks an admitted operation uncertain.
- Email delivery previously ignored `false` from either notification persistence method. Each unconfirmed write now marks an admitted operation uncertain, while the remaining awaited notification work still finishes.
- Duplicate finalization with no pending enrollment previously appeared complete. The pending-only query excludes scheduled/consumed enrollments and cannot distinguish them from a missing enrollment after interruption between marking paid and creation. It now conservatively marks an admitted operation uncertain. This can refuse a legitimate already-scheduled duplicate under enforcement; owner reconciliation is required rather than inferring success from absence. It does not create an enrollment or resend an email from that ambiguity.

These markers are inert outside the operation context, preserving admission-off responses and business behavior. They also apply when other admitted training callers reach the shared notification service; they do not qualify those callers' remaining effects. Existing exceptions, failed finalization and explicit notification failures already produce retryable 5xx. The adapter preserves them as uncertain and returns a sanitized 503. Lost settlement acknowledgement, connection loss and process death cannot silently complete an operation or trigger automatic replay.

The ordinary processed-event update can still occur after a success-shaped result carrying operation-local uncertainty. That receipt status is not a completion/drain receipt: admission subsequently refuses acknowledgement and retains uncertainty, and provider retries still invoke recovery even for a processed duplicate. This preserves existing receipt semantics without using them as migration authority.

## Source inventory and exclusions

The [merged inventory](baselines/2026-11-04-p2-00-square-invoice/merged-source-inventory.json) was regenerated from `63de9cdc7ea3e0b436a9cf54d2e77e846e86f56e`; its manifest matches PR #74's reviewed candidate. It contains 55 route files/61 methods, 50 actions across seven modules, zero inline actions, two deferred sites, seven direct constructors and ten schedule definitions. The [classification](baselines/2026-11-04-p2-00-square-invoice/writer-classification.json) covers every method/action and retains 21 source-bound operational script classifications. The [candidate inventory](baselines/2026-11-04-p2-00-square-invoice/candidate-source-inventory.json) binds this component's final source. These files are review inputs, not an admission allowlist or actual deployment inventory.

Commerce, training split, booking, no-show and operational-payment webhook branches remain unqualified. Unknown/nontraining invoice events retain existing fallback dispatch outside this component. The no-show concurrent lookup, booking caught outcomes and operational cancellation uncertainty listed in the refund review remain open. Other writers/actions/GET mutations/workers, exhaustive deployment/provider fencing, owned bootstrap and the parent lock-retaining release/recovery coordinator remain required. All six rollout capabilities remain independent; Fresha/410 reservation closure stays in force.

## Validation limits

The [validation record](baselines/2026-11-04-p2-00-square-invoice/validation.json) binds executed checks and source hashes. Admission tests use actual raw signature dispatch and the actual adapter with controlled ledger/business dependencies. Finalizer regressions exercise the real finalizer and notification service with terminal database/provider dependencies controlled. The [effect audit](baselines/2026-11-04-p2-00-square-invoice/effect-audit.json) records the reviewed chain and its limits.

Owned PostgreSQL checks qualify the inherited ledger/adapter protocol, not combined real invoice business persistence under enforcement. Ordinary CI business database/browser flows run with admission off. No real provider delivery, exhaustive producer/worker drain, new immutable runtime qualification, live bootstrap or migration authority is claimed. Full build/browser and PostgreSQL18 results must be verified on this PR's exact-head CI; earlier PR results do not qualify this source.
