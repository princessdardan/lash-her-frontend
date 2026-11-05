# Release coordination brief

Owners: OPS + FE + owning APIs/DBs. Tasks: P1-09 final staging admission, P2-00 pending frontend SQL and P6-00 production orchestration/rehearsal. Policy: [release](../release-policy.md) and [migrations](../migration-policy.md). These are implementation requirements; unsupported paths continue to refuse. Completed C3/SQL must not be rerun.

## Inputs and outputs

Inputs are exact source/current CI, immutable candidate/contracts/SQL/schema, target/provider/role/TLS identities, previous compatible configuration and usable recovery, plus an explicit inventory of affected writers/producers. Output is one sanitized release record referencing original component receipts and actual mutation/uncertainty outcomes, not a new manual approval ledger.

P1-09 binds [P1-C01–C07](../p1-qualification-coverage.md), restores only qualified producers/maintenance and admits traffic through a deliberate final action. P2-00 owns pending frontend SQL through compatible frontend deployment under the same environment/database lock. P6-00 joins staging-tested artifacts with exact production targets/recovery and a production-configured frontend build/test/promotion. G6 and explicit P6-06 precede production activation.

## Required design before implementation

- Inventory all affected frontend HTTP handlers, historical deployment URLs sharing the DB, provider webhooks/retries, native schedules, outboxes and API workers. Identify which may finish already-admitted financial work and which must stop new work. A disabled schedule/project does not prove admitted work drained.
- Define writer admission/fencing, the observation that proves drain, maximum wait/stop behavior and lease/cancellation handling. Choose bounds from existing request/job limits and measured evidence; record them before implementation. A timeout leaves the state unverified and dependent traffic stopped.
- Keep six rollout capabilities independent. Vercel environment flags require redeployment; specify how new sales/writes stop if rebuild/provider promotion is unavailable, including old deployment URLs. An appropriate existing DB/host admission mechanism may be used; no new remote flag service is required.
- Hold locks through reviewed preflight, forward SQL, schema/journal/grant verification and compatible deployment. Frontend already-current read-only verification is a separate supported path, not pending-SQL evidence. Receiver/read compatibility precedes dependent writers.
- Production requires a staged production-configured frontend from reviewed source, verified before domains. No staging-configured build substitution. Pending SQL and recovery references must match the reviewed action.

## Acceptance

1. Plan mode remains credential/provider/DB mutation free as currently documented. Wrong source/target/lineage/artifact/recovery and unsupported scope refuse before changes.
2. Isolated tests prove writers cannot enter after fencing, admitted work is accounted for, old deployment/callback/scheduler paths cannot bypass the fence, locks survive all stages and concurrent release attempts refuse.
3. Inject capture/in-flight callbacks, delayed workers, drain timeout, process death, successful SQL followed by failed/uncertain deployment/promotion, and interrupted restoration. Preserve successful SQL and original failure receipts; reconcile actual state before deliberate retry, never automatically reapply.
4. Demonstrate independent stop of new checkout/community writes while safe payment reconciliation/refunds/entitlement recovery and admitted work continue unless implicated in the incident. Record whether callers may safely retry and which keys/leases govern them.
5. Qualify eligible producer and certificate/watchdog restoration against actual host/frontend/configuration without enabling unfinished customer features. Final admission refuses any missing/stale criterion. Production refusal/failure paths are rehearsed in isolation before approved live use.

This brief introduces no arbitrary approval expiry, extra reviewer/signature, monitoring rollout or billing-access prerequisite.

## P1-09 implementation binding

The [final staging admission guide](../operator-final-staging-admission.md) records the concrete P1 inventory, gateway/host source changes, 12-second transport deadline/13-second drain bound, existing 16-second native drain, evidence input and failure behavior. The isolated implementation keeps new work and all six customer features off, admits recovery separately and restores only qualified certificate/watchdog timers. It does not implement P2-00 frontend database fencing or P6-00 production coordination. Its new gateway/Compose candidate and remaining live criteria still require qualification before the reviewed final action.
