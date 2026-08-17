# Helcim Product Payments Sandbox Certification — 2026-08-16

## Decision

Status: **evidence complete; activation pending**. The reviewed snapshot below
is ready for installation in Vercel Preview and subsequent owner step-up
certification. It is not active until the configured value exactly matches the
active `helcim/product_payments` database certification.

The purchase and refund response/GET/signed-webhook evidence is complete. The
application remains fail-closed until the exact reviewed snapshot is installed,
deployed, and recorded through the owner certification workflow.

## Scope and handling

- Environment: Helcim developer test account and `preview.lashher.com`
- Application deployment: Vercel deployment
  `dpl_28M27tXyaEFhBNyJ1Bj3BcBrf5SK`, Git commit `ad39e6c`
- Database alias: staging private PostgreSQL database
- Evidence contains no API token, verifier token, checkout secret, card token,
  full card number, or customer PII.
- Test card data was used only inside Helcim's hosted sandbox payment frame.

## Official references

- [Payments](https://devdocs.helcim.com/docs/payments): transaction fields,
  payment types, `APPROVED` status, refunds, and reverses
- [HelcimPay.js transaction response](https://devdocs.helcim.com/docs/render-helcimpayjs):
  hosted response field names
- [Get Card Transaction by ID](https://devdocs.helcim.com/reference/getcardtransaction):
  authoritative GET used after a webhook notification
- [Webhooks](https://devdocs.helcim.com/docs/webhooks): signed
  `cardTransaction` payload, signature headers, receipt response, and retry
  schedule
- [Testing Payment Declines and CVV Responses](https://devdocs.helcim.com/docs/testing-declines-and-avs):
  sandbox CVV vocabulary (`M` match and `N` mismatch)
- [AVS response codes](https://learn.helcim.com/docs/avs-response-codes-explained):
  `X` and `Y` strong matches and `N` no match

## Sanitized sandbox observations

### Purchase A — Payment API diagnostic

- Transaction ID: `53281474`
- Invoice number: `INV001010`
- Card batch ID: `6988038`
- Amount/currency: `1.00 CAD`
- Direct response: `type=purchase`, `status=APPROVED`, `avsResponse=X`,
  `cvvResponse` empty
- GET: same normalized transaction type/status and field names
- Signed webhook: not observed
- Certification use: diagnostic only; insufficient because no webhook triple

### Purchase B — HelcimPay.js staging checkout

- Transaction ID: `53286070`
- Invoice number: `INV001011`
- Helcim invoice ID: `69472323`
- Card batch ID: `6988038`
- Local checkout order ID: `d3a2f666-afdb-4897-9467-ec12a60226d7`
- Local order reference: `lh-GRhV3kNGwnGf`
- Amount/currency: `4064.61 CAD`
- Hosted response: `type=purchase`, `status=APPROVED`, `avsResponse=X`,
  `cvvResponse=M`
- GET: `type=purchase`, `status=APPROVED`, `avsResponse=X`,
  `cvvResponse=M`
- Response/GET field names relevant to the contract:
  `transactionId`, `type`, `status`, `avsResponse`, `cvvResponse`,
  `invoiceNumber`
- Signed webhook: not stored by the application

### Prior refund observation

- Purchase transaction ID: `53276225`
- Refund transaction ID: `53277250`
- Invoice number: `INV001009`
- Refund response/GET: `type=refund`, `status=APPROVED`
- Refund GET exposed the provider refund identifier in `transactionId` and did
  not expose an original-transaction or merchant-reference field.
- Signed webhook: not observed
- Certification use: supports the response/GET vocabulary only; insufficient
  because no webhook triple was captured

### Purchase C — confirmed signed-delivery run

- Transaction ID: `53290872`
- Invoice number: `INV001012`
- Helcim invoice ID: `69477093`
- Local checkout order ID: `51ee8631-3c7f-414e-8589-616e3ab1c85e`
- Local order reference: `lh-FfTDEV6QtdTu`
- Amount/currency: `4064.61 CAD`
- Helcim hosted result: transaction successfully processed
- Signed webhook event ID: `msg_3I1K4xBznpla62AMOJy6J0GNBuL`
- Webhook delivery: `2026-08-17T00:27:27Z`, HTTP `200`
- Reconciled GET/storage fields: `transactionId=53290872`,
  `transactionType=purchase`, `status=APPROVED`, `amount=4064.61`,
  `currency=CAD`, `invoiceNumber=INV001012`
- Stored sanitized field names: `amount`, `approvalCode`, `cardLast4`,
  `cardType`, `currency`, `invoiceNumber`, `status`, `transactionId`,
  `transactionType`
- Staging event processing status: `review_required`, expected while the
  certified contract is intentionally absent

### Refund C — confirmed full-refund run

- Operator action response: full manual refund completed after batch settlement
- Original purchase transaction ID: `53290872`
- Refund transaction ID: `53291045`
- Invoice number: `INV001012`
- Amount/currency: `4064.61 CAD`
- Refund result/GET: `type=refund`, `status=APPROVED`
- Signed webhook event ID: `msg_3I1LAZOZtmX8b7BzFyQFClbHsBM`
- Webhook delivery: `2026-08-17T00:36:25Z`, HTTP `200`
- Staging event created at: `2026-08-17T00:36:27.652Z`
- Reconciled GET/storage fields: `transactionId=53291045`, `type=refund`,
  `status=APPROVED`, `amount=4064.61`, `currency=CAD`,
  `invoiceNumber=INV001012`, `approvalCode=T3E9ST`, `cardType=MC`,
  `cardLast4=9130`
- Refund GET did not expose an original-transaction or merchant-reference
  field. Correlation succeeded through the matching invoice and local order.
- Staging event/order linkage:
  `51ee8631-3c7f-414e-8589-616e3ab1c85e`
- Staging event processing status: `review_required`, expected while the
  certified contract is intentionally absent

## Webhook delivery trace

- Configured URL:
  `https://preview.lashher.com/api/webhooks/card-transactions`
- Helcim reported event time: `2026-08-16T21:53:16Z`
- Vercel Firewall observed allowed requests at the correct hostname, path, and
  route from `34.130.80.103` with user agent `Svix-Webhooks/1.22.0` during the
  initial and five-minute delivery windows.
- No corresponding function invocation or signed event row was present in the
  deployment logs or staging `checkout_payment_events` table.
- Warnings at `2026-08-16T23:54:45Z`, `2026-08-16T23:54:53Z`, and
  `2026-08-17T00:09:53Z` were unsigned operator diagnostics and are not Helcim
  evidence.
- Direct compatibility probes confirmed public DNS, a valid
  `*.lashher.com` TLS certificate, TLS 1.2/HTTP 1.1 compatibility, route match,
  and the expected `401` response for an unsigned POST.
- Vercel Authentication was temporarily disabled under operator authorization
  to permit a signed retry.
- The confirmed Purchase C webhook reached the function and returned HTTP 200
  at `2026-08-17T00:27:27Z`.
- Vercel Authentication was restored immediately afterward and verified as
  `enabled: true`, scope `preview`.

## Reviewed contract snapshot

The official references and captured sandbox triples support the following
exact reviewed snapshot:

```json
{
  "contract": "helcim_product_payments",
  "version": "helcim-product-payments-sandbox-2026-08-16-v1",
  "evidenceReference": "docs/superpowers/reports/helcim-product-payments-sandbox-certification-2026-08-16.md",
  "effectiveFrom": "2026-08-16T00:00:00.000Z",
  "effectiveUntil": "2027-08-16T00:00:00.000Z",
  "purchaseTransactionTypes": ["purchase"],
  "refundTransactionTypes": ["refund"],
  "purchaseSuccessfulStatuses": ["approved"],
  "refundSuccessfulStatuses": ["approved"],
  "avs": {
    "fieldNames": ["avsResponse"],
    "matchCodes": ["x", "y"],
    "mismatchCodes": ["n"]
  },
  "cvv": {
    "fieldNames": ["cvvResponse"],
    "matchCodes": ["m"],
    "mismatchCodes": ["n"]
  },
  "refundCorrelation": {
    "providerRefundIdFields": ["transactionId"],
    "originalTransactionIdFields": [],
    "merchantReferenceFields": []
  }
}
```

## Remaining certification gates

- Install the exact reviewed snapshot in Vercel Preview, redeploy, record the
  owner step-up certification through the admin workflow, and confirm the
  configured snapshot exactly matches the active database certification.
