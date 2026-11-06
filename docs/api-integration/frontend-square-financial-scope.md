# Historical Square financial scope

`ops/platform/host/frontend_square_financial_scope.py` discovers and reconciles historical Square effects. It does not authorize traffic, retire credentials, disable subscriptions, settle payments, delete links, or certify staging. The integration owner supplies the fixed-origin, workload-locked, private transport and the independently verified historical source/configuration/SQL-credential proof.

## Historical source audit

Audited revision: `b99d4f346696f897fa6a6729dfcc52d6503fe8d6` (C07). Line references below refer to that immutable revision, not the current application.

| Family | Actual C07 source | Request/intent boundary |
| --- | --- | --- |
| `square.payments` | `src/lib/payments/square/payments-client.ts:143–219`; `src/lib/booking/payments/service-charge-and-store.ts:850–963,1347–1517`; commerce card/training wrappers; split payment state machine | Create, complete, cancel, cancel-by-key, and split `PayOrder` are distinct accepted effects. Operational/V2 saves a request intent and capture lease before payment creation; the source explicitly identifies V1's missing durable authorization recovery. Existing V2 intent rows cannot establish completeness for V1 or every direct/manual caller. |
| `square.refunds` | `src/lib/payments/square/product-refund.ts:71–86`; `src/lib/payments/square/payments-client.ts:215–219`; `src/lib/shipping/customer-refunds.ts` | Refund queue/idempotency/lease/unknown-outcome state and provider refund/event receipts are independent evidence. A refund without a recorded provider ID remains uncertain, including a local failed status after an unknown accepted request. Partial refund amounts are checked against the refund, not against the original payment's full amount. |
| `square.orders` | `src/lib/commerce/square-invoice-client.ts:207–228`; `src/lib/payments/square/payments-client.ts:604–631`; `src/lib/booking/payments/service-no-show-invoice.ts:357–436`; `src/lib/commerce/square-training-split.ts` | Training split stores stage/references and uses deterministic per-step keys. No-show order creation precedes invoice creation and durable provider-reference updates. A provider order can survive an invoice-creation failure or failed fallback persistence. `PayOrder` can complete after acknowledgement loss. |
| `square.customers` | `src/lib/booking/payments/service-card-on-file.ts:753–784`; `src/lib/booking/payments/service-charge-and-store.ts:2295–2333`; training invoice handler below | Provider creation precedes local customer/checkpoint persistence. A prior hold or a deterministic request key is insufficient to rule out an accepted customer creation with no returned ID. |
| `square.cards` | `src/lib/payments/square/cards-client.ts:54`; `src/lib/booking/payments/service-card-on-file.ts:881–914`; charge/store payment results | Provider card creation precedes its best-effort checkpoint and local saved-payment-method insert. Saved card IDs can also arrive with a successful payment response. A lost acknowledgement can orphan a provider card. IDs such as `ccof:…` require encoded exact reads. |
| `square.invoices` | `src/app/api/training-checkout/square-invoice/handler.ts:210–251`; `src/lib/booking/payments/service-no-show-invoice.ts:357–448,845–953`; both Square invoice clients | Training creates customer, order, and invoice before the first pending-order SQL write at line 231; publication precedes its publication SQL receipt. No-show creation persists references after the provider calls, with best-effort fallback/deletion. Its later publication has a prior attempt claim, but that claim still requires actual invoice readback after a lost acknowledgement. Published unpaid/scheduled invoices can create future payments. |
| `square.checkout` | `src/lib/booking/square-client.ts:108–114`; `src/lib/booking/square-service-checkout.ts:110–147,243` | Hosted link/order creation precedes pending-checkout persistence. `provider_checkout_id` is the link ID in this flow. Existing links can remain an independent payment-acceptance capability after deployment/credential retirement. A successful link GET does not prove that capability disabled. |
| `square.webhooks` | `src/app/api/webhooks/square/handler.ts`; `src/lib/private-db/operational-square-payment-observer.ts`; refund, invoice, booking and training finalizers | Payment/order/invoice/refund receipts drive further SQL/provider work. An admitted inner finalizer does not establish admission or receipt completeness for the enclosing historical callback. Pending/retryable/review-required stored events remain uncertain. Subscription disabling and accepted/delayed callback fencing belong to the shared owner. |

Original configuration guards include `TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED` (`private-checkout.ts:85–87`), `SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED` (`89–91`), `SQUARE_COMMERCE_ENABLED` (`98–100`), `SERVICE_BOOKING_SQUARE_ENABLED` (`247–249`), payment mock mode, and the actual sandbox environment/location/application/credential binding. These are historical evidence requirements. Reading a current false flag cannot close them. Direct exported helpers and injectable client factories also require historical scripts/manual credentials and SQL logins to be included in the source evaluator's proof.

## Interface

The only exported query producer is `database_queries(reviewed) -> [(name, literal SELECT, [])]`. It emits twelve closed projections: `orders`, `obligations`, `transactions`, `refunds`, `holds`, `attempts`, `customers`, `cards`, `noShowRecords`, `noShowAttempts`, `events`, and `refundEvents`. Every query has an ordered 4,097-row sentinel; normalization refuses more than 4,096 rows, duplicates, unknown columns, invalid timestamps/types/digests, and missing mandatory values. There are no caller-supplied row selectors and no application SQL writes. The parent executes all projections against one consistent read-only snapshot of every applicable database login target.

`normalize_snapshot(rows)` validates and sorts the exact projection schema exposed as `COLUMN_NAMES`; `snapshot_sha256(rows)` hashes canonical JSON. Customer identity is represented only by exact provider IDs and a normalized email SHA-256. Names, addresses, card details, tokens, webhook secrets, error bodies, bearer URLs, and arbitrary provider metadata are never projected into public snapshots or receipts.

New reviewed fields, merged into the existing sandbox Square review:

- `operationBeginTime`, `observationEndTime`: explicit UTC timestamps, with no API-default history window.
- `operationLifetimeEvidenceIds`: original capability-lifetime evidence references; these do not themselves establish accepted-request completeness.
- `databaseSnapshot`: validated immutable original prestate, with `databaseSnapshotSha256`.
- Existing exact `environment: sandbox`, `locationId: LE2H76M5V90AM`, `apiVersion: 2026-05-20`, and `sourceBindingSha256`. Real `merchantId` and `applicationId` are mandatory for provider reads; verified complete absence does not require inventing either principal.

`observe_scoped_effects(privateLockedClient, reviewed, actualRows, verifiedSourceRequirements)` binds every result to the verified `sourceCommit`, `sourceInventorySha256`, `requirementsSha256`, exact family/requirement IDs, source binding, original/current snapshot digests, and merchant/location/application. It returns sanitized exact-object and immutable SQL-intent/provider-receipt joins, derived active/uncertain counts, and explicit missing requirements. Caller completeness flags are ignored. Aggregate counts remain `null` while any source requirement is missing.

`source_inapplicable(reviewed, actualRows, verifiedSourceRequirements)` can run before resolving any Square credential. It returns true only when all eight source-owned family/config/intent/untracked requirements and every source-wide SQL-credential requirement have complete independently observed closures with evidence digests, and both original and current complete SQL snapshots are empty. The observer then accepts `client=None` and absent principal IDs and records zero with `providerReadRequired: false`. Any nonempty row leaves that shortcut and requires actual readback or uncertainty.

Only the source evaluator may supply `capabilityClosures`, after verifying original immutable configuration and complete actual SQL-credential evidence. A closure's `requirementIds` must equal its family's complete union of `configurationConditions`, `sqlIntentRequirements`, and `untrackedPotentialRequests`, plus every `sqlCredentialRequirements` ID. `evidenceIds` must be nonempty SHA-256 digests. The domain component never manufactures those closures from lists, flags, counts, waiting, or operator assertion.

## Provider reads and limitations

The source function `read_only_request(method,path,body,reviewed)` is the transport classifier. It permits fixed sandbox location binding, closed pagination GETs, exact object GETs, and only read-only `POST /v2/orders/search` with one exact location, an explicit creation-time interval, complete objects, ordering, cursor and bounded limit. Other POSTs, PUTs, DELETEs, extra filters, alternate locations, malformed IDs, or production selectors are refused before transport.

| API | Bounded request | Official contract |
| --- | --- | --- |
| Payments/refunds | 100 per page; explicit begin/end and location; every status | [List payments](https://developer.squareup.com/reference/square/payments-api/list-payments), [List payment refunds](https://developer.squareup.com/reference/square/refunds-api/list-payment-refunds) |
| Orders | Read-only search POST; 1,000 per page; fixed location, explicit interval, complete objects | [Search orders](https://developer.squareup.com/reference/square/orders-api/search-orders) |
| Customers | 100 requested per page; full account listing | [List customers](https://developer.squareup.com/reference/square/customers-api/list-customers) |
| Cards | 25 maximum per page; include disabled; no customer/reference subset | [List cards](https://developer.squareup.com/reference/square/cards-api/list-cards) |
| Invoices | 200 per page; fixed location | [List invoices](https://developer.squareup.com/reference/square/invoices-api/list-invoices) |
| Hosted links | 1,000 requested per page; full listing | [List payment links](https://developer.squareup.com/reference/square/checkout-api/list-payment-links) |

Customers/checkout limits are advisory; responses beyond the component's bound cause refusal. Pagination follows cursors until exhausted, with 128-page and 4,096-object bounds; duplicate objects, repeated/invalid cursors, empty pages with continuation, and malformed responses refuse. The observer also reads every exact SQL/provider ID, including stored IDs omitted by an eventually consistent list. Money must be CAD, principal/location/application matches are exact, references/order/customer relationships must match, and terminal SQL outcomes must agree with actual provider outcomes. Unknown/untracked objects, unfinished authorizations/refunds/invoices, unresolved hosted links, and SQL recovery states remain explicit uncertainty.

Square documents eventual consistency for payment/refund/customer lists, visibility limits on customer listing, and delayed offline-order submission. Therefore no list count, pair of stable lists, observation wait, or API-default one-year interval can eliminate an untracked request, an accepted request with a lost acknowledgement, or a request still reaching the provider at retirement. A nonempty inventory can prove particular joined effects; it does not close the historical source's accepted-request-completeness gap. Hold confirmation markers remain uncertain regardless of the application's marker TTL.

The immutable original snapshot is never rewritten. A narrow callback reducer permits existing nonterminal payment attempts/refunds to advance only to a matching actual terminal provider outcome, with unchanged intent/money/idempotency and a concrete appended processed event/refund receipt. New operations, altered intent, removed history, arbitrary status edits, manual overrides, and unsupported mutations remain uncertain. Other legitimate callback state changes require an additional reviewed source reducer; they are not silently accepted.

## Owned verification

Run from `ops/platform/host` after integrating the shared fixed-origin transport:

```sh
FRONTEND_SQUARE_FINANCIAL_POSTGRES_TEST=true python3 -m unittest frontend_square_financial_scope_test -v
```

During independent development, set `FRONTEND_SCOPED_PROVIDER_CLIENT_PATH` to the integration owner's exact `frontend_scoped_provider_client.py` file. The HTTPS tests use only an owned loopback TLS endpoint and trusted generated test CA. Database tests create an isolated PostgreSQL 16 TLS/SCRAM cluster and apply all 83 repository migrations before executing the fixed projections, nonempty joins, tamper refusal, and actual callback receipt transitions. They do not connect to staging, production, or Square. Shared transport authorization/lock-failure tests remain owned by the integration owner.

This component supplies source and owned-fixture evidence only. Actual original-configuration provenance, complete database credential observation, historical bypass/provider fencing, real sandbox effects, and deployed release certification remain separate required evidence.
