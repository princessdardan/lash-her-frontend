# Training Checkout and Booking Handoff Implementation Plan

> **Historical note (2026-05-17):** This handoff plan uses the checkout/enrollment terminology from its original scope. Current private DB documentation treats the database as shared private PII storage and keeps new form/contact/marketing/consent records out of Sanity.

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` for implementation and `superpowers:executing-plans` for task tracking. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Status:** Draft implementation plan with core business decisions resolved. Do not implement unapproved scope outside the decisions recorded in Task 1.

**Goal:** Add a training-program-specific checkout path that lets users purchase a training program from the training program experience and then prompts paid purchasers to schedule a training call or meeting through the existing Google Calendar booking system.

**Architecture:** Keep Sanity as the public content/catalog source, keep Helcim as the payment processor, keep private PostgreSQL as checkout/order storage, and keep Google Calendar as the booking source of truth. Introduce a training-specific checkout and post-payment scheduling handoff without weakening product checkout, payment validation, or booking validation boundaries.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Sanity v4/next-sanity, Helcim v2 API and HelcimPay.js, PostgreSQL with Drizzle, Google Calendar booking integration, Playwright E2E, `tsx --test` unit tests.

---

## Locked Constraints

- Do not store checkout transaction history, customer PII, checkout tokens, Helcim invoice identifiers, Helcim transaction identifiers, payment reconciliation records, or encrypted Helcim secret tokens in Sanity.
- Do not expose Helcim API tokens, Helcim `secretToken`, Google OAuth tokens, or payment validation secrets to the browser.
- Do not trust client-selected program IDs, prices, payment status, scheduling eligibility, or booking slots.
- Do not replace the existing product checkout with training checkout.
- Do not store confirmed booking history in Sanity.
- Do not create automated refunds, discounts, payment plans, automated inventory/capacity enforcement, customer accounts, or admin dashboards in v1.

## Relevant Files

- `src/app/(site)/training-programs/[slug]/page.tsx`
- `src/sanity/schemas/documents/training-program.ts`
- `src/sanity/schemas/documents/sellable-product.ts`
- `src/data/loaders.ts`
- `src/types/index.ts`
- `src/app/api/checkout/route.ts`
- `src/app/api/checkout/validate-payment/route.ts`
- `src/components/commerce/helcim-pay-button.tsx`
- `src/lib/commerce/*`
- `src/lib/private-db/schema.ts`
- `drizzle/*`
- `src/app/(site)/booking/page.tsx`
- `src/components/booking/booking-flow.tsx`
- `src/app/api/booking/availability/route.ts`
- `src/app/api/booking/create/route.ts`
- `src/lib/booking/*`
- `tests/checkout.spec.ts`
- `tests/training-programs.spec.ts`

## Source Docs

- `docs/superpowers/specs/2026-05-13-training-checkout-booking-handoff-brainstorm.md`
- `docs/superpowers/specs/2026-05-09-training-products-sanity-commerce-design.md`
- `docs/superpowers/specs/2026-05-04-helcimpay-design.md`
- `docs/superpowers/specs/2026-05-05-booking-system-design.md`
- `docs/superpowers/plans/2026-05-10-private-checkout-storage-security-remediation.md`

---

## Task 1: Record Resolved Business Decisions

**Files:**
- `docs/superpowers/specs/2026-05-13-training-checkout-booking-handoff-brainstorm.md`
- `docs/superpowers/plans/2026-05-13-training-checkout-booking-handoff-implementation.md`

- [x] **Step 1: Record payment model**

Owner decision:

- Training checkout charges the full training program price.
- Taxes are calculated by Helcim at checkout using Ontario HST at 13%.
- Discounts and promo codes are out of scope for v1.
- Refunds are handled manually in Helcim for v1.

Expected:
- Implementation has one explicit payment model for launch.

- [x] **Step 2: Record route and UX model**

Owner decision:

- Training checkout lives at `/training-programs/[slug]/checkout`.
- The CTA label is `Enroll Now`.
- The canonical flow is program page -> nested checkout -> Helcim payment -> training confirmation -> scheduling link/button -> booking confirmation.
- Enrollment is complete after verified payment, even if scheduling occurs afterward.
- Confirmation shows booking in-context and sends an email recovery scheduling link.

Expected:
- All route tasks below use the confirmed route only.

- [x] **Step 3: Record booking gate model**

Owner decision:

- Support both public training-call booking and paid purchase-context training-call booking.
- Paid purchasers receive expiring scheduling links.
- Paid scheduling links expire after 14 days.
- Paid scheduling must strictly match the checkout email.
- Paid-context scheduling is for a training call only; further training dates or program scheduling are handled manually.
- Customers cannot self-serve reschedule; they must contact Nataliea.
- Payment remains allowed when no training-call slots are available, with clear follow-up copy.

Expected:
- Booking changes do not accidentally block existing public CTAs.

- [x] **Step 4: Record Sanity and program modeling**

Owner decision:

- `trainingProgram` references a `sellableProduct` whose `kind` is `training`.
- Online purchase is controlled per training program with a `checkoutEnabled` toggle.
- Public price displayed to users must match the checkout-authoritative price.
- Training checkout is single-program only.
- Different training options should be separate training programs, not checkout variants.
- Disabled checkout shows a book-call CTA.
- Capacity is managed by manual toggle when full.

Expected:
- Pricing authority remains server-loaded from Sanity/catalog data.

- [x] **Step 5: Record private storage and operations**

Owner decision:

- Training enrollment uses a separate private `training_enrollments` table.
- Track paid-but-unscheduled state.
- Alert staff immediately after a paid training purchase.
- Admin UI is a later follow-up project, not v1 scope.

Expected:
- Implementation avoids unapproved operational features.

- [x] **Step 6: Record email and notification model**

Owner decision:

- Customers receive payment confirmation first, then the existing booking confirmation after scheduling.
- Nataliea receives both payment and booking notifications.
- Email failure does not block checkout success.

Expected:
- Payment, scheduling, and notifications do not contradict the source-of-truth boundaries.

**Implementation note:** The core business decisions are resolved. Remaining implementation details include no-slot copy, Calendar event copy, public-safe reference format, and retention policy.

---

## Task 2: Define Acceptance Tests First

**Files:**
- `tests/training-programs.spec.ts`
- `tests/checkout.spec.ts`
- New test file if needed: `tests/training-checkout.spec.ts`
- Relevant `src/lib/commerce/*.test.ts`
- Relevant `src/lib/booking/*.test.ts`

- [ ] **Step 1: Add route-level training checkout tests**

Write tests for the approved route:

- training program page exposes the approved enrollment CTA,
- the CTA label is `Enroll Now`,
- checkout route loads only purchasable training programs,
- checkout route is `/training-programs/[slug]/checkout`,
- unavailable/non-purchasable programs show a book-call CTA fallback,
- route uses Next 16 async params and returns `notFound()` for missing content.

Expected:
- Tests fail before implementation and describe the desired flow.

- [ ] **Step 2: Add training checkout API tests**

Cover:

- invalid training program ID rejection,
- training product kind validation,
- unavailable program/product rejection,
- disabled `checkoutEnabled` rejection,
- stale price protection,
- exact displayed price matches checkout-authoritative price,
- Ontario HST at 13% is added through Helcim at checkout,
- single-program checkout only,
- no discount/promo-code handling,
- server-created Helcim invoice line item includes training snapshot.

Expected:
- Server validates against authoritative Sanity/catalog data.

- [ ] **Step 3: Add post-payment scheduling handoff tests**

Cover the approved handoff model:

- training payment success returns or redirects to a scheduling-focused confirmation surface,
- confirmation shows scheduling CTA,
- paid scheduling token is generated with a 14-day expiry,
- token is scoped to order/program/email,
- token requires strict checkout-email match,
- token is for a paid training call only,
- expired/invalid tokens are rejected.

Expected:
- Payment success is recoverable and leads to scheduling.

- [ ] **Step 4: Add privacy boundary tests**

Cover:

- no checkout PII is written to Sanity,
- no raw checkout token is persisted,
- no Google OAuth token or Helcim secret reaches the client,
- private records contain only approved training metadata.
- separate private training enrollment state tracks paid-but-unscheduled status.

Expected:
- Existing private checkout security guarantees remain intact.

- [ ] **Step 5: Add E2E happy path**

Mock Sanity, Helcim, private persistence, email, and Google Calendar as needed.

Flow:

1. Visit training program page.
2. Click enrollment/checkout CTA.
3. Start Helcim checkout.
4. Simulate verified payment success.
5. Land on training confirmation.
6. See scheduling prompt.
7. Continue to booking with training-call context.
8. Receive/verify payment and booking notification behavior with mocked email.

Expected:
- The user journey proves training checkout is distinct from product checkout.

---

## Task 3: Extend Sanity Public Content Model

**Files:**
- `src/sanity/schemas/documents/training-program.ts`
- `src/sanity/schemas/documents/sellable-product.ts` if validation/preview changes are needed
- `src/types/index.ts`
- `src/data/loaders.ts`
- `src/app/api/revalidate/route.ts` if cache tags change

- [x] **Step 1: Add training commerce fields**

Add:

- `checkoutEnabled` boolean.
- `checkoutProduct` reference to `sellableProduct`.
- `checkoutCtaLabel` string defaulting to `Enroll Now`.
- `checkoutDisabledBookingCta` or equivalent book-call fallback configuration.
- `postPurchaseInstructions` text.

Expected:
- Editors can enable or disable online training purchase per program.

- [ ] **Step 2: Add schema validation**

Validate:

- checkout-enabled programs require a checkout product,
- checkout product must reference a `sellableProduct` with `kind: "training"`,
- displayed program price must derive from checkout-authoritative data,
- visible URLs remain safe if legacy CTA remains.

Expected:
- Studio prevents incomplete purchasable training configuration where possible.

- [x] **Step 3: Extend TypeScript and GROQ projection**

Update `TTrainingProgram` and loader projections for only fields used by the route/components.

Expected:
- No ad hoc Sanity fetches are added outside `src/data/loaders.ts`.

- [x] **Step 4: Preserve legacy content safely**

Do not make existing training programs purchasable automatically. Editors must enable `checkoutEnabled` per program.

Expected:
- Production training content is not disrupted by schema additions.

---

## Task 4: Add Private Training Enrollment Storage

**Files:**
- `src/lib/private-db/schema.ts`
- `drizzle/*`
- `src/lib/commerce/order-store.ts`
- `src/lib/commerce/order-store.test.ts`
- New training enrollment store module if created
- `docs/private-checkout-storage-setup.md` if environment or migration notes change

- [ ] **Step 1: Add private `training_enrollments` table**

Include approved metadata:

- relation to private checkout order,
- training program ID,
- training program slug,
- training program title snapshot,
- checkout product ID,
- purchase kind: `full`,
- checkout email or normalized email hash for strict matching,
- scheduling status,
- scheduling token hash,
- scheduling token expiry,
- scheduled timestamp,
- staff alerted timestamp.

Expected:
- Support can distinguish product orders from training enrollments without reading Sanity history.

- [ ] **Step 2: Add scheduling handoff storage**

Store only:

- scheduling token hash,
- token expiry,
- token used timestamp,
- scheduling status.

Expected:
- Raw scheduling tokens are never stored.

- [ ] **Step 3: Generate and review migration**

Use project migration commands only after schema changes are final.

Expected:
- Migration is additive and does not delete existing checkout records.

---

## Task 5: Add Training Checkout Server Boundary

**Files:**
- New route: `src/app/api/training-checkout/route.ts`
- Existing product checkout route remains product-oriented unless a later implementation review proves a shared route is safer.
- `src/lib/commerce/cart.ts` or new training checkout validator module
- `src/lib/commerce/helcim-types.ts` if response shape changes
- `src/lib/commerce/order-store.ts`

- [x] **Step 1: Create a training checkout validator**

Validate:

- program exists,
- program checkout is enabled,
- linked checkout product exists,
- linked product kind is `training`,
- product is available,
- no variants/options are accepted in v1,
- exactly one program is purchased,
- authoritative price and currency are loaded server-side.

Expected:
- Client cannot forge a training purchase from arbitrary product IDs.

- [ ] **Step 2: Initialize Helcim invoice-first payment**

Create one invoice line item for the full training program purchase and add Ontario HST at 13% through Helcim at checkout.

Expected:
- Helcim invoice notes/line item clearly identify the training program without leaking unnecessary private data.

- [ ] **Step 3: Create private pending training order**

Persist the checkout order and create a related private `training_enrollments` record.

Expected:
- Payment validation can distinguish training orders from product orders.

- [ ] **Step 4: Return client-safe checkout response**

Return only approved public data:

- `checkoutToken`,
- public-safe order/enrollment reference if needed,
- no secret token,
- no private identifiers beyond approved order reference.

Expected:
- Browser remains outside payment-secret boundary.

---

## Task 6: Add Training Payment Validation And Confirmation Handoff

**Files:**
- `src/app/api/checkout/validate-payment/route.ts` or a training-specific validation route if a shared validator would complicate product checkout
- `src/lib/commerce/verified-payment.ts`
- `src/lib/commerce/order-store.ts`
- New confirmation route: `src/app/(site)/training-programs/[slug]/confirmation/page.tsx`
- `src/components/commerce/helcim-pay-button.tsx` or a training-specific payment button component

- [ ] **Step 1: Preserve existing payment verification**

Continue validating:

- Helcim response hash,
- approved status,
- amount,
- currency,
- invoice number,
- transaction ID.

Expected:
- Training payment does not weaken product payment security.

- [ ] **Step 2: Branch post-payment redirect by checkout flow**

Product orders continue to `/products/confirmation`.

Training orders route to the approved training confirmation/scheduling surface.

Expected:
- Product and training post-payment UX diverge intentionally.

- [ ] **Step 3: Create scheduling handoff artifact**

Create a 14-day signed token or private lookup handle after verified payment.

Expected:
- Paid users can recover scheduling from confirmation page and email.

- [ ] **Step 4: Track paid-but-unscheduled state**

Mark training order scheduling status as pending after payment.

Expected:
- Staff can identify paid training orders that still need scheduling follow-up.

---

## Task 7: Integrate Booking Handoff

**Files:**
- `src/app/(site)/booking/page.tsx`
- `src/components/booking/booking-flow.tsx`
- `src/app/api/booking/availability/route.ts`
- `src/app/api/booking/create/route.ts`
- `src/lib/booking/*`
- New server utility: `src/lib/booking/training-scheduling-eligibility.ts`

- [ ] **Step 1: Carry training context into booking**

Allow the booking flow to receive safe training-call context from a paid scheduling link.

Expected:
- Booking UI can say which training program the call is for.

- [ ] **Step 2: Validate paid scheduling eligibility server-side**

Validate scheduling token/order/enrollment eligibility before showing or creating paid-context training-call bookings.

Require the entered booking email to match the checkout email for paid-context scheduling.

Expected:
- Unpaid users cannot use paid-only scheduling links.

- [ ] **Step 3: Preserve public booking behavior**

Keep `/booking?type=training-call` public and do not require payment proof for the public flow.

Expected:
- Existing booking CTAs continue working during rollout.

- [ ] **Step 4: Include safe context in Calendar event**

Include only approved operational details, such as:

- training program title,
- public-safe order reference,
- customer answers,
- no Helcim secrets,
- no raw payment payload.

Expected:
- Nataliea can identify the paid training context from Calendar without exposing sensitive payment data.

- [ ] **Step 5: Update scheduling status after booking**

Mark the private training enrollment scheduled after successful Google Calendar insertion.

Expected:
- Paid-but-unscheduled tracking resolves when booking succeeds.

---

## Task 8: Add Training Checkout UI

**Files:**
- Approved route file, likely `src/app/(site)/training-programs/[slug]/checkout/page.tsx`
- New components under `src/components/training` or `src/components/commerce`
- `src/components/commerce/helcim-pay-button.tsx` if generalized safely

- [ ] **Step 1: Build training checkout page**

Render:

- program summary,
- exact full-program price plus tax-at-checkout messaging,
- what happens after payment,
- customer fields,
- approved terms/refund policy acknowledgement,
- secure Helcim payment action.

Expected:
- Training checkout feels distinct from product cart checkout.

- [x] **Step 2: Add CTA from training detail page**

Show enrollment CTA only when training checkout is enabled and configured.

The primary CTA label is `Enroll Now`.

Expected:
- Non-purchasable training programs show a book-call fallback CTA.

- [ ] **Step 3: Build training confirmation/scheduling page**

Render:

- payment success message,
- order/program summary,
- scheduling CTA/button and in-context booking experience,
- recovery copy if scheduling is skipped,
- contact instructions if booking unavailable.

If no training-call slots are available, clearly state that scheduling may require follow-up and still preserve payment success.

Expected:
- User knows payment succeeded and the next required action is scheduling.

---

## Task 9: Add Emails And Notifications

**Files:**
- `src/lib/email.ts` or new commerce email module
- `src/lib/booking/email.ts`
- Training checkout server route/validation route

- [ ] **Step 1: Add customer training payment email**

Include:

- payment confirmation,
- training program name,
- scheduling link or instructions,
- contact/support instructions,
- manual-refund and terms copy.

Expected:
- User can schedule later even if browser closes.

- [ ] **Step 2: Add admin payment notification**

Include:

- customer contact,
- program purchased,
- paid/unscheduled status,
- public-safe order reference.

Expected:
- Nataliea can follow up on paid training purchases.

- [ ] **Step 3: Preserve booking confirmation email**

Existing booking confirmation remains tied to Google Calendar booking success.

Expected:
- Payment email and booking email do not contradict each other.

- [ ] **Step 4: Keep email failures non-blocking**

Log payment or notification email failures without marking checkout failed.

Expected:
- Verified payment remains successful even if email delivery fails.

---

## Task 10: Documentation And Rollout

**Files:**
- `README.md`
- `docs/booking-helcim-implementation-summary.md`
- `docs/private-checkout-storage-setup.md`
- `docs/superpowers/specs/2026-05-04-helcimpay-design.md` if training flow becomes canonical
- `docs/superpowers/specs/2026-05-05-booking-system-design.md` if paid-context scheduling changes the canonical booking design
- `docs/superpowers/specs/2026-05-09-training-products-sanity-commerce-design.md`

- [ ] **Step 1: Update human setup docs**

Document any new environment variables, migrations, or operational setup.

Expected:
- A maintainer knows how to configure training checkout in staging/production.

- [ ] **Step 2: Update content editor guidance**

Document how to make a training program purchasable in Sanity.

Expected:
- Editors can configure checkout without exposing private order data.

- [ ] **Step 3: Add rollout checklist**

Checklist should include:

- create/verify training `sellableProduct`,
- link it from `trainingProgram`,
- enable checkout,
- verify exact displayed price,
- verify tax is added at checkout,
- verify Helcim test payment,
- verify scheduling prompt,
- verify email recovery scheduling link expiry,
- verify Google Calendar booking,
- verify emails,
- verify no Sanity PII writes.

Expected:
- Rollout can be validated before production launch.

---

## Task 11: Final Verification

**Files:**
- All changed files.

- [ ] **Step 1: Run diagnostics**

Run `lsp_diagnostics` on changed TypeScript files.

Expected:
- No new diagnostics from this work.

- [ ] **Step 2: Run unit tests**

Run relevant commerce, private DB, booking, and route tests.

Expected:
- Tests pass or unrelated pre-existing failures are documented.

- [ ] **Step 3: Run E2E tests**

Run focused Playwright tests for:

- training program page,
- training checkout,
- product checkout regression,
- booking flow.

Expected:
- Training purchase to scheduling prompt works with mocks.

- [ ] **Step 4: Manual QA**

Manually verify in browser:

- product checkout still routes to product confirmation,
- training checkout routes to training confirmation,
- training confirmation prompts scheduling,
- booking flow creates Google Calendar event with approved context.
- no-slot training confirmation clearly communicates follow-up scheduling.

Expected:
- User-visible flow matches approved business rules.

---

## Implementation Stop Conditions

Stop and ask the owner before continuing if:

- schema changes would make existing training programs purchasable automatically,
- checkout records would need to store new PII not approved by the owner,
- Google Calendar booking would need to stop being the source of truth,
- implementation would require refunds, payment plans, discounts, inventory, or admin UI not approved in Task 1.
- public-safe order/enrollment reference requirements cannot be confirmed before private storage or paid scheduling implementation.

## Suggested Commit Sequence

1. `docs: resolve training checkout handoff requirements`
2. `test: define training checkout and scheduling handoff`
3. `feat: add training checkout content model`
4. `feat: persist training checkout context privately`
5. `feat: add training checkout payment flow`
6. `feat: add post-payment training scheduling handoff`
7. `feat: add training checkout confirmation UI`
8. `test: cover training checkout booking flow`
9. `docs: document training checkout rollout`

## Plan Integrity Checklist

- Task 1 business decisions are recorded before code implementation begins.
- Product checkout remains separate from training checkout.
- Private storage remains the only checkout/order persistence layer.
- Training enrollment state lives in private `training_enrollments` storage.
- Google Calendar remains the booking source of truth.
- Payment success is verified server-side before scheduling handoff.
- Paid scheduling recovery is included through an expiring email link.
- The implementation has tests before code changes.
