# Booking-outcome email retry recovery admission

Status: disabled-by-default P2-00 source component. Admission, pending frontend SQL and live release settings remain disabled. P2-00 remains incomplete.

## Selected boundary

The authenticated GET at `/api/admin/payment-reconciliation` supplies recovery admission around its booking-outcome email retry batch. Admission precedes the retry-list query, customer/provider claims, notification requests, correction loops and sent/failure receipts. Every selected effect and later hold in the admitted batch finishes before settlement. Closing new work leaves recovery available; closing recovery refuses a new email batch before its list query.

This is a subtask boundary, not whole-route admission. The service reconciliation monitor runs before it, and commerce capture reconciliation runs afterward. Those independent paths retain existing behavior and remain unqualified. An email admission failure does not skip the commerce subtask or authorize either sibling. Direct callers of the email helpers also need their own boundary.

Caught per-hold failures mark the batch uncertain while preserving its existing sequential processing of later holds. A failed summary, ambiguous/busy/missing claim, manual booking projection, lost ledger socket or lost settlement acknowledgement cannot establish successful completion. Caught customer/provider failures retain uncertainty even if cleanup rejects without an error value and the legacy helper consequently returns a success-shaped result. All already-started work is awaited; the adapter does not replay effects.

An admission failure produces sanitized JSON with status 503, `Cache-Control: no-store` and `Retry-After: 30`, after the independent commerce subtask returns. Admission-off partial failures retain the prior logging and monitor-derived HTTP response. Existing customer/provider idempotency keys, durable sent receipts, cron authentication, batch limits and Fresha/410 reservation closure are unchanged.

## Verification and limits

The [validation record](baselines/2026-11-04-p2-00-booking-outcome/validation.json), effect audit, source inventories and writer classification bind this component to source. Tests exercise the actual route handler, admission runtime, batch loop, customer/provider notification orchestration and claim repositories with controlled database/provider terminals. They cover authentication before admission, closure at nine batch stages, later holds, correction loops, caught and undefined cleanup rejections, ambiguous/sent claims, lost acknowledgements, empty batches, monitor-failure isolation and production route wiring. The undefined-cleanup regression failed against the original email source with HTTP 200 instead of 503, then passed after the uncertainty fix.

Shared booking regressions also exercise actual provider recipient fan-out against controlled HTTP responses. Source fixtures do not prove a combined actual cron/TLS-ledger/business-database flow, provider delivery or runtime drain. The unchanged ledger and repository components retain their earlier separate evidence. Full exact-head CI remains required.

Service/commerce reconciliation, independent payment initiation/confirmation/admin/worker executions, actual producer/provider inventory, historical fencing/bootstrap and parent release/restoration coordination remain open. No live provider, database, credentials, scheduler, admission, pending SQL or six rollout-control changes are made by this component.
