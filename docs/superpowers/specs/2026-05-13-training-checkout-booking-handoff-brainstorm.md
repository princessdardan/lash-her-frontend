# Training Checkout and Booking Handoff Brainstorm

> **Historical note (2026-05-17):** This brainstorm predates the shared private PII storage docs. Current private DB guidance supersedes any checkout-only wording and keeps new form/contact/marketing/consent records out of Sanity.

Date: 2026-05-13
Status: Draft with owner decisions recorded

> **Scope:** This is a superpowers brainstorming/specification document. The owner decisions below resolve the core business rules for implementation planning.

## Problem Statement

The current implementation lets visitors read a training program page and click a CMS-managed CTA, but it does not let a visitor purchase that training program directly from the program page. Checkout exists only through the general product catalog and treats products, services, deposits, and training-like catalog entries as the same cart flow.

That is not the desired business flow. A training program purchase has a different lifecycle than a product purchase: after payment, the purchaser must be prompted to schedule a training-related call or meeting through the Google Calendar booking system. The training purchase flow must therefore distinguish training enrollment from ordinary product checkout both in user experience and in server-side business logic.

## Existing Architecture Constraints

- Training detail route: `src/app/(site)/training-programs/[slug]/page.tsx`.
- Current training CMS document: `src/sanity/schemas/documents/training-program.ts`.
- Current commerce catalog document: `src/sanity/schemas/documents/sellable-product.ts`.
- Current product checkout route: `src/app/api/checkout/route.ts`.
- Current payment validation route: `src/app/api/checkout/validate-payment/route.ts`.
- Current booking entry route: `/booking?type=training-call`.
- Current product confirmation route: `/products/confirmation`.

The following docs remain authoritative:

- `docs/superpowers/specs/2026-05-04-helcimpay-design.md` for invoice-first Helcim checkout.
- `docs/superpowers/specs/2026-05-05-booking-system-design.md` for Google Calendar booking as source of truth.
- `docs/superpowers/specs/2026-05-09-training-products-sanity-commerce-design.md` for training/product content modeling boundaries.
- `docs/superpowers/plans/2026-05-10-private-checkout-storage-security-remediation.md` for private checkout storage.

## Non-Negotiable Boundaries

- Sanity stores public content, catalog metadata, training program content, visible pricing copy, CTA copy, SEO, and editorial configuration only.
- Sanity must not store checkout transaction history, customer PII, checkout tokens, Helcim invoice identifiers, Helcim transaction identifiers, payment reconciliation records, or encrypted Helcim secret tokens.
- Helcim remains the training checkout payment processor and secure card collection surface.
- The browser receives only a Helcim `checkoutToken`.
- The server reloads authoritative Sanity/catalog data before creating a payment session.
- Google Calendar remains the scheduling source of truth for this training handoff, now through a private token gate before a Google Appointment Schedule link or embed.
- Client-selected booking slot, product IDs, prices, quantities, payment success, and scheduling eligibility are untrusted until server-validated.

## Business Goal

Create a training-specific purchase path that lets a user enroll from a training program page or a nested training checkout route, then guides the paid purchaser into a Google Calendar scheduling step for a training call or meeting.

The business value is not just shorter clicks. The checkout path should encode that training enrollment requires a post-payment operational step, while ordinary products do not.

## Resolved Owner Decisions

These decisions are approved for the implementation plan:

| Area | Decision |
| --- | --- |
| Payment model | Training checkout charges the full training program price. |
| Purchase availability | Online purchase is controlled per training program. |
| Cart shape | Training checkout is single-program only; one training program per transaction. |
| Program options | Different options should be modeled as separate training programs, not checkout variants. |
| Route | Checkout lives at the nested route `/training-programs/[slug]/checkout`. |
| CTA label | The primary purchase CTA is `Enroll Now`. |
| Completion semantics | Enrollment is considered complete after verified payment, even if scheduling happens afterward. |
| Post-payment UX | Confirmation should show booking in-context and also send an email recovery scheduling link. |
| Booking access | Support both public training-call booking and paid purchase-context booking. |
| Scheduling email | Paid purchasers receive a scheduling link by email. |
| Scheduling expiry | Paid scheduling links expire after 14 days. |
| Paid scheduling purpose | Paid-context scheduling is for a training call only; any later training dates or program scheduling are handled manually. |
| Email matching | Paid scheduling is strictly tied to the checkout email. |
| Rescheduling | Customers cannot self-serve reschedule; they must contact Nataliea. |
| Sanity commerce model | `trainingProgram` references a `sellableProduct` whose `kind` is `training`. |
| Price display | Public price shown to users must match the checkout-authoritative price. |
| Editor control | Editors control online purchase with a `checkoutEnabled` toggle on the training program. |
| Disabled checkout fallback | Disabled checkout shows a book-call CTA. |
| Private storage | Training enrollment uses a separate private `training_enrollments` table. |
| Scheduling tracking | Track paid-but-unscheduled state. |
| Staff alert timing | Alert staff immediately after a paid training purchase. |
| Admin UI | Admin UI is a later follow-up project, not v1 scope. |
| Customer emails | Send payment confirmation first, then the existing booking confirmation after scheduling. |
| Staff emails | Nataliea receives both payment and booking notifications. |
| Email failure | Email failure does not block checkout success. |
| Refunds | Refunds are handled manually in Helcim for v1. |
| Discounts | Discounts and promo codes are not in v1 scope. |
| Taxes | Taxes are calculated by Helcim at checkout using Ontario HST at 13%. |
| Capacity | Capacity is managed by manual program toggle when full. |
| No-slot state | Payment remains allowed when no slots are available, with clear follow-up copy. |
| Canonical flow | Program page -> nested checkout -> Helcim payment -> training confirmation -> scheduling link/button -> booking confirmation. |

## Implementation Direction

1. Keep `trainingProgram` and `sellableProduct` as separate Sanity document types.
2. Add a structured commerce reference from `trainingProgram` to a `sellableProduct` whose `kind` is `training`.
3. Add a training-specific checkout UI at `/training-programs/[slug]/checkout`.
4. Keep the existing product cart checkout for `/products`.
5. Add a single-program training checkout path that does not use a multi-item cart.
6. Route successful training payments to a training-specific confirmation/scheduling page.
7. Prompt the purchaser to schedule a `training-call` through the existing Google Calendar booking flow.
8. Store training purchase and enrollment context in private checkout/enrollment storage, not Sanity.
9. Use an expiring scheduling handoff token or private order/enrollment lookup to prove eligibility for paid-context scheduling.
10. Preserve public `/booking?type=training-call` behavior alongside the paid purchase-context scheduling flow.

## Candidate Routes

### Option A: Direct Checkout On Program Page

Route: `/training-programs/[slug]`

The training detail page includes a compact enrollment panel with customer fields and Helcim launch button. This is the shortest path and best matches the phrase “purchase directly from a training program page.”

Tradeoffs:

- Best conversion path.
- More client/payment logic on a content-heavy page.
- Page becomes more complex to test and maintain.

### Option B: Nested Checkout Route

Route: `/training-programs/[slug]/checkout`

The detail page keeps editorial content and sends users to a focused checkout page. This is cleaner if training checkout needs terms, customer details, program-specific options, or a visible payment-to-scheduling explanation.

Tradeoffs:

- Slightly more navigation.
- Cleaner separation of content from checkout.
- Easier to handle training-specific validation, terms, and error states.

### Option C: Shared Checkout Route With Training Mode

Route: `/checkout/training/[slug]` or `/checkout?type=training&program=...`

This creates a reusable checkout surface for future non-product flows.

Tradeoffs:

- More generic architecture.
- Less intuitive public URL.
- Can drift into premature abstraction for a small catalog.

## Selected Route Choice

Use Option B: `/training-programs/[slug]/checkout`.

Approved public journey:

1. User reads `/training-programs/[slug]`.
2. User clicks an enrollment CTA.
3. User lands on `/training-programs/[slug]/checkout`.
4. Server loads the training program and its linked checkout product.
5. User enters required checkout details using the same email that will be required for paid scheduling.
6. Server initializes Helcim checkout using authoritative full-program pricing and Ontario HST at 13% through Helcim.
7. Payment is verified server-side.
8. User lands on `/training-programs/[slug]/confirmation?order=...`.
9. Confirmation page shows booking in context and prompts the user to schedule a training call.
10. Customer also receives an expiring scheduling recovery link by email.
11. Booking flow uses `training-call` settings and carries safe training/order context; further training dates are coordinated manually after the call.

## Training Checkout UX Ideas

The checkout page should be intentionally different from product cart checkout:

- One program at a time.
- No quantity selector.
- Program summary with title, price, duration/format facts, and what happens next.
- “After payment, schedule your training call” copy before payment, not only after payment.
- Customer name and email fields reused from checkout; paid training-call scheduling requires the checkout email.
- Terms/refund policy checkbox if required.
- Secure Helcim payment button.
- Post-payment confirmation with a clear scheduling CTA.

## Post-Payment Booking Handoff Models

### Model 1: Prompt Only

After payment, show a button to `/booking?type=training-call`.

Pros:

- Smallest change.
- Reuses current booking page.
- No new token authorization model.

Cons:

- Does not prevent unpaid users from booking training calls.
- Does not prove the booking belongs to a paid order.
- Weakest business-logic distinction.

### Model 2: Paid Scheduling Link

After payment, generate a signed, scoped 14-day scheduling link tied to the private order ID, training program ID, and purchaser email.

Pros:

- Strong payment-to-booking handoff.
- Recoverable if the user closes the browser because the link can be emailed.
- Enables paid-but-unscheduled tracking.

Cons:

- Requires token design, expiry rules, and booking route changes.
- Requires decisions about whether public training calls remain available.

### Model 3: Embedded Booking On Confirmation

Render the booking flow directly on the training confirmation page using the paid order context.

Pros:

- Streamlined experience.
- Payment and scheduling feel like one flow.

Cons:

- More complex page state.
- Failure modes become more coupled.
- Harder to support “schedule later” without an emailed recovery link.

## Selected Handoff Choice

Use a hybrid of Model 2 and Model 3:

- The training confirmation page should show the booking experience or a direct scheduling button in context.
- The payment confirmation email must include a 14-day scheduling recovery link.
- Paid-context scheduling is only for the post-purchase training call; further program scheduling is manual.
- Paid-context scheduling must validate the private enrollment/order context and strictly match the checkout email.
- Public `/booking?type=training-call` remains available as a separate general training-call path.

## Private Data Model Considerations

Training purchases should create private checkout records plus a separate private `training_enrollments` record. Candidate enrollment metadata:

- `checkout_flow`: `product` or `training`.
- `training_program_id`.
- `training_program_slug`.
- `training_program_title_snapshot`.
- `checkout_product_id`.
- `purchase_kind`: `full`.
- `checkout_email` or a normalized email hash for strict scheduling match.
- `scheduling_status`: `pending`, `scheduled`, `expired`, or `manual_followup`.
- `scheduling_token_hash`.
- `scheduling_token_expires_at`.
- `scheduled_at` after successful Google Calendar insertion.
- `staff_alerted_at` for immediate paid-purchase notification tracking.

Do not store confirmed booking history in Sanity. If Google Calendar remains the sole booking record, the app should store only the minimum private state needed for eligibility, recovery, and operational support.

## Email And Recovery

Training checkout needs a stronger recovery path than product checkout because payment and scheduling may happen in separate steps.

Required emails:

- Customer payment confirmation with scheduling link.
- Nataliea/admin payment notification with program and paid/unscheduled status.
- Existing booking confirmation after Google Calendar event creation.
- Nataliea/admin booking notification after Google Calendar event creation.

Email failure should not mark payment failed, but should be logged for follow-up.

## Remaining Implementation Details

These are not business-blocking, but must be specified during implementation:

1. Exact no-slot copy and staff follow-up process.
2. Exact training enrollment table columns and retention policy.
3. Exact public-safe order/enrollment reference format.
4. Exact Calendar event description fields.

## Acceptance Criteria For The Future Spec

- A training program page has a clear purchase/enrollment path.
- Training checkout does not use the generic multi-product cart.
- Training payment success routes to a scheduling-focused confirmation surface.
- Enrollment is complete after verified payment.
- The scheduling prompt is recoverable if the user closes the browser.
- Paid scheduling links expire and require the checkout email.
- Payment remains allowed when no slots are available, with clear follow-up copy.
- Private order storage records enough training context for support and recovery.
- A separate private `training_enrollments` table tracks paid-but-unscheduled state.
- No private checkout or booking data is written to Sanity.
- Existing product checkout remains product-oriented.
- Existing booking remains Google Calendar-backed and server-validated.

## Explicit Non-Goals For V1

- Customer accounts.
- Admin enrollment/order UI for v1.
- Automated inventory/capacity enforcement.
- Refund automation.
- Payment plans/installments.
- Discounts and promo codes.
- Self-serve booking cancellation/rescheduling.
- Replacing Google Calendar as booking source of truth.
- Storing booking history in Sanity.
- Storing raw Helcim or Google secrets anywhere client-readable.
