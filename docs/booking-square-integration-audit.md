# Booking Flow & Square Integration Audit

**Date:** 2026-07-02
**Scope:** Service booking flow, Square integration, data models, payment/session lifecycle, no-show enforcement, reconciliation, and related documentation in `/Users/dardan/workspace/lash-her-frontend`.
**Method:** Static code and documentation review. No tests were executed; no source code was modified.

---

## Executive Summary

The service booking implementation is substantially more mature than the existing architecture docs describe. The **active** customer-facing flow is no longer the legacy Square Payment Link checkout nor the card-on-file-only (`STORE` intent) flow documented in `docs/booking-system-architecture-reference.md` and `docs/square-service-booking-setup.md`. Instead, the current primary path uses **Square Web Payments SDK with `CHARGE_AND_STORE` intent**, taking an immediate payment authorization + capture, saving the card on file, and finalizing the Google Calendar event in a single server-side transaction.

The code is generally well-structured: idempotency markers, terminal-state guards, refund-required fallbacks, policy acceptance hashing, and reconciliation monitoring are all present. However, there are material gaps between code reality and documentation reality, plus a few operational risks around stale legacy routes, generic success redirects, and no-show charge lifecycle edge cases that deserve attention before production enablement.

---

## 1. Current Canonical Flow (Confirmed by Code)

### 1.1 End-to-end path

1. **Service selection & slot loading**
   - `src/app/(site)/services/[slug]/booking/page.tsx` loads `BookingSettings`, the target `TService`, and all bookable services via `loaders`.
   - `src/components/booking/booking-flow.tsx` calls `GET /api/booking/availability?service=<slug>` to load slots.
2. **Hold creation**
   - Submitting the details step calls `createBookingHold()` in `booking-flow.tsx:728`, which `POST`s `/api/booking/holds`.
   - `src/app/api/booking/holds/route.ts` creates the hold with **placeholder customer data** (`PENDING_CUSTOMER` at `route.ts:27-31`):
     - email: `pending-service-booking@example.invalid`
     - name: `"Pending service booking customer"`
     - phone: `"0000000000"`
   - The hold contains `paymentSessionReference` and redirects the browser to the dedicated payment page.
3. **Payment page**
   - `src/app/(site)/services/[slug]/booking/payment/page.tsx` resolves the session via `resolveServiceBookingPaymentSession()`.
   - If already `booked` or a manual-followup terminal state, it redirects to `/booking/confirmation?payment=<status>` (`page.tsx:49-51`).
   - Otherwise it renders `ServiceBookingPaymentShell` → `ServiceBookingPaymentForm`.
4. **Square Web Payments `CHARGE_AND_STORE`**
   - `src/components/booking/service-booking-payment-form.tsx` collects real customer details (name, email, phone, marketing opt-in, payment option, policy acceptance).
   - It mounts `SquareChargeAndStoreForm`, which fetches `/api/booking/square/config`, loads the Square Web Payments SDK, and tokenizes with `intent: "CHARGE_AND_STORE"` (`square-charge-and-store-form.tsx:246`).
   - On tokenization it `POST`s `/api/booking/payment/confirm`.
5. **Server confirmation**
   - `src/app/api/booking/payment/confirm/route.ts` validates the request and delegates to `confirmChargeAndStoreBooking()` in `src/lib/booking/payments/service-charge-and-store.ts`.
   - The orchestrator:
     - Claims the hold with a 30s in-progress TTL.
     - Persists real customer + payment selection.
     - Creates/reuses a Square customer via `createOrReuseSquareCustomer()`.
     - Authorizes and captures a Square payment using `createCardOnFilePayment` with `autocomplete: false` then `completePayment()`.
     - Saves the card via Square Cards API (`CreateCard` sourced from the approved payment).
     - Persists policy acceptance, saved payment method, and a no-show charge record.
     - If the customer did **not** pay full price, creates a Square **draft no-show invoice** for the remaining balance.
     - Finalizes the Google Calendar event via `CardOnFileCalendarFinalizer`.
     - Marks the hold `booked` (or `manual_followup` on calendar failure).
6. **Post-confirmation redirect**
   - `ServiceBookingPaymentShell` redirects to `/booking/confirmation?payment=booked|manual_followup` (`service-booking-payment-shell.tsx:22-27`).

### 1.2 Key code references

| Step                              | File                                                                  | Lines           |
| --------------------------------- | --------------------------------------------------------------------- | --------------- |
| Placeholder customer at hold time | `src/app/api/booking/holds/route.ts`                                  | 27-31           |
| Payment session resolution        | `src/lib/booking/payment-session.ts`                                  | 60-110          |
| CHARGE_AND_STORE tokenization     | `src/components/booking/square-charge-and-store-form.tsx`             | 242-278         |
| Confirm route wiring              | `src/app/api/booking/payment/confirm/route.ts`                        | 93-108, 210-253 |
| Charge-and-store orchestrator     | `src/lib/booking/payments/service-charge-and-store.ts`                | 221-1129        |
| Calendar finalizer                | `src/lib/booking/payments/service-card-on-file-calendar-finalizer.ts` | 55-207          |
| Repository / in-progress marker   | `src/lib/private-db/service-booking-payment-repository.ts`            | 18-45, 47-634   |

---

## 2. Data Model & Storage Boundaries

### 2.1 Postgres tables involved

All private booking/payment state lives in Postgres via Drizzle. Sanity is used only for editorial service config and booking settings.

| Table                             | Role                                           | Key columns                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `appointment_holds`               | Central booking lifecycle record               | `payment_session_reference` (unique, not null since migration `0015`), `status`, `offering_snapshot`, `customer_snapshot`, `selected_start`, `selected_end`, `google_event_id`, `saved_payment_method_id`, `policy_acceptance_id`, `no_show_charge_record_id`, `square_customer_id`, `square_card_id`, `card_on_file_status`, `reconciliation_metadata`, `finalization_status` |
| `checkout_orders`                 | Legacy hosted-checkout order cart              | Used by `square-service-checkout.ts`; linked to hold via `checkout_order_id`                                                                                                                                                                                                                                                                                                   |
| `checkout_payment_events`         | Idempotent Square webhook/return event log     | `provider_event_id`, `no_show_charge_record_id`, `processing_status`                                                                                                                                                                                                                                                                                                           |
| `booking_square_customers`        | Square customer reference per normalized email | `email_normalized`, `square_customer_id`                                                                                                                                                                                                                                                                                                                                       |
| `booking_saved_payment_methods`   | Saved Square card metadata (no raw tokens)     | `square_card_id`, `card_brand`, `card_last4`, `card_exp_month`, `card_exp_year`, `status`                                                                                                                                                                                                                                                                                      |
| `booking_policy_acceptances`      | No-show policy acceptance audit                | `hold_id`, `policy_version`, `policy_text_hash`, `max_charge_cents`, `ip_hash`, `user_agent_hash`                                                                                                                                                                                                                                                                              |
| `booking_no_show_charge_records`  | No-show charge instrument state                | `hold_id`, `saved_payment_method_id`, `square_invoice_id`, `square_order_id`, `square_payment_id`, `status`, `provider_metadata`, admin audit columns                                                                                                                                                                                                                          |
| `booking_no_show_charge_attempts` | Per-attempt idempotency for admin charges      | `no_show_charge_record_id`, `idempotency_key`, `amount_cents`, `status`                                                                                                                                                                                                                                                                                                        |

### 2.2 Migration evidence

- `drizzle/0015_service_booking_payment_session.sql` adds `payment_session_reference` as `NOT NULL` with a unique btree index.
- The schema at `src/lib/private-db/schema.ts:401-529` shows the full `appointment_holds` table with all Square/card-on-file/no-show foreign keys.

### 2.3 Sanity boundaries (respected)

- `src/sanity/schemas/documents/service.ts` stores only public service metadata, pricing, add-ons, and SEO.
- `src/sanity/schemas/documents/booking-settings.ts` stores calendar ID, hours, intake questions, timezone, and marketing opt-in label.
- No PII, payment state, holds, or transaction history is stored in Sanity. This aligns with `AGENTS.md` constraints.

---

## 3. Square Integration Details

### 3.1 Active flow: `CHARGE_AND_STORE`

- The browser SDK config endpoint is `GET /api/booking/square/config` (`src/app/api/booking/square/config/route.ts`).
- The SDK is loaded from `https://(sandbox.)web.squarecdn.com/v1/square.js` based on environment.
- Tokenization uses:
  - `intent: "CHARGE_AND_STORE"`
  - `currencyCode: "CAD"`
  - Billing contact with `countryCode: "CA"`, given/family name split, email, phone.
- Server-side Square payment creation uses `autocomplete: false` (authorize), then `completePayment()` to capture.
- Card saving uses `CreateCard` with `source_id: paymentResponse.payment.id`.

This is a meaningful departure from the docs, which describe a `STORE`-only card save with no immediate charge.

### 3.2 Legacy / fallback flows still present

| Flow                                | Status               | Notes                                                                                                                                                                                      |
| ----------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Legacy Square Payment Link checkout | Stale but wired      | `src/app/api/booking/checkout/route.ts` + `src/lib/booking/square-service-checkout.ts` create a Square Payment Link and update `appointment_holds` to `payment_pending`.                   |
| Square return reconciliation        | Active for legacy    | `src/app/api/booking/square/return/route.ts` calls `finalizeSquarePayment()` (`src/lib/booking/square-payment-finalizer.ts`).                                                              |
| Card-on-file-only (`STORE`) route   | Gated, likely unused | `src/app/api/booking/card-on-file/route.ts` is gated by `SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED`. The active flow uses `CHARGE_AND_STORE` and `/api/booking/payment/confirm` instead. |

**Finding:** The legacy Payment Link route (`/api/booking/checkout`) and the `STORE`-only card-on-file route (`/api/booking/card-on-file`) are both still in the codebase but appear to be superseded by `/api/booking/payment/confirm`. The docs describe the `STORE`-only path as primary, which is no longer accurate.

### 3.3 Webhooks

- `src/app/api/webhooks/square/route.ts` verifies `x-square-hmacsha256-signature` against `SQUARE_SERVICE_BOOKING_WEBHOOK_URL` and the raw body.
- It handles:
  - `invoice.payment_made` for training Square invoices.
  - No-show charge finalization via `tryFinalizeNoShowCharge()`.
  - Legacy service booking payment finalization via `finalizeSquarePayment()`.
- It correctly routes training invoice events before service-booking/no-show paths.

### 3.4 No-show charge lifecycle

- `src/lib/booking/payments/service-no-show-invoice.ts` creates a Square draft order + invoice for the remaining balance when the customer does not pay in full.
- The invoice uses `automatic_payment_source: "CARD_ON_FILE"` and `card_id: <saved card>`.
- `src/app/api/admin/appointments/[id]/no-show/route.ts` allows staff to publish the invoice and charge the saved card.
- `service-no-show-invoice.ts:477-1197` implements stale `charge_pending` recovery, idempotent claim, compare-and-set persistence, and careful handling of PAID-without-payment-id cases.

---

## 4. Sanity Dependencies

- `loaders.getBookableServiceBySlug(slug)` and `loaders.getBookingSettings()` are used server-side in the booking page and availability/holds handlers.
- `loaders.ts:90-108` defines the `SERVICE_PROJECTION`, which includes `fullPrice`, `depositAmount`, `addOns`, `durationMinutes`, etc.
- All Sanity reads are routed through `src/data/loaders.ts`, consistent with `AGENTS.md`.

---

## 5. API Route Map

| Route                                  | Method   | Purpose                                         | Status                |
| -------------------------------------- | -------- | ----------------------------------------------- | --------------------- |
| `/api/booking/availability`            | GET/POST | Slot availability                               | Active                |
| `/api/booking/holds`                   | POST     | Create 10-minute hold with placeholder customer | Active                |
| `/api/booking/payment/confirm`         | POST     | Square `CHARGE_AND_STORE` confirmation          | **Active primary**    |
| `/api/booking/square/config`           | GET      | Public Square Web Payments SDK config           | Active                |
| `/api/booking/square/return`           | GET      | Legacy Square return reconciliation             | Active for legacy     |
| `/api/booking/checkout`                | POST     | Legacy Square Payment Link checkout             | Stale / fallback only |
| `/api/booking/card-on-file`            | POST     | `STORE`-only card-on-file confirmation          | Gated, likely unused  |
| `/api/webhooks/square`                 | POST     | Square webhook handler                          | Active                |
| `/api/admin/appointments/[id]/no-show` | POST     | Staff no-show charge command                    | Active                |
| `/api/admin/payment-reconciliation`    | GET      | Cron/operator reconciliation monitor            | Active                |

---

## 6. Tests & Docs Coverage

### 6.1 Tests

| Test file                                    | What it covers                                                                                    | Relevance to current flow          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `tests/service-booking-payment-page.spec.ts` | Full `CHARGE_AND_STORE` flow: hold → payment page → Square mount → confirm → generic confirmation | **High** — matches active code     |
| `tests/booking-card-on-file-config.spec.ts`  | Legacy fallback when `/api/booking/square/config` returns 404                                     | Medium — tests stale fallback path |
| `tests/booking.spec.ts`                      | Legacy Square Payment Link checkout and return redirect                                           | Low — tests stale path             |

No tests were run during this audit.

### 6.2 Documentation drift

| Document                                        | Claim vs. code                                                                                                            | Severity                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `docs/booking-system-architecture-reference.md` | Describes primary flow as `STORE` tokenization → save card → draft no-show invoice → calendar finalize.                   | **High** — current flow is `CHARGE_AND_STORE` with immediate capture.              |
| `docs/square-service-booking-setup.md`          | Lists `/api/booking/card-on-file` as the card-on-file confirmation route and describes `STORE` intent.                    | **High** — active route is `/api/booking/payment/confirm` with `CHARGE_AND_STORE`. |
| `docs/square-service-booking-setup.md`          | Sandbox certification step 5 says "Complete one successful booking through Square Web Payments SDK `STORE` tokenization." | **High** — needs to say `CHARGE_AND_STORE`.                                        |
| `docs/booking-system-architecture-reference.md` | Legacy Square hosted checkout is described as fallback when card-on-file is disabled.                                     | Medium — true, but the `CHARGE_AND_STORE` path is never mentioned.                 |

---

## 7. Risks & Findings

### 7.1 High severity

#### H1: Documentation does not describe the active payment flow

- **Finding:** The active customer flow uses Square `CHARGE_AND_STORE` (immediate authorization + capture + card save) through `/api/booking/payment/confirm`. Existing docs describe a `STORE`-only card-on-file flow via `/api/booking/card-on-file`.
- **Files:** `docs/booking-system-architecture-reference.md`, `docs/square-service-booking-setup.md`.
- **Impact:** Operators reading the docs will expect a different payment lifecycle, no-show invoice timing, and reconciliation behavior. Staging certification steps are wrong.
- **Confirmed issue:** Yes.

#### H2: Generic confirmation redirect loses service/order context

- **Finding:** `ServiceBookingPaymentShell` redirects to `/booking/confirmation?payment=booked|manual_followup` (`service-booking-payment-shell.tsx:22-27`). The payment page itself also redirects confirmed sessions to the same generic URL (`src/app/(site)/services/[slug]/booking/payment/page.tsx:49-51`).
- **Impact:** Customers who refresh or share the confirmation URL cannot be tied back to a specific service, hold, or order without server-side session resolution. Post-booking analytics and debugging are harder.
- **Confirmed issue:** Yes.

#### H3: Placeholder customer data is stored in the hold

- **Finding:** The initial `appointment_holds` row is created with placeholder email/name/phone (`pending-service-booking@example.invalid`, etc.). Real customer data is only persisted during `/api/booking/payment/confirm`.
- **Files:** `src/app/api/booking/holds/route.ts:27-31`, `src/lib/booking/payments/service-charge-and-store.ts:408-449`.
- **Impact:** Any intermediate state, logs, or reconciliation queries between hold creation and payment confirmation show placeholder PII. Marketing consent and customer audit trail start only at payment time.
- **Confirmed issue:** Yes.

### 7.2 Medium severity

#### M1: Legacy Square Payment Link route remains but is likely unmaintained

- **Finding:** `/api/booking/checkout` and `square-service-checkout.ts` still create Payment Links, but the active UI does not appear to call them. They could drift from the current data model.
- **Impact:** If ever re-enabled as a fallback, the route may not align with the `CHARGE_AND_STORE` repository expectations (e.g., `cardOnFileStatus`, no-show charge record creation).
- **Confirmed issue:** Yes.

#### M2: `SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED` flag semantics are confusing

- **Finding:** This flag currently gates `/api/booking/card-on-file` and `/api/booking/square/config`, but the active `CHARGE_AND_STORE` flow is gated by `SERVICE_BOOKING_SQUARE_ENABLED` in `src/app/api/booking/payment/confirm/route.ts:94-99`.
- **Impact:** Enabling card-on-file in docs does not match enabling the current primary flow. Environment setup instructions are misleading.
- **Confirmed issue:** Yes.

#### M3: No-show draft invoice failure cancels the entire booking

- **Finding:** In `service-charge-and-store.ts:820-892`, if `createDraftNoShowInvoice` fails for a partial payment, the code cancels the already-captured Square payment and fails the booking.
- **Impact:** A transient Square Invoices API failure turns a successful payment into a refund-required/manual state, even though the card is already saved. This is conservative but may cause unnecessary operational load.
- **Confirmed issue:** Yes.

### 7.3 Low severity

#### L1: `booking.spec.ts` exercises a mocked legacy shell, not the real React components

- **Finding:** The test injects a plain HTML page and manually calls legacy endpoints.
- **Impact:** Low direct risk, but it does not validate the current `BookingFlow` / `ServiceBookingPaymentForm` components.
- **Confirmed issue:** Yes.

#### L2: Tax comment in `service-tax-policy.ts` still references "Square Payment Links"

- **Finding:** Header comment says "Ontario HST tax policy for service bookings paid via Square Payment Links."
- **Impact:** Minor documentation staleness.
- **Confirmed issue:** Yes.

---

## 8. Follow-up Questions

1. **Is the legacy `/api/booking/card-on-file` `STORE`-only path intentionally preserved for a future variant, or should it be removed/deprecated?**
2. **Should the confirmation redirect include the service slug, hold reference, or order ID to improve post-booking UX and support?**
3. **Should the initial hold creation accept and store real customer contact details, or is the placeholder-by-design acceptable?**
4. **Is the no-show draft invoice failure policy intentionally hard-fail, or should partial-payment bookings be allowed to finalize with a manual-followup no-show instrument instead of canceling the payment?**
5. **Should `SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED` be retired in favor of a single `SERVICE_BOOKING_SQUARE_ENABLED` flag?**

---

## 9. Recommended Next Steps

1. **Rewrite booking/Square docs** to describe the `CHARGE_AND_STORE` primary flow, the `/api/booking/payment/confirm` route, and the correct environment flags.
2. **Deprecate or remove** the legacy `/api/booking/card-on-file` `STORE`-only path if it is no longer intended for production.
3. **Clarify fallback strategy** for the legacy Payment Link route; if it is truly fallback-only, add explicit integration tests that prove it works with the current data model.
4. **Improve confirmation redirect** by including `serviceSlug` and `holdReference` query params (while keeping payment status generic for security).
5. **Review no-show draft invoice failure handling** to decide whether a saved card alone is sufficient to allow booking finalization when invoice creation fails.
6. **Reconcile environment flags** so there is one clear feature flag for Square service booking and a separate flag only if the legacy `STORE`-only path is retained.
7. **Run the existing test matrix** against a migrated staging clone per `docs/square-service-booking-setup.md` before any production flag change.

---

## 10. File Index

- `src/components/booking/booking-flow.tsx`
- `src/app/(site)/services/[slug]/booking/page.tsx`
- `src/app/(site)/services/[slug]/booking/payment/page.tsx`
- `src/components/booking/service-booking-payment-shell.tsx`
- `src/components/booking/service-booking-payment-form.tsx`
- `src/components/booking/square-charge-and-store-form.tsx`
- `src/components/booking/square-card-on-file-form.tsx`
- `src/app/api/booking/availability/route.ts`
- `src/app/api/booking/holds/route.ts`
- `src/app/api/booking/payment/confirm/route.ts`
- `src/app/api/booking/card-on-file/route.ts`
- `src/app/api/booking/checkout/route.ts`
- `src/app/api/booking/square/config/route.ts`
- `src/app/api/booking/square/return/route.ts`
- `src/app/api/webhooks/square/route.ts`
- `src/lib/booking/payments/service-charge-and-store.ts`
- `src/lib/private-db/service-booking-payment-repository.ts`
- `src/lib/private-db/card-on-file-repository.ts`
- `src/lib/private-db/schema.ts`
- `src/lib/env/private-checkout.ts`
- `src/lib/booking/square-service-checkout.ts`
- `src/lib/booking/square-payment-finalizer.ts`
- `src/lib/booking/payment-session.ts`
- `src/lib/booking/holds.ts`
- `src/lib/booking/finalizer.ts`
- `src/lib/booking/payments/service-card-on-file-calendar-finalizer.ts`
- `src/app/api/admin/appointments/[id]/no-show/route.ts`
- `src/lib/booking/payments/service-no-show-invoice.ts`
- `src/lib/booking/payments/service-reconciliation-monitor.ts`
- `src/app/api/admin/payment-reconciliation/route.ts`
- `src/sanity/schemas/documents/booking-settings.ts`
- `src/sanity/schemas/documents/service.ts`
- `src/data/loaders.ts`
- `drizzle/0015_service_booking_payment_session.sql`
- `tests/service-booking-payment-page.spec.ts`
- `tests/booking-card-on-file-config.spec.ts`
- `tests/booking.spec.ts`
- `docs/booking-system-architecture-reference.md`
- `docs/square-service-booking-setup.md`
