# Square refund recovery admission

Status: source component only; admission remains disabled by default. P2-00 remains incomplete. No deployment, live database/provider change, bootstrap, pending SQL or admission enablement is authorized.

## Selected boundary

`POST /api/webhooks/square` admits only events parsed as verified refunds. Environment resolution, the existing 64,000-byte body cap, exact raw-body signature verification and event parsing run before this dispatch. Those steps do not persist refund data or invoke a payment provider. Invalid signatures/payloads retain their existing responses without ledger entries. A closed recovery control rejects a verified refund before its first database effect, but its request body has already been consumed. The entire Square route is not fenced by this component.

The production route supplies the shared recovery adapter to the handler factory. The ordinary factory defaults to direct execution for existing callers/tests; the production route wiring is covered by a fail-closed configuration test. Enforcement retains current source/producer, direct database/login and strict TLS binding. New-work closure does not close refund recovery. Ledger arguments contain execution identity and bindings, not refund payloads, identifiers, signatures or request data.

Admission spans these awaited operations:

1. Insert the existing sanitized refund receipt, deduplicated by provider event ID.
2. For a completed refund, reconcile the matching product refund using the original payment ID, refund ID, amount and currency.
3. Await the reconciliation transaction and any durable finance-alert outbox enqueues it creates.

Duplicate receipts still run reconciliation, preserving recovery after a receipt committed but later reconciliation failed. Pending/failed/rejected refund evidence does not trigger completed-refund settlement. A reconciliation result of `false` retains its existing meaning: no automatic match, including booking refunds and durably recorded manual-review outcomes. It is not itself an infrastructure failure. No refund issuance/provider charge is introduced.

The finance-alert fan-out now waits for all recipient enqueues before propagating the first failure. An early rejection cannot settle admission while a sibling enqueue is still running. Existing recipients, payloads, encryption and outbox idempotency keys are preserved. Email delivery workers remain separate executions outside this boundary.

Caught persistence/reconciliation failures return 5xx; the shared adapter retains uncertainty and returns a sanitized retryable 503. Lost settlement acknowledgements or connection loss do not replay effects or acknowledge success. Process death/unresolved work still requires deliberate owner reconciliation; elapsed time cannot prove drain. Off mode retains the existing status/body behavior and business idempotency.

## Inventory and excluded Square branches

The [merged inventory](baselines/2026-11-04-p2-00-square-refund/merged-source-inventory.json) was regenerated from `cba79302942f19117a959fbbb32a900147517016`: 55 route files, 61 HTTP exports, 50 actions across seven modules, zero inline actions, two deferred sites, seven direct PostgreSQL constructors, and ten schedule definitions (nine ordinary plus the alternative qualification probe). Its source manifest matches the PR #73 handoff. The [classification](baselines/2026-11-04-p2-00-square-refund/writer-classification.json) distinguishes reads, GET mutations, workers, actions, closure exports, external state, manual scripts and existing opt-in adapters. It conservatively retains admin read paths whose authorization can audit denials or resolve identities. Source classifications do not establish live producer inventory or an exhaustive fence.

Whole-route admission was deferred because the audit found distinct remaining obligations:

- Invoice, commerce, training split, booking, no-show and operational-payment paths require their own transitive outcome/effect qualification.
- `isKnownNoShowChargeEvent` concurrently starts database lookups with fail-fast `Promise.all`; a rejected lookup can return before siblings finish. Dynamic-import fan-outs are separate from business effects.
- Booking finalization catches scheduling-alert errors, and booking/no-show result paths can acknowledge non-finalized or retryable work. They need explicit domain uncertainty decisions.
- Operational-payment observation catches cancellation errors. An observed result alone does not establish a known provider outcome.

Those paths remain unchanged and unqualified. This component cannot be used to claim Square-wide drain. Other route/action/worker admission, exhaustive deployment/provider fencing, owned bootstrap, the parent lock-retaining release coordinator and deliberate restoration remain P2-00 requirements. Fresha/410 public reservation closure stays in force; all six rollout capabilities remain independent.

## Validation limits

The [validation record](baselines/2026-11-04-p2-00-square-refund/validation.json) binds the candidate source hashes and executed checks. Handler tests exercise actual signature verification and dispatch with controlled persistence/ledger dependencies. The alert regression exercises the real fan-out and encrypted outbox enqueue with controlled transaction queries. Owned PostgreSQL16 checks exercise the inherited actual adapter/ledger protocol, not a combined real refund Drizzle transaction under enforcement. CI's ordinary business database/browser paths run with admission off. PostgreSQL18 and full build/browser results must be taken from exact-head CI; the prior session's results do not qualify this candidate.
