# Square booking browser-return recovery admission

Status: disabled-by-default P2-00 source component. This component does not enable admission, pending frontend SQL or a live release. P2-00 remains incomplete.

## Boundary

The GET at `/api/booking/square/return` enters recovery admission after local URL/query parsing and before Square lookup or business persistence. It awaits the existing payment finalizer, paid/failed observations, operational appointment projection, Calendar discovery/insertion, Redis lock cleanup, customer/provider notifications and their acknowledgements. Query identifiers remain lookup hints; they do not prove payment. The resolved local order must match an explicit local order hint, and the existing payment/order/tender identity and financial checks remain in force.

The finalizer returns its verified status inside admission. The Next.js redirect to `/booking/confirmation` runs only after successful settlement, outside the admitted task. Next's redirect exception cannot incorrectly mark completed business work uncertain. The normal redirect status, destination, query aliases and admission-off error redirect remain unchanged.

A closed recovery policy, invalid admission configuration, uncertain domain result, caught finalization error, lost ledger socket or lost settlement acknowledgement produces a sanitized, retryable 503 with `no-store` and no redirect. The handler awaits all started work before returning; it does not retry effects in the same execution. A later request cannot clear an earlier uncertain operation. Closing new work does not close recovery.

Missing or conflicting lookup evidence, authorization-only payments, manual/deferred Calendar outcomes, unavailable notification proof and unresolved cleanup remain uncertain. Known provider-pending observations or fully persisted unpaid observations may finish and redirect with the existing `unpaid` status. Unresolved return requests remain conservative review obligations; this component does not qualify their operational reconciliation or live enablement policy.

## Verification and limits

The [validation](baselines/2026-11-04-p2-00-square-booking-return/validation.json), effect audit, merged/candidate inventories and writer classification bind the component to source. Browser-return tests use the actual route handler, admission runtime, Square finalizer, booking/Calendar orchestration and customer/provider notification orchestration with controlled ledger/database/provider terminals. They exercise query aliases, independent closure, every awaited effect stage, caught failures, missing/local-order conflicts, pending/manual outcomes, lost acknowledgements, production route wiring and the real Next.js redirect exception after settlement. Existing webhook regressions remain covered.

These checks do not prove a combined actual browser-return/TLS-ledger/business-database enforcement flow, actual provider delivery or runtime drain. The prior ordinary-booking component's actual PostgreSQL repository evidence remains separate; its repositories and the admission protocol are unchanged. Exact-head CI remains required.

Independent payment initiation, confirmation, admin/reconciliation/worker executions, actual producer/provider inventory, historical fencing/bootstrap and the parent release/restoration coordinator remain open. All six controls and Fresha/410 reservation closure remain unchanged. No live settings, provider configuration or database records are changed by this source component.
