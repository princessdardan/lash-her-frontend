# Admin Dashboard Design

## Purpose

Build an owner-friendly admin dashboard at `/admin` that lets authorized business users interface with the private PostgreSQL database without using raw database tools. The dashboard supports daily operations, revenue visibility, domain-specific record review, marketing decision support, and privacy/DSAR workflows.

The dashboard must preserve the existing boundary: Sanity stores public/editorial content, while private operational data stays in PostgreSQL through `src/lib/private-db` and domain services.

## Current Context

The existing app is a Next.js 16 application that contains the public site, API routes, Sanity Studio, private database logic, checkout, booking, training checkout, marketing contact capture, and email workflows.

Private DB tables already include:

- `checkout_orders` for product, training, and service payment records, split by `purpose`.
- `checkout_payment_events` for Helcim/Square payment event records.
- `appointment_holds` for service booking holds, payment reconciliation, and calendar finalization state.
- `training_enrollments` for paid training enrollment scheduling state.
- `marketing_contacts` for opted-in consolidated marketing contacts.
- `marketing_contact_submissions` for inquiry, popup, booking marketing choice, training contact, and backfill submissions.
- `marketing_consent_events` for consent, no-consent, unsubscribe, and backfill evidence.

Existing admin routes are API-only and secret-protected: private data retention cleanup and transactional email retry. There is no existing app-level admin UI, auth middleware, or managed-auth dependency in the project.

The launch readiness checklist requires access control, audit logging, and approved retention/privacy policy before private-record admin UI is added. This design treats those as first-class requirements.

## Goals

- Give the owner a low-to-mid tech-literate interface for smooth business operations.
- Keep products/orders, services/bookings, training, marketing, and privacy workflows clearly separated in the UI even when they share database tables.
- Provide one unified revenue/purchases route or widget across product, service, and training transactions.
- Present marketing data in a way that supports decisions about lead source quality, audience health, and training demand.
- Include privacy/DSAR request tracking, owner-only full exports, correction/deletion/redaction decision tracking, and access logs from day one.
- Use managed authentication with internal `owner` and `operator` roles.
- Audit sensitive access and actions without storing unnecessary PII in audit metadata.
- Design the full product shape now while implementing a conservative first release.

## Non-Goals For V1

- No broad direct editing of raw private database fields.
- No direct deletion or redaction execution from the dashboard.
- No direct service booking creation; confirmed appointments remain payment-reconciled.
- No raw webhook payload display in normal views.
- No full analytics/reporting layer with custom charts and advanced segmentation.
- No broad CSV exports outside owner-only DSAR/privacy request exports.
- No custom authentication system unless managed auth becomes impossible.

## Product Phasing

### V1: Safe Admin Foundation

V1 includes:

- `/admin` route group inside the existing Next app.
- Managed-auth integration with internal role resolution.
- `owner` and `operator` roles.
- Access and action audit logging.
- Operations-inbox command center.
- Read-only domain workspaces for orders, bookings, training, and marketing.
- Unified revenue/purchases view.
- Privacy/DSAR request tracking.
- Owner-only full exports linked to active privacy requests.
- Troubleshooting panels for provider/payment details, separated from normal screens.

V1 does not directly mutate payment, booking, or retention-critical private records except for new admin support records such as privacy requests, privacy request events, audit entries, and internal notes.

### Later Phases

Later phases can add guided domain actions using the same permission and audit foundations:

- Retry transactional emails through the existing retry service.
- Mark manual follow-up states where domain rules allow it.
- Correct marketing/contact details.
- Close privacy requests.
- Add tags and assignment metadata.
- Record rebooking/refund-required workflow decisions.
- Add richer reporting, charting, and export templates.
- Add role management UI if managed-auth metadata is not sufficient.

## Architecture

The dashboard lives in the existing app under `src/app/admin`, outside the public `(site)` route group and separate from `/studio`.

Create a new server-side admin boundary under `src/lib/admin`:

- `auth`: resolves managed-auth session identity to internal admin user and role.
- `permissions`: answers whether the current actor can view, export, or act on a domain record.
- `audit-log`: writes access and action audit events.
- `queries`: domain-specific read models for UI screens.
- `exports`: builds owner-only request-linked export payloads.
- `privacy-requests`: manages DSAR/privacy request cases and event history.
- `notes`: manages internal notes or events linked to admin-visible records.

Admin screens should not perform ad hoc Drizzle queries directly. They should call admin query/service functions that return UI-ready read models. Existing domain services remain the source for operational business mutations.

## Database Additions

Add private DB tables for admin support data. Exact column names can be finalized during implementation planning, but the required records are:

- Admin user mapping if provider metadata alone is not enough: auth provider user id, email, display name, role, status, timestamps.
- Audit log entries: actor, role, action, domain, target type/id, optional privacy request id, purpose/reason, timestamp, request metadata, and minimal structured metadata.
- Privacy requests: request type, subject email, subject normalized email, status, requester notes, owner decision fields, timestamps, and assigned owner/operator metadata where needed.
- Privacy request events: append-only timeline for notes, lookup, export, decision, correction request, redaction/deletion tracking, completion, and cancellation.
- Admin notes/tags: optional support records linked to domain records for future guided workflows.

Privacy request types should cover access/export, correction, deletion, redaction, and general privacy inquiry. Privacy request statuses should cover open, in review, exported, pending technical action, completed, and cancelled. V1 should store enough event history to explain what was requested, what records were found, what export was generated, what decision was recorded, and what work remains outside the dashboard.

All new tables belong in the private DB because they involve private operational records, PII access governance, or privacy request evidence.

## Domain Read Models

### Products / Orders

Source: `checkout_orders` where `purpose = 'product'`.

The UI should show order id, status, payment provider, friendly payment state, customer identity, shipping summary, amount, currency, line items, confirmation email state, created/paid timestamps, and next action.

### Services / Bookings

Source: `appointment_holds` joined to related `checkout_orders` where purpose is `appointment_deposit`, `appointment_full`, or `appointment_custom_partial`.

The UI should use booking language: appointment time, service/offering, customer, hold status, payment status, calendar finalization status, booking confirmation email state, manual follow-up flags, and safe next action.

### Training

Source: `training_enrollments` joined to `checkout_orders` where `purpose = 'training'`.

The UI should use training language: program, student, product snapshot, payment status, scheduling status, token state, student/staff email state, staff alert state, scheduled-at timestamp, and safe next action.

### Unified Revenue / Purchases

Source: `checkout_orders`, grouped and filtered by product, service, and training purposes.

The UI should show a unified purchase ledger and summary cards. Each row should link back to the appropriate domain detail page. The default date range is last 30 days.

### Marketing

Sources: `marketing_contacts`, `marketing_contact_submissions`, and `marketing_consent_events`.

The UI should answer three business questions first:

- Lead source quality: where inquiries/opt-ins come from and which sources correlate with purchases, bookings, or training interest when a safe relationship exists.
- Audience health: opt-ins, unsubscribes, consent source, list growth, and inactive contacts.
- Training demand: which programs generate contact forms, paid enrollments, scheduling follow-up, and location interest.

V1 should use summary cards and filterable tables before charts.

### Privacy / DSAR

Source: new privacy request tables plus lookups across existing private DB domains by normalized email.

The UI should support case creation, related-record lookup, owner-only request-linked export, notes/events, decision tracking, and status tracking. V1 tracks redaction/deletion decisions but does not execute redaction/deletion.

## Roles And Permissions

Use managed auth with an internal role layer.

### Owner

The `owner` role can:

- View all admin areas.
- View operational PII.
- Create and manage privacy requests.
- Generate full exports tied to active privacy requests.
- Review access and action audit logs.
- Open troubleshooting panels.
- Approve sensitive privacy or operational decisions.

### Operator

The `operator` role can:

- View operational PII needed for day-to-day work.
- View order, booking, training, marketing, and revenue screens.
- Use normal filters and detail pages.
- Open non-sensitive operational details.

The `operator` role cannot:

- Generate full exports.
- Execute or approve redaction/deletion decisions.
- Review sensitive access logs.
- Modify raw payment/booking/provider state.
- Change privacy request decisions.

## Audit Logging

Audit events should be recorded for:

- Admin sign-in/session access where available from the auth provider or app.
- Customer detail page access.
- Privacy request page access.
- Related-record lookup for a privacy request.
- Export attempt, export success, and export failure.
- Troubleshooting panel access.
- Access-log review.
- Internal note/event creation.
- Future guided operational actions.

Audit metadata should include actor id, actor email, role, action, domain, target record type/id, optional privacy request id, required purpose/reason where applicable, timestamp, IP/user-agent when available, and minimal structured metadata. Do not store raw form payloads, raw webhook bodies, payment tokens, full connection strings, or unnecessary PII in audit metadata.

## Screens And Routes

Use a stable admin shell with left navigation, top search/date context, role badge, and a clear environment marker when staging/production can be detected.

- `/admin`: command center with operations inbox, urgent tasks, exceptions, recent activity, and summary cards.
- `/admin/revenue`: unified revenue and purchase ledger across products, services, and training.
- `/admin/orders`: product order workspace.
- `/admin/orders/[id]`: product order detail.
- `/admin/bookings`: service booking workspace.
- `/admin/bookings/[id]`: booking detail.
- `/admin/training`: training enrollment workspace.
- `/admin/training/[id]`: training enrollment detail.
- `/admin/marketing`: marketing intelligence workspace.
- `/admin/marketing/contacts/[id]`: marketing contact detail.
- `/admin/privacy`: privacy request list and creation.
- `/admin/privacy/[id]`: privacy request workspace with related-record lookup, export, events, and decisions.
- `/admin/audit`: owner-only audit log review.
- `/admin/settings`: role/status/configuration surface for later phases.

## Command Center UX

The dashboard homepage uses an operations inbox layout.

Default homepage focus:

- Today and next 7 days for operational tasks.
- Last 30 days for revenue and marketing signal summaries.
- Urgent exceptions first: failed emails, manual follow-up, booking/payment/calendar issues, pending training follow-up, and open privacy cases.

Each task row should explain what happened, why it matters, and the safe next action in plain business language.

## Actions And Safety Rails

V1 actions:

- Create privacy requests.
- Add privacy request events/notes.
- Generate owner-only full exports linked to privacy requests.
- View troubleshooting panels.

Cross-domain internal notes and tags are future-phase features unless they are privacy request events/notes needed for V1 case tracking.

Future guided actions:

- Retry transactional emails.
- Mark manual follow-up.
- Correct contact details.
- Close privacy requests.
- Tag records.
- Record rebooking/refund workflow decisions.

Every action requires permission checks, validation, confirmation copy for sensitive operations, audit logging, and domain-specific safety rules.

Safety rails:

- No dashboard redaction/deletion execution in v1.
- No raw payment provider field editing.
- No direct booking creation.
- No raw webhook payload display in normal views.
- No full export without an active privacy request.
- No operator full export or sensitive access-log review.

## Exports

V1 supports owner-only full exports tied to active privacy requests.

Export requirements:

- Actor must be `owner`.
- Export must be linked to a privacy request.
- Export must include a required purpose/reason.
- Export must audit attempt and outcome.
- Export should produce a readable grouped data-subject package.
- Export should exclude raw provider payloads, payment tokens, raw webhook bodies, and secrets.

Export contents should include relevant grouped records for the subject email:

- Marketing contact profile.
- Marketing/contact submissions.
- Consent and unsubscribe events.
- Product orders.
- Service booking holds and related order summaries.
- Training enrollments and related order summaries.
- Payment event summaries only where relevant and safe.
- Audit entries related to the privacy request/export, not unrelated internal access history unless policy requires it.

Normal dashboards can show reports and tables but should not add broad CSV export in v1.

## Payment And Troubleshooting Detail

Normal screens show friendly payment and reconciliation labels.

Provider identifiers, webhook event state, idempotency keys, and provider-specific troubleshooting fields should live behind a troubleshooting panel. Access to that panel should be audited. Raw provider/webhook payloads should remain excluded from normal UI; redacted/sanitized summaries can be shown where operationally useful.

## Data Flow

Admin page request flow:

1. Resolve managed-auth session.
2. Resolve internal admin user and role.
3. Run permission check.
4. Run admin query function.
5. Write audit event when the view is sensitive.
6. Render UI-ready read model.

Admin mutation flow:

1. Resolve managed-auth session.
2. Resolve internal admin user and role.
3. Run permission check.
4. Validate input.
5. Execute admin/domain service.
6. Write audit event for success or failure where relevant.
7. Return typed result.

Export flow:

1. Resolve owner role.
2. Validate active privacy request.
3. Require export reason.
4. Audit export attempt.
5. Build export package from admin export service.
6. Audit export success or failure.
7. Return the export response.

## Testing Strategy

Unit tests should cover:

- Role resolution and permission rules.
- Operator denial for exports and audit review.
- Owner-only export gating.
- Admin read-model mapping for product, booking, training, revenue, marketing, and privacy screens.
- Audit event creation and metadata minimization.
- Privacy request lifecycle state transitions.
- Export content grouping and sensitive-field exclusion.

Route/server-action tests should cover:

- Unauthorized requests.
- Authenticated-but-unapproved users.
- Owner success paths.
- Operator success paths for allowed views/actions.
- Operator denial paths for exports, privacy decisions, and audit review.
- Input validation failures.

Playwright coverage should include at least:

- Owner can navigate command center, domain screens, privacy request detail, export flow, and audit log.
- Operator can navigate command center and operational domain screens but cannot access owner-only privacy export or audit review.

Routine verification should include focused unit tests for `src/lib/admin`, route-handler tests for mutations/export endpoints, `npm run lint`, and relevant build/test commands from the repository runbook.

## Privacy And Retention Alignment

The dashboard must align with the existing retention and privacy documentation:

- It should surface retention-aware states where records are redacted, deleted, or outside actionable windows.
- It should not encourage admins to preserve PII outside approved retention procedures.
- It should keep DSAR redaction/deletion execution out of v1 while tracking decisions and technical follow-up.
- It should not export production PII outside owner-approved privacy request workflows.

## Implementation Notes

- Auth provider selection should happen during implementation planning. The design requires managed auth with per-user identity and role resolution; it does not require a specific provider.
- Admin query modules should return UI-ready read models so pages do not need to understand raw table relationships.
- Existing domain services should be reused for future guided operational mutations rather than duplicating business rules.
- New private DB schema changes require generated Drizzle migrations and the existing migration runbook.
- Dashboard visual style should follow the current quiet luxury/editorial brand system, while prioritizing legibility and operational clarity.
