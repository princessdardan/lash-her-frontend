# Affordability without billing-access gates

Effective November 1, 2026, by Dardan's explicit instruction in this chat. This applies throughout the Course and Community API integration plan, including current P1 acceptance and final operational handover.

## Scope change

- Remove agent access to billing, Cost Explorer, Budgets, invoices, account spending, spending limits and private provider cost information as a prerequisite.
- Remove current-spend reports, complete account-cost inventories, headroom calculations, numeric forecast/working-limit admission tests and verified hard spending-cap controls from implementation, provisioning, release and completion gates. The operator checklist's step 3 is closed by this scope change; no additional billing readout is required.
- Treat the reported US$50 monthly budget as an operator-managed affordability target, not an agent-verified ceiling or invoice guarantee. Dardan remains responsible for account billing and budget decisions; no budget configuration is changed by this decision.
- Implement and integrate the APIs using the lowest practical operating overhead consistent with security, reliability, measured capacity and the agreed features. Reuse existing resources, retain the consolidated Lightsail topology, use temporary isolated staging, bound resource/worker concurrency, clean up disposable resources through approved teardown, and avoid unnecessary paid services. Public pricing may inform a concrete design choice without requiring access to private billing data or a complete monthly forecast.

## Required controls retained

Keep protected source/artifact approvals, exact target/lineage checks, secret separation, TLS/OIDC/network boundaries, database connection limits, request/time/retry quotas, measured host/update capacity, scheduler/cancellation qualification and recovery/rollback evidence. Technical request or time "budgets" are distinct from account spending. Paid resource changes and live/deletion operations still follow the existing concrete approval procedures. This decision does not authorize a purchase, provisioning, deployment, migration, credential change or notification.

Dardan remains the sole operator. P1-01/P1-02 remain DONE; P1-08 monitoring remains DEFERRED. Removing billing gates does not certify P1-03–P1-07 or G1: their remaining protected-release and live technical evidence is still required.

## Reported context

Dardan reported current spending of US$0.04 and a US$50 budget, linking a November 2026 Cost Explorer report. Record this as operator-supplied context, not an independently verified total, complete forecast or release prerequisite. No billing URL, session, root credentials or additional cost report needs to be acquired.

This decision supersedes monetary admission requirements in older plans, proposals, runbooks and frozen receipts. Preserve historical observations and signed/hash-bound artifacts with their original dates. Their financial restrictions do not become current gates again; their applicable technical safety and execution controls remain.
