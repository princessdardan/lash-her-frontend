# Booking Payment Provider Split

Date: 2026-05-23

Use this reference when checking whether a booking, checkout, or scheduling change is using the right provider boundary. Paid service bookings currently use Square card-on-file intake plus Square invoice-based no-show enforcement as the primary path; Square hosted checkout is retained only as a legacy/fallback path.

## Provider Map

| Flow                 | Payment provider                                                                                                          | Scheduling or calendar provider                                                           | Private state owner |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------- |
| Paid service booking | Square card-on-file intake + Square invoice-based no-show enforcement (primary); Square hosted checkout (legacy/fallback) | Lash Her slot UI plus Google Calendar API event creation                                  | Private Postgres    |
| Product checkout     | Helcim                                                                                                                    | Not applicable                                                                            | Private Postgres    |
| Training checkout    | Helcim                                                                                                                    | Paid token gate, then Google Appointment Schedule link or embed for intro-call scheduling | Private Postgres    |

Square is not a global payment provider. The primary service-booking path uses Square card-on-file and invoice APIs; the Square hosted checkout path is a legacy/fallback. Helcim remains the provider for product checkout and training checkout. Google Appointment Schedule is not used for service bookings.

## Current Primary Paid Service Booking Flow (Card-on-File / No-Show Invoice)

1. Customer selects a service and slot in the custom Lash Her booking UI.
2. The app revalidates availability against Google Calendar busy time and active private holds.
3. The app creates a private Postgres hold with the selected payment snapshot.
4. The app tokenizes the customer's card through Square Web Payments SDK and saves a Square card-on-file.
5. The app creates a Square order and a DRAFT invoice for the maximum authorized no-show amount against the saved card.
6. No-show enforcement publishes the invoice and charges the saved card through Square only after staff confirmation or an approved automated rule.
7. Square webhook or API reconciliation verifies the invoice/payment state server-side before finalization.
8. The shared finalizer creates or finds exactly one Google Calendar API event.
9. Private Postgres records the provider, payment, hold, card-on-file, invoice, and Calendar state. Sanity receives none of it.

Square invoice state and card-on-file state are not proof of payment until server-side reconciliation confirms a terminal state. The app must verify payment with Square and private DB state before finalization.

## Legacy Paid Service Booking Flow (Square Hosted Checkout)

1. Customer selects a service and slot in the custom Lash Her booking UI.
2. The app revalidates availability against Google Calendar busy time and active private holds.
3. The app creates a private Postgres hold with the selected payment snapshot.
4. The app redirects the customer to Square hosted checkout.
5. Square return or Square webhook reaches the app.
6. The app reconciles payment server-side before trusting it.
7. Verified Square payment moves private order and hold state into paid Calendar-pending status.
8. The shared finalizer creates or finds exactly one Google Calendar API event.
9. Private Postgres records the provider, payment, hold, and Calendar state. Sanity receives none of it.

Square browser return is not proof of payment. Query values on the return URL are only lookup hints. The app must verify payment with Square and private DB state before finalization.

If a verified paid service hold is expired or conflicts with another booking, the workflow is rebooking first. Keep the private record in `paid_unbookable_rebooking_pending`, offer a replacement time, verify availability before creating a Calendar event, and refund only after rebooking fails or staff chooses refund.

## Product And Training Checkout

Product checkout and training checkout stay on Helcim. They use the existing commerce checkout routes, Helcim payment verification, Helcim webhook handling, private Postgres order/payment state, and redacted operational evidence.

These flows should not require Square variables. If a product or training checkout path fails because a Square env var is missing, treat that as a provider-boundary regression.

## Paid Training Intro-Call Scheduling

Paid training intro-call scheduling starts after Helcim payment verification and private enrollment state are complete.

1. Helcim verifies training checkout payment.
2. Private Postgres marks the enrollment/order paid and stores schedule token state.
3. The customer opens the tokenized paid training schedule page.
4. The app checks token eligibility against private state.
5. Only after eligibility passes, the page renders the Google Appointment Schedule link or embed from public training-program configuration.

The app does not mark the enrollment scheduled just because the page rendered. Invalid, unpaid, expired, or wrong-program tokens must not reveal the Google Appointment Schedule URL.

## Privacy Boundary

Sanity stores public/editorial content and provider-neutral configuration only. Do not store private payment state, transaction history, checkout tokens, service holds, customer snapshots, paid training token data, Square identifiers, Helcim identifiers, or scheduling token data in Sanity.

Use private Postgres for sensitive provider state and use redacted evidence in docs, tickets, and release notes.

## Environment Boundary

Server-only Square variables:

```env
SERVICE_BOOKING_SQUARE_ENABLED=true
SQUARE_ENVIRONMENT=sandbox
SQUARE_ACCESS_TOKEN=<square-access-token>
SQUARE_LOCATION_ID=<square-location-id>
SQUARE_WEBHOOK_SIGNATURE_KEY=<square-webhook-signature-key>
SQUARE_SERVICE_BOOKING_RETURN_URL=https://<domain>/api/booking/square/return
SQUARE_SERVICE_BOOKING_WEBHOOK_URL=https://<domain>/api/webhooks/square
```

Do not expose Square secrets with `NEXT_PUBLIC_`. In Vercel, scope sandbox Square values to Development and Preview, and scope production Square values to Production.
