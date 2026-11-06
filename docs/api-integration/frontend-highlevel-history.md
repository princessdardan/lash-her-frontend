# HighLevel historical execution and ingress evidence

`ops/platform/host/frontend_highlevel_history.py` is a read-only domain observer for the existing locked release worker. It has no CLI, credential lookup, mutation or admission authority. The provider coordinator supplies the private checkpointed client, reviewed staging scope, exact fixed-query rows, checked historical source requirements, and original-configuration capability closures. The known production location `vd09FLBpPLXuHb5Tnhn4` is refused. No live provider call or production observation was performed for this package.

## Interface and trust boundary

`database_queries(reviewed)` returns nine literal `SELECT` triples. The coordinator executes every query in one read-only repeatable-read transaction before and after provider observation, on its bound physical database and under its existing lock. Query names are `historyContacts`, `historyEffects`, `historyOutbox`, `historyConnections`, `historyWebhooks`, `historyDeliveries`, `historyMarketingJobs`, `historyOauthStates` and `historyGlobalScope`. Tenant-bound reads retain contact/effect identity and timestamps, hashed normalized email, workflow/journey/pipeline references, connection state and hashed webhook receipts. Global outbox, marketing and OAuth-state reads plus global aggregate counts prevent an unscoped caller or another tenant from disappearing behind a location filter. No plaintext email, encrypted credential, recipient, message body, note body or marketing payload is selected.

`normalize_snapshot(actualRows)` requires every query and exact columns, validates types and timestamps, refuses duplicate identities or limits, and sorts rows canonically. `snapshot_sha256(normalize_snapshot(rows))` uses recursive sorted keys, compact ASCII JSON and no nonfinite numbers. The reviewed `historyDatabaseSnapshotSha256` binds this separate snapshot; the existing CRM retirement digest is unchanged.

The reviewed record reuses the existing location/company, credential-provenance and source bindings, with three additions: `historicalSourceCommit`, `historyDatabaseSnapshotSha256` and `history: {observedAt, windowStart, windowEnd}`. Dates are explicit UTC. The requested log interval is at most 30 days, inside the provider's retained 60 days. This window is an observation scope; it creates no completion deadline or assumed delivery SLA.

`read_only_request(method, path, body, reviewed)` is the source classifier for the fixed-origin `frontend_scoped_provider_client.Client`. Only documented scoped GETs are admitted. The parent wraps this client in its existing `LockedClient`. `observe_scoped_effects(client, reviewed, actualRows, verifiedSourceRequirements)` has no public JSON-to-authority path: the fourth argument must come from the checked Git-tree source profile and the parent's original-configuration/actual-SQL reducer. Matching a status string in untrusted input is not source verification.

Each of the eight fixed HighLevel families binds `sourceCommit`, `sourceInventorySha256`, `requirementsSha256` and its exact family ID. Closure requirement IDs must equal the union of that family's configuration, durable-intent and untracked-request IDs plus **all** global SQL credential requirement IDs. Evidence IDs must be sorted SHA-256 references to the parent's actual verified records. Extra, missing, duplicate or malformed closure IDs refuse. An absent source family still requires global credential evidence.

A positive source-specific absence receipt requires all eight exact closures **and** an empty complete SQL inventory, including global counts. Present SQL contradicting this narrow path remains incomplete. Such a receipt may report numeric zero and complete workflow/ingress applicability for that historical source. It does not fence historical writers or authorize traffic; those fields remain false for the coordinator to establish through its independent actual controls. Current false switches, missing connection rows alone, a production-only connected-account list, workflow definitions, publication state or uninstall do not establish this closure.

## Historical source findings

The audit reads exact Git object `b99d4f346696f897fa6a6729dfcc52d6503fe8d6`, the historical C07 source, rather than applying current admission behavior retroactively. Its blob identities and line annotations are retained in the validation evidence.

| Historical source | Consequence |
| --- | --- |
| `sync.ts:333-365` | `durableEffect` inserts a pending intent before a request, records success afterward, and can delete pending intents for nonambiguous errors. A database absence is not a complete HTTP invocation history. |
| `sync.ts:535-578` | Contact journey fields are updated, then workflow enrollment is accepted. The receipt stores the workflow ID; a delivery becomes `sent` with `provider_message_id = workflow:<id>`. This is an enrollment receipt, without a provider execution or downstream message ID. |
| `sync.ts:680-714` | Removal skips missing mappings; an acknowledged DELETE or 404 permits a `cancelled` update. That does not prove all previous execution steps or queued messages ended. |
| `sync.ts:96-173` and direct contact PUTs | Upsert, DND, field updates and stable identity persistence have crash windows outside an independently durable per-request receipt. |
| `worker.ts:33-40` | Marketing pause can remove journeys even while new sync work is disabled. False sync/marketing switches do not eliminate every provider request path. |
| `retention.ts:15-22,52-77` | OAuth states, webhook receipts and completed outbox history expire. Privacy deletion can replace effect identifiers/data with cancelled tombstones. Present rows cannot reconstruct all-time history. |
| `webhook.ts:138-178` | Ingress depends on the configured location, signature and event binding, independently of outbound switches. Accepted callbacks can update suppression, create marketing jobs and enqueue CRM work. |
| `client.ts:15-85` and OAuth source | Requests use private access credentials and Version v3; token refresh/install and direct callers need original configuration and credential scope, not current candidate gates. |

No direct Conversations send API occurs in the historical HighLevel source. Workflows can create downstream messages independently, so that source absence cannot erase the downstream message requirement.

## Provider observations and unsupported joins

The [official workflow-log API](https://marketplace.gohighlevel.com/docs/ghl/workflows/get-workflow-logs/) documents limited sub-account availability, paired dates, cursor pagination and 60-day retention. This helper follows exact cursors with fixed filters, checks counts, duplicates, location, workflow and dates, and records explicit execution exits separately from active or unknown states. An empty page proves only an empty matching window. A success, draft pause, completed database job or accepted removal does not certify exit.

The [Conversations search](https://marketplace.gohighlevel.com/docs/ghl/conversations/search-conversation/) and [message list](https://marketplace.gohighlevel.com/docs/ghl/conversations/get-messages/) APIs supply tenant/contact inventory and paged message receipts. Every message is read back through the [documented message getter](https://marketplace.gohighlevel.com/docs/ghl/conversations/get-message/). Pending/scheduled messages count as known active; delivered/opened/read/clicked are observed delivery states. `sent` alone remains uncertain. Search results requiring an undocumented response cursor remain incomplete rather than inventing pagination. Bodies and recipients stay private. Permission, rate-limit, network, unsupported and missing-object responses remain unknown.

Exact note, completed-task and terminal-opportunity readbacks are tied to stored provider/contact IDs and source intent references. Actual job leases, processing states, marketing acceptance, webhook receipts and connection/OAuth state receive separate sanitized receipts. `knownActiveExecutions` and `knownUnknownEffects` describe the observed scope; aggregate `activeExecutions` and `uncertainEffects` stay null whenever required history or joins remain unsupported.

The documented logs do not expose the application's immutable journey key. A same-workflow/contact execution is therefore a **candidate**, never an invented idempotency match. The returned `requiredObservations` identify exact location, source/hash, time, intent digest, workflow/contact and candidate execution IDs, together with the supported surface and required positive outcome:

- Open Automations > Workflows > the exact workflow > Enrollment History, enumerate applicable statuses/pages/source periods, and open each enrollment's Execution Details. Retain original execution identities, observed waiting/running/retry state and explicit exits. Obtain original retained receipts for periods outside the available window; [contact tracing also retains 60 days](https://help.gohighlevel.com/support/solutions/articles/155000009465/create_ticket). A console with the same retention limit cannot recover missing historical evidence.
- Open Conversations > exact message details > Workflow to reach its execution context, as documented in [Execution Logs and Enrollment History](https://help.gohighlevel.com/support/solutions/articles/155000003992-workflows-improved-execution-logs-enrollment-history). The original source intent and immutable execution/message identities must join, with positive downstream outcomes. If the available records lack this identity, the requirement remains unresolved.
- Inspect the exact Marketplace application's Webhooks settings and Developer Portal > Insights > Logs > Webhook Logs, including all relevant delivery/retry outcomes and matching SQL persistence. Bind original endpoint/event subscriptions and actual ingress/caller fences to the same source/location/time. The [webhook dashboard](https://marketplace.gohighlevel.com/docs/webhook/WebhookLogsDashboard/) retains 30 days; its empty window or an uninstall is insufficient for older callback state.

These are concrete evidence requirements, not an owner attestation form or a new approval/signing step. The observer accepts no generic completion boolean and performs no cancellation, retry, resend, workflow publication, credential retirement or provider configuration change. Unsupported history remains an explicit limitation until actual supported observations resolve it.

## Owned verification

```sh
cd ops/platform/host
FRONTEND_HIGHLEVEL_HISTORY_POSTGRES_TEST=true PG_BIN=/opt/homebrew/opt/postgresql@16/bin \
  python3 -m unittest frontend_highlevel_history_test -v
```

The tests use the actual fixed-origin transport with a test-only loopback origin and trusted fixture CA, checkpoint every actual request, and apply all repository migrations to an owned TLS/SCRAM PostgreSQL 16 cluster. They do not read configured databases, provider accounts or live credentials. No live historical retirement, deployment or G2 acceptance is claimed.
