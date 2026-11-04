# Square training split-payment recovery admission

Status: disabled-by-default P2-00 source component. No live deployment, bootstrap, database/provider change, admission enablement or pending-SQL enablement is included. P2-00 remains incomplete.

## Boundary and effects

Signature-verified `payment.*` events classified by the local order as `training_square_split` enter a separate recovery adapter after the read-only classification lookup. Body limits, raw HMAC verification and parsing remain before admission. Closed recovery permits classification SELECTs and refuses before invoking the business recovery service. Product, training-card, invoice and refund adapters remain independent; service booking, no-show and operational-payment branches still need qualification.

The existing commerce recovery service skips noncompleted events. For a completed event, the split branch calls `chargeLiveTrainingSplit` with only the original local order reference. The event's one-tender amount does not finalize the full order. The live function loads the reserved full total and durable split state and holds the per-order transaction advisory lock through all awaited work:

1. Read the reservation and persisted split state; conditionally persist each recovery stage using the existing independently committed application connection.
2. Observe both existing Square payment IDs, awaiting both observations even if one fails. Validate order/reference, amount, currency and source type for each leg.
3. Complete the existing PayOrder using its original idempotency key and existing payment IDs, then complete those same payments if needed and verify both final observations. Interrupted authorization instead cancels known IDs and/or original authorization keys; both cancellation attempts are awaited.
4. Persist the paid checkout-order receipt and await pending-enrollment/token recovery, sequential student/staff email sends and persisted notification outcomes before releasing the per-order lock and settling admission.

The webhook supplies no fresh payment tokens. This recovery call cannot enter new-order or new-authorization branches, which require `input.payment`. A paid duplicate only recovers notifications. Enrollment creation belongs to checkout. No new refund, Calendar effect, outbox/CRM enqueue, scheduler claim or detached task is added. The independent split-status handler, checkout and reconciliation worker are separate executions; this adapter does not qualify that worker.

## Uncertainty and compatibility

The inherited split markers retain capture-pending, cancellation-pending, partial-capture/manual-review and caught-error uncertainty. Thrown exceptions and retryable recovery results remain unresolved admission outcomes. Missing/scheduled enrollment, unavailable notification claims and unconfirmed sent-state writes retain the shared notification uncertainty from the preceding components. A fully notified pending enrollment is positive completion evidence and needs no new token or provider send.

The existing mapping of all unsuccessful split results to retryable webhook responses remains unchanged, including confirmed cancellation. Closing new work leaves recovery independently available. Closing recovery does not cancel already admitted work. A lost ledger connection or completion acknowledgement produces 503 without replaying effects in that execution. A later successful recovery cannot reconcile an earlier uncertain operation automatically.

Admission-off responses, provider/payment keys and business state transitions are unchanged. Existing factory callers execute directly unless they supply the new adapter; the production route supplies it explicitly. Ledger arguments contain bindings and operation identity without order/payment/event identifiers or private payloads.

## Validation and limits

The [effect audit](baselines/2026-11-04-p2-00-square-training-split/effect-audit.json), regenerated merged/candidate inventories, complete writer classification and [validation record](baselines/2026-11-04-p2-00-square-training-split/validation.json) bind this component to source.

Route tests run the actual raw signature dispatch, admission adapter, commerce recovery service, split model and shared notification chain with controlled ledger, store and provider terminals. They cover closure, first/duplicate recovery, interrupted authorization, partial capture, held capture/completion/persistence/sends, sibling observation/cancellation lifetime, notification ambiguity and lost acknowledgements. Actual PostgreSQL16 tests cover the live split reservation, advisory-lock contention, durable paid receipt and duplicate missing/scheduled/fully-notified enrollment outcomes in mock-payment mode. Separate owned TLS fixtures exercise inherited admission/migration protocols.

These checks do not establish a combined real webhook/ledger/business-database flow under enforcement, actual Square/Resend delivery, a new immutable runtime or live deployment/worker drain. Exact-head build/browser/PostgreSQL18 CI remains required. Remaining writer/worker adapters, exhaustive actual producer/provider inventory and historical fencing, owned bootstrap and the parent release/recovery coordinator remain open. All six rollout controls and Fresha/410 closure remain unchanged.
