# Square ordinary-booking webhook recovery admission

Status: disabled-by-default P2-00 source component. P2-00 remains incomplete. This change does not enable admission, pending frontend SQL or a live release.

## Boundary and effects

After raw signature verification, parsing, existing refund/invoice/commerce/no-show/operational dispatch and event-type gating, the remaining `payment.created`, `payment.updated` and `order.updated` booking path enters its own recovery adapter. Admission precedes the event claim and remains active through Square payment/order retrieval, local paid/failed observation transactions, appointment projection, Redis locks and their cleanup, Calendar discovery/availability/insertion, customer/provider email claims and delivery, durable notification receipts, event processing and awaited alerts. Classification reads remain outside the adapters.

Calendar availability requests, provider recipient sends and the provider-email transaction's sibling queries now await every started promise before propagating a rejection. Calendar insertion is explicitly awaited before releasing its lock. Caught Calendar, lock acquisition/release and admin-alert failures retain operation-local uncertainty. No new charge, authorization, capture, refund, schedule or detached task is introduced.

A repeated hosted-payment observation merges its Square metadata into the existing JSON instead of erasing booking and notification receipts. Existing provider identifiers, idempotency keys and business transitions are retained. The repository factory accepts an optional database resolver for isolated testing; production still uses the existing private database.

## Completion and uncertainty

- A completed, matching payment with a persisted booked outcome, awaited notification work and event receipt may complete. A processed duplicate must resolve a paid appointment order and terminal hold with Calendar correlation; its notification recovery remains inside admission.
- Customer/provider claims distinguish a durable sent receipt from an active claim, absent target or ineligible appointment. Existing sent receipts allow replay without sending again. A missing or non-booked projection remains uncertain even when an old email receipt exists. Missing notification mutation targets and an unavailable customer sent acknowledgement cannot establish completion.
- Unknown/missing payments or orders, binding/amount/currency/purpose mismatches, authorization-only paid results, pending verification, missing holds, unavailable failed-payment writers and guarded zero-row writes retain uncertainty. A provider-confirmed `PENDING` observation or fully persisted terminal unpaid observation may complete; ambiguous terminal replay is conservatively unresolved.
- Manual follow-up, rebooking and deferred Calendar results remain uncertain even if legacy domain code reports `finalized` or persists a processed receipt. A caught provider/database/cleanup error remains uncertain even when concurrent recovery has since booked the hold.
- All observer/finalizer errors and their alerts are awaited. Uncertainty, lost admission sockets and lost settlement acknowledgements return retryable 503 under enforcement. Effects are not replayed inside the same execution, and a later retry does not clear an earlier uncertain operation.

Admission-off HTTP acknowledgements and legacy result shapes remain unchanged. Closing new work preserves recovery; closing recovery refuses new ordinary booking executions before event claiming or provider work, while admitted executions remain accounted for until awaited work finishes. The ledger receives operation/binding identities without booking, customer or payment payload data.

## Verification and limits

The [validation](baselines/2026-11-04-p2-00-square-booking/validation.json), [effect audit](baselines/2026-11-04-p2-00-square-booking/effect-audit.json), merged/candidate inventories and complete writer classification bind this component to source.

Signed route tests use the actual admission adapter, Square finalizer, booking finalization/lock logic and customer/provider notification orchestration with controlled ledger, database and provider terminals. They hold each stage across closure, exercise caught failures, manual/pending/mismatch/duplicate results and lost acknowledgements, and verify production route wiring and admission-off responses. Separate isolated PostgreSQL16 tests apply all 80 migrations and exercise the actual hosted observation/projection and customer/provider receipt repositories, replay, active claims, missing targets and stale projection evidence.

These are separate route/protocol and business-database checks. They do not prove the actual webhook, TLS admission ledger and business database as one combined enforcement flow, or actual provider delivery/runtime drain. Inherited protocol evidence remains separate. Exact-head build/browser/PostgreSQL18 CI is required for this candidate.

Browser returns, independent initiation/admin/reconciliation/worker executions, actual producer/provider inventory and historical fencing, bootstrap and the parent coordinator remain open. Shared helper changes do not admit those independent executions. All six controls and Fresha/410 reservation closure remain unchanged; P2-00 stays incomplete.
