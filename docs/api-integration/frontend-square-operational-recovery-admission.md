# Square operational-payment recovery admission

Status: disabled-by-default P2-00 source component. P2-00 remains incomplete. This source change does not enable admission, pending frontend SQL or a live release.

## Boundary and effects

Signature-verified `payment.created` and `payment.updated` events with a parsed payment enter a separate recovery adapter after a SELECT-only lookup of the payment reference against a V2 operational hold. Classification deliberately does not require a valid active payment attempt: missing attempts and financial mismatches must be checked under admission. Body limits, raw signature verification, parsing, commerce/no-show dispatch and the classification lookup remain outside this boundary. Ordinary booking recovery remains unqualified.

The admitted operation awaits the actual observer's hold/attempt row locks, invariant checks and observation transaction commit. A matching completed payment records captured evidence in its own committed transaction before the local appointment projection, policy/no-show linkage, reservation conversion and audit writes. The two linkage writes now run sequentially on the same transaction/session. No Calendar request, email, new charge, new authorization, worker invocation or detached task is introduced.

The existing attribution-remediation branch is included in the same operation. It awaits the diagnostic alert, cancellation of the existing authorization when applicable, validation of the cancellation response, attempt terminalization and hold failure/refund-required writes. Thrown failures and caught cancellation failures cannot shorten this lifetime. Default remediation writers retain their existing business-state guards; an attribution mismatch remains uncertain even when remediation records a durable local outcome.

## Completion and uncertainty

- Matching observations of `APPROVED`, `PENDING`, `FAILED`, `CANCELED` and `DECLINED`, and fully persisted `COMPLETED` projection/replay, may settle as complete. Captured evidence is never downgraded by a late failure.
- Missing records/attempts or intent/amount/currency/customer mismatches after positive classification retain uncertainty. They cannot fall through to the unqualified ordinary-booking finalizer under enforcement. An actually unmatched classification preserves the ordinary booking path.
- Immutable payment-identity conflicts, any team-attribution remediation, unrecognized provider statuses and a failure/cancellation conflicting with captured evidence retain operation-local uncertainty despite an `observed` result. A missing active attempt on a failed/canceled replay is conservatively uncertain; no new durable receipt protocol is claimed for that case.
- A captured-payment writer returning a legacy-model result cannot establish completion. Missing projections and database conflicts propagate; already committed capture evidence survives a projection failure and remains available for retry.
- Observer errors and their awaited error alerts, success-shaped results carrying an uncertainty marker, and lost ledger/socket/settlement acknowledgements return retryable 503 under enforcement. Effects are not replayed within that execution. A later successful retry does not resolve an earlier uncertain operation automatically.

Admission-off acknowledgements, legacy unmatched fallback, payment/idempotency identifiers and business transitions are preserved. Closing new work leaves recovery available; closing recovery refuses new operations before observer/provider/writer effects while admitted work can finish. The ledger receives bindings and operation identity without payment, hold or customer data.

## Verification and limits

The [validation record](baselines/2026-11-04-p2-00-square-operational/validation.json), [effect audit](baselines/2026-11-04-p2-00-square-operational/effect-audit.json), merged/candidate source inventories and complete writer classification bind the component to source.

Route tests exercise actual raw-signature dispatch, the admission adapter, operational observer and cancellation remediation with controlled ledger/database/provider terminals. They hold reads, writes, commits, projection, cancellation, remediation and alerts across closure; test classification refusal, mismatch, missing match, unknown status, caught errors and lost acknowledgements; and verify admission-off fallback and production route wiring. Separate PostgreSQL16 tests apply all 80 migrations and exercise the actual classification/observer/repositories, durable captured projection/replay, immutable identity, captured-state preservation, legacy-model uncertainty and the existing operational repository regressions.

These checks do not combine the real webhook, admission ledger and business database under enforcement. The unchanged inherited TLS admission/migration protocol evidence remains separate and was not rerun locally. Exact-head build/browser/PostgreSQL18 CI remains required. Ordinary booking recovery, independent initiation/admin/worker executions, exhaustive actual producer/provider inventory, historical fencing, bootstrap and the parent release/recovery coordinator remain open. All six rollout controls and Fresha/410 closure remain unchanged.
