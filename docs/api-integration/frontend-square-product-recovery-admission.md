# Square product-payment recovery admission

Status: source component only. Admission remains disabled by default; P2-00 remains incomplete. This component authorizes no live deployment, database/provider change, bootstrap or pending-SQL release.

## Boundary and awaited work

Signature-verified `payment.*` events classified as local Square product orders enter recovery admission after the read-only order lookup and before the recovery service. Body limits, raw signature verification, parsing and classification precede admission. Classification reads still occur while recovery is closed. Training-card/split, booking, no-show and operational-payment branches remain unqualified; the existing refund and training-invoice adapters stay independent.

The production route supplies the product adapter. Factory callers retain direct execution by default. Separate new-work/recovery controls, source/producer/target/login/TLS bindings and retryable sanitized admission failures use the existing protocol. No event, payment or order identifiers enter ledger arguments.

The operation awaits the real recovery service, including:

1. Product finalizer transaction: locked order/obligation checks, amount/currency/payment identity verification, idempotent money-ledger insertion and paid transitions.
2. Tracked-stock commit and automated shipment activation, or the late-capture money record plus compensating refund reservation.
3. Product notification preparation and the atomic email claim/outbox transaction. Independent email/refund/shipment workers remain separate producers.

Only database effects occur in this selected business chain. Module-import fan-outs finish before invocation and launch no detached business work. Outbox insertion and refund reservation are durable obligations; they do not prove provider delivery/refund settlement or worker drain. The historical `late_capture_refunded` result means a refund was reserved, not that Square settled it. Noncompleted payment events perform no finalization. Applied and already-applied recoveries retain existing idempotency; terminal late captures do not create a success email.

## Uncertain outcomes

- A product recovery conflict retains uncertainty under enforcement. Ordinary terminal-conflict 200 responses remain unchanged with admission off. A captured payment whose finalizer declined to apply cannot establish a clean drain.
- Null atomic/fallback notification claims cannot distinguish prior completion from an interrupted claimant. They mark admitted work uncertain.
- A false outbox enqueue result means no new insert was confirmed. Existing deduplication alone is not a verified matching handoff; the atomic and fallback paths mark admitted work uncertain.
- A stock commit whose conditional inventory UPDATE returns no row marks admitted work uncertain. The movement record and remaining business work keep their existing transaction behavior; a movement alone does not prove the counters changed.

Markers remain inert outside an admitted operation. All awaited work finishes before the operation-local context refuses completion. Business transactions that committed remain committed; there is no automatic replay or rollback. This conservative implementation can refuse a valid already-sent/already-queued duplicate under enforcement. Owner reconciliation is required; a new request's success cannot clear the earlier uncertain ledger record. Precise terminal-state reconciliation remains future work.

Thrown failures, retryable recovery results, connection loss and lost settlement acknowledgement remain retryable 503 outcomes under admission, without replaying effects. Process death retains an unresolved ledger operation. No elapsed-time or empty-activity inference establishes drain.

## Evidence and limits

The [effect audit](baselines/2026-11-04-p2-00-square-product/effect-audit.json), regenerated merged/candidate writer inventories, complete method/action/script classification and [validation record](baselines/2026-11-04-p2-00-square-product/validation.json) bind this component to source hashes.

Route tests use actual signature dispatch, the admission adapter and recovery service with controlled ledger/finalizer/outbox terminals. Owned PostgreSQL16 regressions exercise the actual stock and atomic outbox uncertainty markers and existing product finalizer persistence. Separate owned TLS checks qualify inherited migration/ledger/adapter protocols. These are not a combined product webhook with real ledger and business database under enforcement, a new immutable runtime, or a live provider/drain qualification.

Actual deployment/provider inventory and fencing, all remaining routes/actions/workers, historical bootstrap and the parent lock-retaining release/recovery coordinator remain required. All six feature controls and Fresha/410 closure stay unchanged. Live pending frontend SQL remains refused. Full build/browser/PostgreSQL18 evidence must come from this candidate's own CI.
