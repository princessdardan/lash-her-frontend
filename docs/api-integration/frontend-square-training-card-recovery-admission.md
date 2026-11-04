# Square training-card recovery admission

Status: disabled-by-default source component. P2-00 remains incomplete. No live deployment, database/provider change, bootstrap, admission or pending-SQL enablement is authorized.

## Boundary and effects

Signature-verified `payment.*` events classified by the local order as `training_square_card` enter independent recovery admission after the read-only classification lookup. Body limits, raw signature verification, parsing and classification precede admission; closed recovery still permits classification SELECTs. The existing product, refund and invoice adapters remain independent. Split-payment, booking, no-show and operational-payment branches remain unqualified.

Admission awaits the actual commerce recovery service and its training-card chain:

1. The locked checkout-order transaction verifies amount/currency and payment identity, then applies or deduplicates the paid transition. Training-card payment identity lives on the checkout-order row, without a product money-ledger row.
2. Pending enrollment lookup and scheduling-token lookup/conditional assignment.
3. Notification claim, sequential student/staff Resend sends, sent-state updates and any collected failure record.

Noncompleted payments skip finalization. Duplicate paid events still recover missing notifications; both already-sent flags on a real pending enrollment provide positive evidence and skip token mutation/sends. Enrollment creation belongs to checkout and is not inferred or replayed by this recovery path. No new charge, refund, Calendar effect, outbox/CRM enqueue or detached work is added. Provider notification calls are awaited with existing per-order idempotency keys.

The production route supplies the new adapter; factory callers keep direct execution by default. The shared current-epoch, source/producer/target/login/TLS protocol applies. Ledger arguments contain bindings and operation identity, without order/payment/event identifiers or private payloads. Closing new work does not close independently admitted recovery.

## Uncertainty and compatibility

The notification helper's pending-only enrollment query cannot distinguish an already-scheduled/consumed enrollment from missing recovery work. A null result now marks operation-local uncertainty rather than proving completion. Ordinary callers still receive the existing no-op. A valid scheduled duplicate may conservatively require owner reconciliation under enforcement; the helper does not create an enrollment, change scheduling state or resend email from this ambiguity.

Training-card finalization conflicts now also mark uncertainty under enforcement, preserving ordinary terminal-conflict acknowledgements with admission off. Existing shared notification markers retain uncertainty for unavailable claims and false sent-state persistence. Thrown/token/provider failures and retryable results remain 503 outcomes. Collected email failures are recorded only after both sequential recipient paths finish. Lost connection/settlement acknowledgement and process death do not authorize replay or drain; committed business state remains committed. A later request's success cannot clear an earlier unresolved ledger operation.

The helper accepts explicit terminal dependencies for verification; production retains the same default store and email functions. The existing source behavior and payment/provider keys remain unchanged outside admission.

## Evidence and remaining work

The [effect audit](baselines/2026-11-04-p2-00-square-training-card/effect-audit.json), regenerated merged/candidate inventory, complete method/action/script classification and [validation record](baselines/2026-11-04-p2-00-square-training-card/validation.json) bind this component to reviewed source.

Route tests exercise actual raw signature dispatch, admission adapter, commerce recovery service, notification helper and shared sequential email service with controlled ledger/finalizer/store/provider terminals. Owned PostgreSQL16 verifies the actual paid transition and actual missing/scheduled/fully-notified enrollment query outcomes. Separate owned TLS checks qualify inherited ledger/migration/adapter protocols. These are not a combined real webhook/ledger/business-database flow under enforcement, actual provider delivery, a new immutable runtime, or deployment/worker drain.

Historical producer/provider inventory and fencing, all remaining writers/workers, owned bootstrap and the parent lock-retaining release/recovery coordinator remain open. All six rollout controls and Fresha/410 closure stay unchanged. Live pending frontend SQL remains refused. This candidate needs its own full build/browser/PostgreSQL18 CI results.
