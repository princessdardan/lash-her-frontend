# Square no-show recovery admission

Status: disabled-by-default P2-00 source component. P2-00 remains incomplete; this change enables neither live admission nor pending frontend SQL.

## Boundary

Signature-verified `payment.created`, `payment.updated` and `invoice.payment_made` events enter a separate recovery adapter after the existing no-show reference classification succeeds. Body limits, exact raw HMAC verification, parsing and SELECT-only classification remain outside admission. Classification now awaits every invoice/payment/order lookup even if a sibling fails. Closed recovery refuses before the finalizer's first write or provider read. Existing commerce, invoice and refund adapters remain independent; ordinary booking and operational-payment observation still need their own qualification.

The admitted callback awaits the actual no-show finalizer through duplicate/record lookups, authoritative Square payment/invoice reads, provider invariant checks, atomic terminal record/attempt/event persistence or ignored-event persistence, and alerts. It does not initiate a new charge, capture, refund, cancellation, invoice publication, Calendar operation or detached task. Failure and unknown-event alerts are explicitly awaited; the current production logger writes local sanitized diagnostics.

## Outcomes and lifetime

- A durable successful finalization, confirmed failed charge, matching terminal duplicate or ordinary nonterminal ignored receipt can finish the operation.
- Missing records/references after positive classification, conflicting terminal state, provider 404 and financial/provider mismatches mark operation-local uncertainty. An ignored financial receipt remains uncertain on replay; its duplicate response cannot hide the unresolved result.
- A replayed `processed` receipt establishes completion. A `failed` receipt also requires a failed/canceled event; an `ignored` receipt requires a nonterminal event. Other receipt states remain uncertain. This preserves successful and confirmed-failure duplicate behavior without treating every stored event as completion evidence.
- Thrown errors, explicit retryable results, unfinished non-ignored results and success-shaped results with a domain uncertainty marker retain an unresolved operation and return retryable 503 under enforcement.
- Closing recovery stops new entries and lets admitted work finish. Lost ledger/socket/settlement acknowledgements do not replay effects in that execution. Later success does not automatically reconcile an earlier uncertain operation.

Admission-off HTTP acknowledgements and business transitions remain unchanged, including the legacy fallback when the finalizer returns an unmatched ignored result. Under enforcement, that missing match remains uncertain and cannot fall through into an unqualified booking branch. Existing provider identifiers and event keys are unchanged; no private order/payment/event payload enters ledger arguments.

## Verification and limits

The [validation record](baselines/2026-11-04-p2-00-square-no-show/validation.json), [effect audit](baselines/2026-11-04-p2-00-square-no-show/effect-audit.json), merged/candidate source inventories and complete writer classification bind this component to source.

Route tests exercise real raw-signature dispatch, the admission adapter and no-show finalizer with controlled ledger/repository/provider terminals. They hold provider reads, receipts, finalization and alerts across closure, and inject lost acknowledgements, failed lookups, malformed requests, provider mismatches and ambiguous replay. Disposable PostgreSQL16 tests use the actual repository and finalizer with controlled provider reads and operation-local context, proving committed terminal/ignored receipts and mismatch replay behavior.

The business-database checks do not combine the actual webhook, real admission ledger and application database under enforcement. Inherited TLS-ledger/migration protocols were not rerun locally for this unchanged protocol; their prior evidence remains separate. No actual Square delivery, new immutable runtime, live writer drain, historical fencing, bootstrap or parent coordinator qualification is claimed. Exact-head build/browser/PostgreSQL18 CI remains required. Admin no-show creation and independent reconciliation workers are separate executions. All six rollout controls and Fresha/410 closure remain unchanged.
