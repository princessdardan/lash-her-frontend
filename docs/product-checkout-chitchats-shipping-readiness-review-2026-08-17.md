# Product Checkout + ChitChats Shipping — Production Readiness Review

Date: 2026-08-17
Scope: the `staging` branch changes not yet shipped to `main`/production, limited to **products, product checkout, and the ChitChats shipping provider** (Sanity product schema/variants, checkout + Helcim payment pipeline, shipping quote/label/reconciliation subsystem, shipping operations/policy/readiness, and their env/cron/migration wiring).

Method: read-only subsystem audit across five focus areas plus direct inspection of the cutover checklist, env example, crons, and the project's own certification/policy docs. Two code fixes were applied during the review (see [Fixes applied](#fixes-applied-in-this-branch)).

---

> **Update (shipping teardown, after 2026-08-17):** the owner-attestation / duty /
> funding shipping subsystem that this review describes as the launch gate has since been
> **removed** and replaced with source-controlled config
> (`src/lib/shipping/product-shipping-config.ts`, `src/lib/commerce/product-tax-policy.ts`),
> versioned in git. Readiness is no longer owner-attested DB records (fulfillment-policy /
> tax-policy / service-policy / funding / intake-location attestations, duty assignments,
> calendar versions); those tables/columns were dropped by migrations `0062`–`0066`.
> Feature enablement is now env flags (`CHITCHATS_US_SHIPPING_ENABLED`,
> `MANUAL_PRODUCT_CHECKOUT_ENABLED`) plus the populated, business-confirmed config. The
> attestation/duty/funding blockers and checklist items below have been corrected or
> annotated to the config-driven model; the payment-classification and security findings
> (B1, B2, M1) are unaffected. See `docs/shipping-teardown-launch-followups.md` and
> `docs/launch-readiness-checklist.md`.

## Executive verdict

The code is **architecturally mature and fails closed everywhere it matters.** This is not a half-built feature behind a flag: it is a genuinely engineered payment + shipping system with atomic payment finalization, lease/version-fenced background workers, deterministic idempotency, owner step-up certification gates, and defense-in-depth secret handling. Across ~150 new files the review found **no `TODO`/`FIXME`/placeholder/stub markers**, **complete DB migration coverage (70/70 private-DB tables)**, and **no path for the mock payment gateway or the ChitChats sandbox to run in production**.

It is **not production-ready today**, but the gap is dominated by **configuration/certification gates and business decisions**, not missing functionality. The subsystem is inert by default (all feature flags off, `SHIPPING_POLICY_ENFORCEMENT_MODE=off`) and the project's own docs declare it **not yet certified**.

**Recommendation:** ship dark, complete the operator certification checklist, then flip flags to `enforce` in a controlled cutover. One genuine security bug and one likely live-API bug were found and fixed in this branch during the review.

---

## What is solid (validated, low-risk)

- **Payments:** atomic `finalizeProductPayment` with `SELECT … FOR UPDATE` on order + obligation and a unique `(provider, providerTransactionId)` index → no server-side double-charge; client/webhook race resolves to `already_applied`. Amount/currency/invoice variance gate rejects mismatches to `review_required` instead of auto-applying. Shipping cost is folded into the charged total before payment, with an invoice line-item + notes-hash verification gate.
- **Shipping money:** string-based decimal parsing (no float drift), deterministic largest-remainder customs allocation, authoritative-settlement-only accounting that raises a finance alert rather than guessing.
- **Provider integration:** real ChitChats HTTP with 12s timeouts, `Retry-After` propagation, lease + `stateVersion` fencing, and outcome-unknown reconciliation that avoids double-buying labels.
- **Authorization:** admin routes use RBAC + configured-owner assertion + single-use step-up; customer routes use 256-bit opaque bearers stored only as HMAC hashes, single-use exchange, per-IP/subject rate limiting, CSRF + strict CSP. No IDOR/replay/forgery path found.
- **Crons:** all three new crons (`chitchats-shipping` every minute, `shipping-policy` every 15 min, `customer-email-outbox` every 5 min) use timing-safe bearer auth, fail closed if secrets are unset, and are dormant until flags flip.
- **Migrations:** every shipping/payment table used by code has a committed `CREATE TABLE`; snapshot parity at `0061`.

---

## Blockers (must be resolved before enabling)

### B1. Certified Helcim product-payment contract is a hard launch dependency

Without `HELCIM_PRODUCT_PAYMENTS_CONTRACT_JSON` **and** the owner step-up certification it references, every transaction classifies as `"unknown"` → payments never auto-finalize and the initialization worker throws → **product checkout is completely non-functional.** Safe (fails closed) but must be provisioned and verified to exactly match the active DB certification row.
Refs: `src/lib/commerce/helcim-certified-contract.ts:160`, `src/lib/commerce/helcim-contract.ts:148`.

### B2. Customer decision-token confusion — FIXED in this branch

Supplemental-payment offer tokens and shipping-decision tokens share the same table (`productOrderCustomerDecisions`) and the same `"decision"` HMAC secret, and the four shipping-decision token lookups matched on `tokenHash + status + expiresAt` with **no `kind` filter**. A customer's own `supplemental_payment` bearer presented to `/orders/shipping-decision` would validate, be consumed (rotating the offer hash + setting `exchangedAt`), and could be marked "paid" **with no payment occurring** — corrupting decision state and permanently breaking that customer's real payment path. No direct fund loss (the obligation stays `pending`).
**Fix applied:** added a positive `kind` allowlist (`CUSTOMER_DECISION_KINDS`) to all four token lookups in `src/lib/shipping/customer-decisions.ts`. Verify with the `customer-decisions.db.test.ts` suite against a test database before release.

### B3. Launch readiness is now source-controlled config confirmation (was: certification gates)

> Rewritten for the shipping teardown. As originally written, this blocker required
> step-up-authenticated DB attestations created through a protected admin flow. That
> subsystem was removed; the text below reflects the config-driven replacement.

Per `docs/chitchats-shipping-policy-decisions.md` the **11 policy decisions (P-01–P-11) are recorded as owner-approved (2026-08-17)**. The runtime attestation gate this blocker originally described — step-up-authenticated DB records for effective fulfillment policy version, product tax policy version, shipping-policy duty assignments, provider certifications, intake-location + funding attestations, and calendar version — **no longer exists**; those records and the protected admin flow that created them were removed in the shipping teardown (migrations `0062`–`0066`). The operational values they carried now live in `src/lib/shipping/product-shipping-config.ts` and `src/lib/commerce/product-tax-policy.ts`, versioned in git, and readiness is satisfied by the business/legal owner **confirming those config values** before production (see `docs/shipping-teardown-launch-followups.md`). Branch-closure calendar data is now `PRODUCT_SHIPPING_BRANCH_CLOSURES` (statutory Ontario holidays computed); per-service coverage is `PRODUCT_SHIPPING_SERVICE_POLICIES`; there is no funding-reservation ledger (postage funding is managed directly on the Chit Chats account). Still genuinely outstanding and independent of the teardown: Helcim product payments (`HELCIM_PRODUCT_PAYMENTS_CONTRACT_JSON`; `docs/superpowers/reports/helcim-product-payments-sandbox-certification-2026-08-16.md`: "evidence complete; **activation pending**"), the **signed address-change workflow** (only an interim email-reply fallback exists), and PII-redaction backup evidence.

### B4. Sales tax — RESOLVED in this branch

Previously `taxAmountCents` was hardcoded `0` on every product-order path. Now implemented as **destination-based Canadian GST/HST** (ON 13, NB/NL/PE 15, NS 14, all other provinces/territories 5% GST; no PST/QST), **no US tax** (customer covers import via the DDU notice), via a **source-controlled versioned code table** in `src/lib/commerce/product-tax-policy.ts`. (The owner-attested `product_tax_policy_versions` DB row this originally gated on was removed in the shipping teardown; change detection between quote and checkout-commit is now version-based on `PRODUCT_TAX_POLICY_VERSION`.) See [Fixes applied](#fixes-applied-in-this-branch). Payment-security-reviewed: display matches charge, invoice/finalizer invariants hold, fails closed on unimplemented versions and unknown provinces.

**Remaining operational step:** the business/accountant must confirm the destination-based rates in `src/lib/commerce/product-tax-policy.ts` before production; on any rate change, bump `PRODUCT_TAX_POLICY_VERSION` in the same commit. There is no longer a `product_tax_policy_versions` DB row to create — that table was dropped by the shipping-teardown migrations (`0062`–`0066`); checkout still fails closed on an unimplemented version or unknown province.

---

## Major issues

### M1. `findShipments` response-shape mismatch — FIXED in this branch

`src/lib/shipping/chitchats-client.ts` assumed `GET /shipments` returns a bare array, while `listReturns` already handled the wrapped `{shipments:[...]}` shape ChitChats' v1 API uses. If wrapped, create-reconciliation and delete-lookup paths break, and the unit test (bare-array mock) would not catch it.
**Fix applied:** `findShipments` now tolerates both the bare-array and wrapped shapes, mirroring `listReturns`. **Still confirm the real response shape against a live/staging ChitChats call before enabling.**

### M2. Storefront buy controls are not flag-gated — FIXED in this branch

`product-card.tsx` and `product-detail-purchase-controls.tsx` now consult a server-computed `checkoutAvailability` (`getProductCheckoutAvailability()` in `src/lib/shipping/config.ts`), threaded from the products listing/detail pages via the catalog shell. When the relevant mode (`automated`/`manual`) is disabled, the buy CTAs are disabled with a "Checkout unavailable" label / explanatory note instead of dead-ending at a 503. Added a gating unit test.

### M3. Cutover checklist omits all new configuration — FIXED in this branch

`docs/production-cutover-checklist.md` now has a "Chit Chats Shipping and Product Checkout" env section (feature flags, provider creds, signed-link secrets, the `CHECKOUT_PII_ENCRYPTION_KEY` real-entropy warning, and the product-tax-policy config confirmation), a `HELCIM_PRODUCT_PAYMENTS_CONTRACT_JSON` line under Helcim, and the three new crons in the monitoring section.

---

## Minor issues

- **Whole-product 500 on one bad variant:** `getCheckoutMode` maps every variant (including unavailable) and throws on any incomplete one → a partially-authored override can 500 cart-preview/checkout. Skip unavailable variants or catch per-variant. `src/lib/commerce/product-catalog.ts:5-42`.
- **Webhook replay window is 10 hours and symmetric** (`src/lib/commerce/helcim-webhook.ts:40`) — tighten toward ~5 min (dedupe already limits impact).
- **`chitchats-shipping` cron has no try/catch** (unlike the policy cron) → unhandled 500 + stack instead of a `503 + incident hash`. Observability gap.
- **Customer-side HelcimPay session reuse** can produce a second real charge that is flagged for manual/late-capture refund, not prevented (`src/lib/commerce/product-payment-finalizer.ts:281-294`).
- **All-zeros `CHECKOUT_PII_ENCRYPTION_KEY`** placeholder in `.env.local.example` passes shape-only validation — nothing enforces real entropy; easy to deploy insecurely.
- **Duplicate migration number `0010`** (`0010_familiar_jazinda` + `0010_dry_magneto`) — safe via journal ordering, but confusing to operators. This is also the cause of the one pre-existing failing unit test (`src/lib/private-db/schema.test.ts` "compatibility migrations preserve duplicate provider identity and history").
- **US-cert expiry stops quoting silently** (no alert); **sub-$1 shipping refunds dropped** (confirm dust threshold is documented policy); **weak address-input validation** (province regex only, no postal-code check); card-vs-detail price disagreement from `variant.discountPrice ?? product.discountPrice`; the per-variant shipping-override "replace-not-merge" trap; dead/orphaned mock wiring in the checkout handler; legacy products without `variantModel` silently quarantined.
- **Library refund/queue functions self-gate nowhere** — they rely on callers for the enforce-mode check. All current callers gate; add a guard or comment to protect future callers. `src/lib/shipping/customer-refunds.ts`.
- **Un-line-by-lined:** ~1,700 lines of provider-reconciliation worker logic in `src/lib/shipping/address-changes.ts` (~lines 306–2065) were reviewed structurally only. If full sign-off is required, that worker's idempotency/fencing deserves a dedicated pass.

---

## Go-live checklist

### Code fixes (in the branch)

- [x] **B2** — add `kind` discriminator to the four decision-token lookups (`customer-decisions.ts`). _Done._
- [x] **M1** — make `findShipments` tolerate the wrapped response (`chitchats-client.ts`). _Done — still verify against live API._
- [x] **B4 (tax)** — implemented destination-based CA GST/HST (no US tax) as a versioned code table; the former `product_tax_policy_versions` DB attestation was removed in the teardown — the business/accountant confirms the source-controlled rates instead.
- [x] **M2** — storefront buy controls gated on the feature flags.
- [x] Minor: hardened `getCheckoutMode` (unavailable variants degrade instead of 500), added `chitchats-shipping` cron try/catch (503 + incident hash), tightened webhook replay window to ±5 min.

### Configuration & provisioning (per environment)

- [ ] Set all ChitChats vars: `CHITCHATS_ENVIRONMENT=production`, `CHITCHATS_CLIENT_ID`, `CHITCHATS_ACCESS_TOKEN`, `CHITCHATS_REGION`, distinct `CHITCHATS_QUOTE_SIGNING_SECRET`, `CHITCHATS_WORKER_CRON_SECRET`.
- [ ] Set token secrets: `SHIPPING_DECISION_TOKEN_SECRET`, `ADDRESS_CHANGE_TOKEN_SECRET`.
- [ ] Set a **real** `CHECKOUT_PII_ENCRYPTION_KEY` (`openssl rand -base64 32`) — not the all-zeros placeholder.
- [ ] Set `HELCIM_PRODUCT_PAYMENTS_CONTRACT_JSON` to the exact owner-certified snapshot (**B1**).
- [ ] Ensure `CRON_SECRET` is set (Vercel injects it into cron requests) — the every-minute cron 401s without it.
- [ ] Apply migrations through `0066`; confirm `__drizzle_migrations` matches the `when` value of the final journal entry. Migrations `0062`–`0066` are the shipping-teardown irreversible `DROP TABLE`/`DROP COLUMN` operations (attestation, duty-assignment, funding-review, service-policy, tax-policy, manual-policy, and intake-location records) — apply with verified backup/PITR and a pre-drop row-count snapshot (see `docs/launch-readiness-checklist.md` → Private Database Migration Readiness).
- [ ] Confirm DB-at-rest encryption is on (customer name/email/address are app-plaintext).
- [ ] Update `docs/production-cutover-checklist.md` to cover the new env vars, crons, and contract JSON (**M3**).

### Config confirmation & operator setup (the B3 gate)

- [ ] Record owner approval for the 11 policy decisions + Privacy/Legal + Security self-attestations (`docs/chitchats-shipping-policy-decisions.md`). The runtime step-up DB attestations these used to require no longer exist (removed in the teardown).
- [ ] Business/legal owner confirms the source-controlled config values before production (this replaces the removed owner-attested readiness records): `PRODUCT_SHIPPING_US_DDU_CONTRACT` disclosure text / effective window / schema versions and `PRODUCT_MANUAL_CANCELLATION_POLICY` text + version; `PRODUCT_SHIPPING_SERVICE_POLICIES` insurance limits + signature capability against Chit Chats' published coverage; `PRODUCT_SHIPPING_SETTINGS` and `PRODUCT_SHIPPING_BRANCH_CLOSURES` — all in `src/lib/shipping/product-shipping-config.ts` — plus the `src/lib/commerce/product-tax-policy.ts` rate table. Chit Chats postage funding is managed on the Chit Chats account (no local funding balance-check or reservation ledger). Bump `PRODUCT_SHIPPING_POLICY_VERSION` / `PRODUCT_TAX_POLICY_VERSION` on any change.

### Cutover

- [ ] Verify against staging ChitChats first (flags on, enforcement `observe`/`enforce` in preview): quote → pay → label → tracking → refund path; confirm `GET /shipments` real response shape (**M1**).
- [ ] Flip `CHITCHATS_SHIPPING_ENABLED`, `CHITCHATS_CHECKOUT_ENABLED`, and `SHIPPING_POLICY_ENFORCEMENT_MODE=enforce` together — `readiness.ts` treats `policy_not_enforced` as a blocker, so checkout won't go live until enforce is set _and_ the source-controlled shipping/tax config is populated and business-confirmed (the former per-attestation gate was removed in the teardown).
- [ ] Add a startup/health assertion that the flags + `CRON_SECRET` + enforce mode are all set together — in the default mode the entire subsystem (refunds, decisions, address changes, PII redaction) is a silent no-op with no distinct "globally disabled" signal.

---

## Fixes applied in this branch

| ID           | File                                                                                                                                                                            | Change                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B2           | `src/lib/shipping/customer-decisions.ts`                                                                                                                                        | Added `CUSTOMER_DECISION_KINDS` allowlist and `inArray(kind, …)` to `validateCustomerDecisionBearer`, `exchangeCustomerDecisionToken`, `getCustomerDecision`, `selectCustomerDecision` so supplemental-payment tokens can no longer be consumed by the decision flow.                                                                                                                                       |
| M1           | `src/lib/shipping/chitchats-client.ts`                                                                                                                                          | `findShipments` now tolerates both bare-array and `{shipments:[...]}` responses, matching `listReturns`.                                                                                                                                                                                                                                                                                                    |
| B4           | `src/lib/commerce/product-tax-policy.ts` (new, + test), `order-store.ts`, `src/app/api/shipping/quotes/route.ts`, `src/app/(site)/checkout/{page.tsx,checkout-page-client.tsx}` | Destination-based CA GST/HST tax: versioned rate table + fail-closed calculator/version-guard; both order paths compute and charge tax (folded into `totalAmountCents`, reconciles with the invoice/finalizer); receipt email + checkout summary show the tax line; quote GET exposes the destination rate and rejects unknown CA provinces up front. Payment-security-reviewed, no blocker/major findings. |
| M2           | `src/lib/shipping/config.ts`, `product-card.tsx` (+ test), `product-detail-purchase-controls.tsx`, `product-catalog-shell.tsx`, `products/page.tsx`, `products/[slug]/page.tsx` | Storefront buy CTAs gated on server-computed `checkoutAvailability`; disabled with a "Checkout unavailable" label when the mode's flag is off.                                                                                                                                                                                                                                                              |
| M3           | `docs/production-cutover-checklist.md`                                                                                                                                          | Added the shipping/product-checkout env section, `HELCIM_PRODUCT_PAYMENTS_CONTRACT_JSON`, the tax-policy config confirmation, and the new crons.                                                                                                                                                                                                                                                                    |
| Minor        | `src/lib/commerce/product-catalog.ts`                                                                                                                                           | `getCheckoutMode` → `resolveCheckoutMode`: unavailable variants/products with partial/legacy overrides degrade to an undefined mode instead of throwing a 500 in cart preview/checkout; available items still fail closed.                                                                                                                                                                                  |
| Minor        | `src/app/api/cron/chitchats-shipping/route.ts`                                                                                                                                  | Wrapped the worker body in try/catch → `503` + incident hash instead of an unhandled 500 + stack (matches the policy cron).                                                                                                                                                                                                                                                                                 |
| Minor        | `src/lib/commerce/helcim-webhook.ts` (+ test)                                                                                                                                   | Tightened the webhook timestamp window from ±10 h to ±5 min.                                                                                                                                                                                                                                                                                                                                                |
| B3 (partial) | `docs/chitchats-shipping-policy-decisions.md`                                                                                                                                   | Recorded P-01–P-11 as owner-approved (2026-08-17) in the decision doc. Documentation record only — did **not** create the runtime step-up DB attestations that were required at the time; those attestations were later removed entirely by the shipping teardown and replaced with source-controlled config (see the update banner).                                                                                                                                                                                                                          |

Verification: `npx tsc --noEmit` and `npm run lint` clean; `npm run test:unit:src` = 1754/1755 pass (the single failure is the pre-existing `schema.test.ts` duplicate-migration snapshot, unrelated to these changes). DB-backed suites (`customer-decisions.db.test.ts`, `product-payment-finalizer.db.test.ts`) require `TEST_DATABASE_URL` and should be run against a test database before release to exercise the B2 and B4 order-creation paths end-to-end.
