# Commerce Taxonomy Migration And Booking Payment Hardening Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` for implementation and `superpowers:executing-plans` for task tracking. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the migration away from the legacy checkout-catalog split and make canonical `service`, `bookingOffering`, `trainingProgram`, and `product` documents the only active public commerce taxonomy. Booking, checkout, provider validation, private DB snapshots, emails, and docs must all use the canonical model. In-person appointments must be paid before Google Calendar confirmation, including custom partial appointment payments.

**Architecture:** Sanity stores public/editorial offering configuration only. Private PostgreSQL stores customer snapshots, checkout/order/payment state, booking holds, final booking state, paid training schedule token state, and reconciliation data. Square is the service booking payment provider. Helcim remains the product and training checkout provider. Google Calendar API events are created for service bookings only after payment is verified. Paid training intro-call scheduling uses private token eligibility before rendering a Google Appointment Schedule link or embed. Internal generated line-item codes may be used for DB and processor reconciliation, but customer-facing emails must not display generated/internal codes.

**Current audit:** Production and staging currently have zero published canonical `product`, `service`, or `bookingOffering` documents, three published `trainingProgram` documents, and two published legacy checkout-catalog documents. One checkout-enabled training program in each dataset still depends on a linked catalog item; no audited training program has native commerce fields fully wired. Production private DB records, if present, are test/dummy data and do not need preservation. Staging content may be recreated.

---

## Supersedes Or Updates

- Updates the commerce and booking taxonomy assumptions in `docs/superpowers/plans/2026-05-18-unified-booking-system-redesign.md`.
- Supersedes future work that keeps `bookingOffering.depositProduct` or `bookingOffering.fullProduct` as the payment source.
- Supersedes training checkout assumptions that require a linked checkout catalog item.
- Requires follow-up edits to:
  - `docs/booking-system-setup-guide.md`
  - `docs/booking-system-runbook.md`
  - `docs/sanity-staging-production-workflow.md`
  - `docs/launch-readiness-checklist.md`

## Locked Product Decisions

- Keep `service` as the public/customer-facing lash style content model.
- Keep `bookingOffering` as the bookable/payment wrapper linked to `service`.
- Multiple lash-style variants may share timing/calendar behavior but require separate content and pricing, so `bookingOffering` remains a first-class wrapper rather than merging into `service`.
- New code must not depend on `bookingOffering.depositProduct` or `bookingOffering.fullProduct`.
- New code must not depend on linked checkout catalog items for training commerce.
- All in-person appointments require successful payment before Calendar confirmation.
- Custom partial appointment payments launch as part of this migration.
- Generated/internal line-item codes are acceptable for Helcim/private DB reconciliation only if hidden from customer-facing emails.
- No live form/contact, customer, payment, booking, or order state is written to Sanity.
- Existing production private DB rows can be treated as disposable test data for this unreleased feature.
- Staging content can be recreated instead of migrated one-to-one.

## Target Content Model

### Service

- Public lash service content: title, slug, description, gallery/editorial fields, FAQs, aftercare, and customer-facing category data.
- Does not own payment configuration.
- Does not create bookings by itself.

### Booking Offering

- Bookable wrapper that references one `service`.
- Owns booking behavior: duration, buffer, active state, calendar routing, availability windows, and operational copy.
- Owns appointment payment bounds:
  - `depositAmount`
  - `fullPrice`
  - `currency`
- Does not own a payment mode. The purchaser chooses deposit, full payment, or a custom amount at booking time.
- Custom purchaser-entered amounts are valid only when they are greater than `depositAmount` and less than `fullPrice`.
- Stores only configuration. Customer-selected custom amounts and customer snapshots live in private DB hold/order records.

### Training Program

- Training checkout uses native fields on `trainingProgram` rather than a separate linked catalog item.
- Required native checkout data includes price, currency, checkout enablement, payment label/description, deposit or payment-plan fields if still needed, and any training-specific fulfillment metadata.
- Training intro-call eligibility is resolved from private training payment/enrollment state.

### Product

- Canonical physical/digital product checkout reads directly from the `product` document type.
- Product checkout may generate an internal deterministic line-item code when no merchant SKU exists.
- Customer emails display product titles/options, never generated codes.

### Retired Checkout Catalog

- Retired checkout-catalog records remain only as migration reference until canonical content and code paths are live.
- Do not add new feature work against the retired checkout catalog.
- Remove public checkout dependencies on retired catalog records after canonical content is recreated and verified.

## Data And State Rules

- Booking holds snapshot immutable payment values at hold creation:
  - offering ID and service ID
  - customer-safe offering/service title
  - selected start/end/timezone
  - purchaser-selected payment option
  - selected payment amount
  - deposit and full appointment payment bounds
  - currency
  - generated/internal line-item code if needed
- `/api/booking/checkout` builds Square service checkout line items from hold snapshots, not live Sanity product references.
- Service booking return/webhook validation compares Square amounts to private DB snapshots; product and training validation compares Helcim amounts to private DB snapshots.
- Final booking happens only through the shared finalizer after payment verification.
- If payment succeeds but Calendar insert fails, keep payment state and mark the booking for manual follow-up.
- Product/training/appointment order snapshots may keep internal codes for reconciliation.
- Customer emails must omit generated/internal codes and should instead show readable title, date/time, payment amount, and any required next step.

## Implementation Tasks

## Task 1: Freeze Contracts And Add Regression Coverage

**Files:**
- `src/types/index.ts`
- `src/data/loaders.ts`
- `src/app/api/booking/*`
- `src/app/api/checkout/*`
- `src/app/api/training-checkout/route.ts`
- `src/lib/training-checkout.ts`
- `src/lib/commerce/*`
- `src/lib/booking/*`
- `src/lib/private-db/schema.ts`
- Existing unit tests and Playwright specs under `src/**/*.test.ts` and `tests/`

- [ ] **Step 1: Add contract tests for booking payment snapshots**

Expected:
- Hold creation stores native `bookingOffering` amounts and currency.
- Custom partial amount is accepted only inside the configured range.
- Booking checkout line items are built from the hold snapshot.
- Finalizer uses the hold/order snapshot instead of re-reading mutable Sanity pricing.

- [ ] **Step 2: Add contract tests for training native commerce**

Expected:
- Checkout-enabled training programs can quote and start checkout from native `trainingProgram` fields.
- Any linked-catalog fallback is either explicitly temporary or removed in the final migration step.
- Payment/enrollment snapshots preserve native training title, amount, and currency.

- [ ] **Step 3: Add contract tests for canonical product checkout**

Expected:
- Product checkout can build valid line items from canonical `product` records.
- Internal generated line-item codes populate private DB/processor metadata when needed.
- Customer email rendering omits generated/internal codes.

- [ ] **Step 4: Add idempotency and failure-path coverage**

Expected:
- Client validation and webhook finalization are idempotent.
- Duplicate Square service booking callbacks do not create duplicate Calendar events.
- Paid-but-not-booked states are preserved for manual follow-up.

## Task 2: Update Sanity Schemas And Types

**Files:**
- `src/sanity/schemas/documents/service.ts`
- `src/sanity/schemas/documents/booking-offering.ts`
- `src/sanity/schemas/documents/training-program.ts`
- `src/sanity/schemas/documents/product.ts`
- `src/sanity/schemas/index.ts`
- `src/types/index.ts`

- [ ] **Step 1: Convert `bookingOffering` to native payment bounds**

Expected:
- Add native deposit/full amount fields and fixed CAD currency.
- Do not add or retain a service-level payment mode.
- Add validation requiring a positive deposit amount below the full price.
- Custom partial amounts are purchaser-selected at booking time and validated against deposit/full bounds.
- Keep the service reference required.
- Remove or deprecate legacy product refs from active editing guidance.

- [ ] **Step 2: Ensure `service` remains content-only**

Expected:
- Service schema supports customer-facing lash style content.
- No payment product reference is introduced on `service`.

- [ ] **Step 3: Normalize training native commerce fields**

Expected:
- Checkout-enabled programs have all required native fields.
- Linked checkout-catalog fields are hidden/deprecated or removed after code migration.

- [ ] **Step 4: Add canonical product checkout metadata**

Expected:
- Product schema has enough data to create private order snapshots and Helcim line items.
- If a merchant SKU is optional, the code path documents and hides generated internal codes.

- [ ] **Step 5: Update TypeScript shapes**

Expected:
- `TBookingOffering`, `TTrainingProgram`, and `TProduct` match schema and loader projections.
- Retired checkout-catalog aliases are removed from new public checkout surfaces when safe.

## Task 3: Update Sanity Loaders And Projections

**Files:**
- `src/data/loaders.ts`
- `src/app/api/revalidate/route.ts`
- Any consumers of product, booking offering, training program, or retired checkout-catalog types

- [ ] **Step 1: Project native booking payment fields**

Expected:
- Booking loaders expose native deposit/full amount fields, service reference, duration, and calendar behavior.
- Revalidation tags cover `bookingOffering` and `service` changes.

- [ ] **Step 2: Project training native commerce fields**

Expected:
- Training loaders no longer require dereferenced linked-catalog data for checkout.
- Legacy data remains visible only where explicitly needed for migration inspection.

- [ ] **Step 3: Project canonical product checkout fields**

Expected:
- Product checkout reads canonical product documents.
- Retired checkout-catalog loaders are isolated or scheduled for deletion.

## Task 4: Rewrite Appointment Hold And Checkout Flow

**Files:**
- `src/app/api/booking/holds/route.ts`
- `src/app/api/booking/checkout/route.ts`
- `src/app/api/booking/validate-payment/route.ts`
- `src/app/api/webhooks/card-transactions/route.ts`
- `src/lib/booking/finalizer.ts`
- `src/lib/booking/*`
- `src/lib/private-db/schema.ts`

- [ ] **Step 1: Snapshot native booking payment data into holds**

Expected:
- Hold creation validates offering activity, availability, selected time, and purchaser-selected payment option.
- Deposit/full/custom partial amount is resolved and stored before checkout starts.
- Custom partial amount is required and range-validated against the configured deposit/full bounds.

- [ ] **Step 2: Build booking checkout from hold snapshots**

Expected:
- `/api/booking/checkout` no longer requires `depositProductId` or `fullProductId`.
- Square service checkout line items use the immutable hold snapshot amount and readable title.
- Private checkout order metadata links to the hold and booking purpose.

- [ ] **Step 3: Enforce paid-before-calendar for in-person appointments**

Expected:
- No in-person appointment path creates a Google Calendar event before verified payment.
- Direct `/api/booking/create` either becomes non-public/admin-only for eligible no-payment flows or is blocked for in-person paid offerings.

- [ ] **Step 4: Preserve idempotent finalization**

Expected:
- Square return reconciliation and Square webhook call the same service booking finalizer; Helcim client validation and Helcim webhook remain product/training checkout paths.
- Finalizer detects existing Calendar events before inserting another one.
- Failure states are persisted for reconciliation.

## Task 5: Migrate Training Checkout To Native Commerce

**Files:**
- `src/app/api/training-checkout/route.ts`
- `src/lib/training-checkout.ts`
- `src/lib/training-enrollment-store.ts`
- `src/components/training/*`
- `src/data/loaders.ts`

- [ ] **Step 1: Quote training checkout from `trainingProgram` fields**

Expected:
- Training checkout works with no linked-catalog reference.
- Amount, currency, program title, and fulfillment metadata are snapshotted into private DB.

- [ ] **Step 2: Update training UI and eligibility handoff**

Expected:
- Customer-facing training pages use native pricing/checkout fields.
- Paid intro-call booking uses private payment/enrollment state for eligibility.

- [ ] **Step 3: Remove stale legacy dependency**

Expected:
- No active checkout path requires retired catalog records for training.
- Any remaining references are migration-only and documented for deletion.

## Task 6: Migrate Product Checkout To Canonical Products

**Files:**
- `src/app/api/checkout/route.ts`
- `src/app/api/checkout/validate-payment/route.ts`
- `src/lib/commerce/cart.ts`
- `src/lib/commerce/order-store.ts`
- `src/lib/commerce/product-order-email.ts`
- `src/components/commerce/*`
- `src/data/loaders.ts`

- [ ] **Step 1: Build cart validation from canonical `product` records**

Expected:
- Canonical product title, slug, amount, currency, options, and fulfillment metadata are enough to validate carts.
- Retired catalog fallback is removed or isolated behind a temporary migration flag.

- [ ] **Step 2: Generate internal line-item codes safely**

Expected:
- Private DB required SKU/code fields are populated deterministically when a merchant SKU is absent.
- Generated/internal codes are not rendered in customer emails.

- [ ] **Step 3: Update customer and admin email rendering**

Expected:
- Customer emails show readable product names/options and totals only.
- Admin/internal emails may include internal codes if useful for reconciliation.

## Task 7: Recreate Or Migrate Sanity Content

**Files/Surfaces:**
- Sanity production dataset
- Sanity staging dataset
- Embedded Studio at `/studio`
- `docs/sanity-staging-production-workflow.md`

- [ ] **Step 1: Recreate staging canonical content**

Expected:
- Create representative `service` documents for lash styles.
- Create `bookingOffering` documents linked to services with native payment fields.
- Create canonical `product` documents if product checkout is launch-scoped.
- Update training programs with native commerce fields.

- [ ] **Step 2: Recreate production canonical content**

Expected:
- Create only launch-approved canonical records.
- Do not preserve dummy private DB state.
- Retire or unpublish legacy checkout-catalog records after replacement pages/checkout paths are verified.

- [ ] **Step 3: Validate content publish and revalidation**

Expected:
- Publishing `service`, `bookingOffering`, `trainingProgram`, and `product` updates the correct public pages or checkout data.

## Task 8: Update Documentation And Launch Runbooks

**Files:**
- `docs/booking-system-setup-guide.md`
- `docs/booking-system-runbook.md`
- `docs/sanity-staging-production-workflow.md`
- `docs/launch-readiness-checklist.md`
- `README.md` if the launch smoke matrix changes

- [ ] **Step 1: Replace stale product-reference booking guidance**

Expected:
- Docs describe native `bookingOffering` payment fields, not `depositProduct` or `fullProduct`.

- [ ] **Step 2: Replace stale linked-catalog training guidance**

Expected:
- Docs describe training native commerce fields and private payment/enrollment eligibility.

- [ ] **Step 3: Update launch smoke matrix**

Expected:
- Smoke checks include canonical `service`, `bookingOffering`, `trainingProgram`, and `product` records.
- Checks include custom partial booking payment, full/deposit booking payment, training checkout, product checkout, webhook/client idempotency, and customer email content.

## Task 9: End-To-End Verification And Manual QA

**Commands/Surfaces:**
- `npm run lint`
- `npm run build`
- `npm run test:unit`
- Targeted Playwright specs under `tests/`
- Browser flow through `/booking`, training checkout, and product checkout
- Square service booking sandbox callbacks plus product/training Helcim callbacks, or local webhook fixtures

- [ ] **Step 1: Run static and unit verification**

Expected:
- Changed files have clean diagnostics.
- Unit tests for booking/training/product commerce pass.
- Build succeeds.

- [ ] **Step 2: Manually QA paid booking flow**

Expected:
- Customer selects an appointment, sees availability, creates a hold, enters deposit/full/custom partial payment, completes sandbox payment, and receives Calendar confirmation only after verified payment.
- Invalid custom amount is rejected before checkout.

- [ ] **Step 3: Manually QA training flow**

Expected:
- Customer completes training checkout from native training fields and can access the paid intro-call booking flow through private eligibility state.

- [ ] **Step 4: Manually QA product flow**

Expected:
- Customer completes canonical product checkout.
- Customer email contains no generated/internal SKU/code.
- Private DB and admin surfaces retain enough internal reconciliation metadata.

- [ ] **Step 5: Manually QA failure and duplicate callback paths**

Expected:
- Duplicate client validation/webhook events do not duplicate orders or Calendar events.
- Calendar failure after payment leaves a clear manual follow-up state.

## Rollback Plan

- Before schema/content rollout, export affected Sanity datasets.
- Because private DB records are test/dummy for this unreleased feature, rollback may truncate or ignore new test rows after confirming no live customer use.
- Keep old code deploy available until canonical content and checkout paths pass staging smoke.
- If Helcim or Calendar finalization fails during staging, disable affected public checkout buttons and keep Sanity content unpublished until fixed.

## Completion Criteria

- No active public checkout or booking path depends on retired checkout-catalog records.
- No active training checkout path depends on linked checkout-catalog fields.
- No active booking checkout path depends on `bookingOffering.depositProduct` or `bookingOffering.fullProduct`.
- In-person appointments cannot create Calendar confirmations before verified payment.
- Custom partial appointment payment works end to end.
- Customer-facing product/training/booking emails do not show generated/internal codes.
- Canonical Sanity content exists and passes staging smoke before production recreation.
- Docs and launch checklists match the canonical taxonomy and private-state architecture.
