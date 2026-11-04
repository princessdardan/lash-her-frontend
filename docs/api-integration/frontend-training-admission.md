# Training checkout writer admission

P2-00 component only. This extends the [product checkout adapter](frontend-writer-route-admission.md) to three training entrypoints. Admission remains disabled by default and no live settings, database bootstrap, grants or deployments were changed.

| Entrypoint | Class | Work covered |
| --- | --- | --- |
| `POST /api/training-checkout` | new-work | Enrollment reservation, primary card/Afterpay authorization/capture, and two-tender split payments. |
| `POST /api/training-checkout/square-invoice` | new-work | Square customer/order/draft creation, local pending order, publication and publication receipt. |
| `POST /api/training-checkout/split-status` | recovery | Authenticated-by-existing-reservation/email lookup and recovery of the same split order/payment IDs. |

## Policy and execution

The existing adapter validates the exact hosted/source/producer binding and requires the ledger and application `DATABASE_URL` to use the same reviewed direct host/port/database/login with verified TLS. See its configuration contract; there are no new credentials or configuration flags. It commits durable admission before invoking a handler or reading its body, and observes the current policy epoch on each request. Closing new work can preserve split recovery under the independent recovery control. Closing recovery also refuses before consuming the request body or invoking lookup/provider work.

All three handlers use awaited work, return non-streaming responses and retain their existing validation and business/provider idempotency keys. The adapter performs no automatic replay. An operation UUID identifies one execution, not a new financial attempt. In enforced mode a marked uncertain result, 5xx or thrown exception returns a sanitized 503 and remains unresolved in the ledger. Off mode retains the existing response codes and payloads.

## Domain uncertainty

The shared one-time payment core already marks caught authorization, finalization, compensation, capture and notification errors. This change additionally covers:

- notification recovery errors when a training payment is already locally recorded, even if the charger returns success;
- failed training reservation cleanup behind a payment-rejected response;
- invoice errors caught as HTTP 400, BNPL-unavailable 422 or publication 502 after provider/local initialization begins;
- split-payment errors caught and compensated inside the model, and explicit capture-pending, cancellation-pending or manual-review outcomes without a thrown error.

These markers are operation-local and conservative. An authorization error successfully compensated later in the same execution still needs owner review. A known declined payment followed by confirmed cancellation, without an exception or pending outcome, retains its normal 402 and completes that execution. Failed or lost provider acknowledgements do not establish that no charge occurred; clients and operators must retain the original reservation and payment IDs before retry/reconciliation.

Split provider observations now await both concurrent reads with `Promise.allSettled`. If either fails, cancellation/recovery and operation settlement wait until its sibling finishes. Cancellation already awaits both compensation attempts. A blocked or failed request cannot silently leave an untracked sibling observation running behind a completed execution.

Successful business recovery uses a new admitted recovery execution and the existing Square idempotency keys. It does not reconcile the original uncertain execution automatically. Owner reconciliation remains a separate action, with both controls closed and evidence accounting for actual effects and possibly running processes. No lease expiry or successful callback alone establishes all-writer drain.

## Validation and limits

The [validation record](baselines/2026-11-04-p2-00-training-admission/validation.json) records tests of actual handlers/models through the adapter, with injected ledger/business/provider dependencies. Cases cover pre-body refusal, admission before reservation, original keys, invoice initialization/publication failures, caught cleanup/notification failures, a lost committed capture acknowledgement, recovery without new authorization, a rejected observation with its sibling still running, and known cancelled payments.

Owned PostgreSQL16/18 rerun the inherited actual-adapter protocol checks (eight), alongside 14 ledger, 11 historical-login and 15 migration checks each. Those disposable SQL fixtures verify the ledger protocol; they do not perform real Square calls or prove the combined training Drizzle/provider flow under enforced admission. Existing application database/browser checks run in CI with admission off. No live image, producer or bootstrap is qualified here.

PR #71 was reviewed, its separate application/ledger target-binding finding was fixed, and all ten CI jobs passed on `a56ba79095d146b68cbb92300c579117855418e0` ([run](https://github.com/princessdardan/lash-her-frontend/actions/runs/41780149115)). It merged into staging at `f01c728dea14b51b1b339beea500cf13de82f789`.

The [consent recovery continuation](frontend-consent-recovery-admission.md) covers Resend/HighLevel webhooks and unsubscribe POST. Other booking/payment/webhook, GET mutation, admin/form/action and worker entrypoints remain unwired. Historical deployment/provider fencing, exhaustive writer/deferred-work coverage, initial live bootstrap and the parent migration/deployment/recovery coordinator remain unfinished. The two operation classes do not establish provider finality or authorize SQL. Pending frontend SQL stays disabled, Fresha/410 reservation closure stays in force, and live staging/production are unchanged. P2-00 remains in progress.
