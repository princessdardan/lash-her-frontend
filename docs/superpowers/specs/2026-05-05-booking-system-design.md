# Google Calendar booking system design

> **Historical note (2026-05-17):** This approved design predates the private DB marketing/contact migration. Any references to live Sanity form submissions, Sanity marketing opt-in records, `SANITY_FORM_TOKEN`, or `bookingMarketingOptIn` as a current write target are historical. Current live form/contact/marketing writes belong in the private DB; Sanity submission documents are legacy/backfill source records only.

Date: 2026-05-05
Status: Approved design for implementation planning

## Purpose

Build a scheduling-only booking system for Lash Her that lets visitors instantly book either a training sign-up call or an in-person appointment. Google Calendar is the operational source of truth for availability and confirmed bookings, including appointments booked through third-party systems such as Fresha.

The launch version does not include payments, Google Meet links, self-serve cancellation, self-serve rescheduling, approval workflows, separate staff calendars, or persisted booking history outside Google Calendar.

## Existing Project Context

The active app is the existing Next.js frontend in `/Users/dardan/Documents/lash-her/frontend`. It already uses Sanity for CMS-managed page content, server actions for general inquiry and training contact forms, Resend for branded email, and Sanity documents for form submissions. No current Google Calendar integration, slot generation, booking engine, cancellation flow, or payment-gated scheduling flow exists.

Relevant existing patterns:

- `frontend/src/app/actions/form.ts` validates submissions server-side, writes structured data, and sends non-blocking email.
- `frontend/src/lib/form-validation.ts` centralizes form validation rules.
- `frontend/src/lib/email.ts` sends branded admin and user emails with Resend.
- `frontend/src/data/loaders.ts` is the central Sanity/GROQ read layer.
- `frontend/src/sanity/schemas` holds CMS document and object definitions.
- `frontend/src/components/custom/collection` contains the current client-side form experiences.

## Approved Architecture

The system will use four boundaries:

1. **Google Calendar**: Source of truth for availability windows, third-party Fresha bookings, manual busy events, and site-created bookings.
2. **Sanity**: Source of truth for booking configuration, booking page copy, booking type settings, type-specific questions, and marketing opt-in records only.
3. **Next.js server layer**: Owns availability reads, slot generation, final booking validation, concurrency protection, Google Calendar event creation, Resend confirmation, and optional marketing opt-in writes.
4. **Private operational store**: Stores non-booking infrastructure data such as the Google OAuth refresh token, short-lived booking locks, and idempotency keys.

Google Calendar remains the only persisted booking record. Sanity must not store confirmed appointment date/time as booking history.

## Google Calendar Ownership and Authentication

The booking calendar is a personal Gmail calendar owned by Nataliea. Because this is not a Google Workspace domain-wide-delegation setup, the app will use a one-time OAuth connection by Nataliea during setup.

The refresh token must be stored server-side only in the private operational store. Client code must never receive OAuth tokens. The integration should request the narrowest practical Google Calendar scope that supports reading events, reading availability, and inserting booking events with guests.

The system needs a protected reconnect/setup path so Nataliea can re-authorize Google access if the refresh token is revoked, expires, or the Google consent grant changes.

## Availability Model

Nataliea manages availability directly inside the same Google Calendar by creating events with a Sanity-configurable marker title. The default marker title is `Available for booking`.

Availability marker events are bookable containers. They are not bookings and are not modified after a booking is made. When a slot is booked, the app creates a new Google Calendar booking event, and future availability calculations subtract that busy event from the unchanged availability window.

This approach also handles Fresha correctly: Fresha-created events on the same calendar are treated as busy conflicts and remove overlapping slots. The site does not need to identify or display Fresha-origin events differently.

## Slot Generation Rules

Sanity will define booking configuration, including:

- booking types for training sign-up calls and in-person appointments,
- duration per booking type, with launch expectation that neither exceeds one hour,
- slot interval per booking type,
- before-buffer and after-buffer per booking type, defaulting to zero unless configured,
- booking horizon, configurable with a default of 30 days,
- minimum lead time, configurable with a default of 24 hours,
- availability marker title, defaulting to `Available for booking`,
- user-facing labels, helper text, and type-specific questions.

To display slots, the server reads Google Calendar events within the configured booking horizon, finds availability marker events, removes slots inside the minimum lead time, subtracts all busy events on the same calendar, applies booking type duration and buffers, and returns only valid start times for the selected booking type.

## Booking Creation Flow

Bookings are instant-confirmed.

Server-side booking flow:

1. User selects a booking type and available slot.
2. User enters contact details, answers type-specific Sanity-configured questions, and optionally opts into marketing.
3. Server validates the booking request against current Sanity booking configuration.
4. Server acquires a short-lived whole-calendar booking lock in the private operational store.
5. Server re-reads Google Calendar and verifies the selected slot still fits inside an availability marker event and does not overlap any busy event or buffer-adjusted conflict.
6. Server creates a Google Calendar event on Nataliea's calendar with the user added as a guest.
7. Server sends a branded Resend confirmation email.
8. If marketing opt-in was checked, server writes the approved marketing opt-in fields to Sanity.
9. Server releases the booking lock and returns success.

The whole-calendar lock is intentionally simple for v1. Google Calendar does not provide an atomic “check and book” transaction, so relying only on `freeBusy.query` and `events.insert` can double-book under simultaneous requests.

## User Experience

The site will support both:

- a shared booking page where users choose between training sign-up call and in-person appointment,
- embedded entry points elsewhere in the site that preselect the booking type and send users into the same booking experience.

The customer flow is:

1. Choose or arrive with a preselected booking type.
2. Choose an available slot.
3. Enter contact information and type-specific answers.
4. Opt into marketing if desired.
5. Review the booking details.
6. Confirm the booking.
7. Receive success messaging, a branded confirmation email, and a Google Calendar guest invitation.

For v1, users cannot cancel or reschedule themselves. Confirmation copy should tell users to contact Nataliea for changes. Training sign-up calls do not include automatic Google Meet links in v1.

## Marketing Opt-In Persistence

Google Calendar is the only booking record. Sanity will store a marketing opt-in record only when the user explicitly checks the marketing opt-in checkbox.

The approved Sanity marketing opt-in fields are:

- name,
- email,
- phone,
- booking type,
- type-specific answers.

No additional marketing fields are approved in this design. Appointment date/time is not part of the approved marketing opt-in record. Consent proof metadata, if required, is an open implementation decision.

## Email and Calendar Invitations

The system sends both a Google Calendar guest invitation and a branded Resend confirmation email.

The Google Calendar event is the operational confirmation because Calendar is the source of truth. The Resend email is the branded customer experience and should summarize the booking, explain that changes require contacting Nataliea, and avoid implying a separate booking record exists outside Calendar.

If the Google Calendar event is created but Resend fails, the booking remains confirmed. The user should still see success, while the failure is logged for follow-up. If Google Calendar creation fails, the booking is not confirmed.

## Failure Handling

- If Google OAuth is disconnected or refresh fails, booking should be blocked and the user should see a clear message to contact Nataliea.
- If Google Calendar cannot be read, slots should not be shown as available.
- If the selected slot is no longer available during final validation, the user should be asked to choose another slot.
- If lock acquisition fails because another booking is in progress, the user should retry after a short delay.
- If Google event insertion succeeds but Sanity marketing opt-in write fails, the booking remains confirmed and the opt-in failure should be logged.
- If Resend fails after Calendar insertion, the booking remains confirmed and the email failure should be logged.

## Testing Strategy

Testing should cover slot generation, booking creation, concurrency protection, and failure paths without calling live Google Calendar or Resend in normal test runs.

Required coverage:

- availability marker events convert into valid candidate slots,
- minimum lead time and booking horizon are enforced,
- duration, slot interval, and buffers are applied per booking type,
- busy events from Google, Fresha, manual entries, and site-created bookings subtract from availability windows,
- final server-side re-check rejects stale slots,
- whole-calendar locking prevents parallel inserts from double-booking,
- Google Calendar event insert payload adds the user as a guest,
- no Google Meet link is requested in v1,
- Resend confirmation is sent after confirmed booking creation,
- marketing opt-in writes only when checkbox consent is present,
- Google/OAuth/API/email/Sanity failure paths return the correct user-facing outcome.

## Security and Privacy Requirements

- Google OAuth tokens must never be exposed to client code.
- Refresh token storage must be server-only and encrypted where the chosen operational store supports it.
- Booking writes must happen only on the server.
- Client-selected slot data must be treated as untrusted and revalidated against Google Calendar before event creation.
- Google Calendar event details should include only information Nataliea needs to operate the booking.
- Marketing opt-in writes must require explicit checkbox consent.
- The system must not silently fail open by showing stale availability when Calendar reads fail.

## Non-Goals for Launch

- Payment, deposits, or full prepayment.
- Google Meet links.
- Self-serve cancellation.
- Self-serve rescheduling.
- Approval-required booking workflows.
- Separate availability calendars.
- Multiple staff calendars.
- Splitting or modifying availability marker events after booking.
- Persisted booking history in Sanity.
- Fresha-specific labeling or reporting in the site.

## Open Implementation Decisions

These do not change the approved design, but must be resolved during implementation planning:

- Exact private operational store for OAuth token, lock, and idempotency data.
- Whether the Google OAuth setup path is implemented as a temporary protected admin route or a permanent maintenance route.
- Exact Google Calendar OAuth scopes.
- Exact Sanity schema names for booking config, booking questions, and marketing opt-ins.
- Exact route names for the shared booking page and embedded entry-point behavior.
- Exact confirmation email copy and admin logging destination.
- Exact lock timeout and retry behavior.
- Whether marketing opt-ins need consent proof metadata such as consent timestamp, source form/page, displayed consent text, consent version, IP address, or user agent.
