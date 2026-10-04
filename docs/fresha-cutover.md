# Fresha service-booking cutover

New service reservations are closed in application code. New customers book at
[Lash Her by Nataliea on Fresha](https://www.fresha.com/a/lash-her-by-nataliea-toronto-646-oakwood-avenue-tvrir5sx).
The website retains its PostgreSQL service/provider catalog and Sanity editorial content.
Prices shown on the site require normal staff maintenance; availability and final
booking details are confirmed on Fresha. There is no Fresha API integration or sync.

## Retired entry points

- `/booking` and `/services/[slug]/booking` temporarily redirect GET/HEAD requests to the fixed Fresha URL before page streaming, without forwarding queries. Other methods return `410` rather than forwarding request bodies.
- `GET`/`POST /api/booking/availability`, `POST /api/booking/holds`, and `POST /api/booking/create` return `410` with `code: "SERVICE_BOOKING_MOVED"`, `error`, and `bookingUrl`. These routes do not load booking/provider dependencies.
- `POST /api/booking/checkout` only reads a saved hosted checkout link for an eligible existing hold. It cannot create a link, release a hold, or alter expiry. Missing links return `410`; unavailable holds retain `409`.

The old availability/hold handler factories remain internal compatibility/test code;
they are not the exported HTTP entry points. Do not restore those route exports.

## Existing bookings and payments

“Already open” means an existing stored hold eligible under the original payment
rules. Merely opening the service-selection screen does not qualify. Customers can
finish existing payment sessions through `/services/[slug]/booking/payment?session=...`.
Existing expiry, capture lease, payment grace, and idempotency rules remain in force.
Expired sessions direct customers to Fresha without creating replacement holds.

Keep these dependencies active:

- `SERVICE_BOOKING_SQUARE_ENABLED=true`, `SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED=true`, and valid direct-payment configuration so eligible sessions can finish.
- Square credentials, signature verification, `/api/webhooks/square`, historical `/api/booking/square/return`, and `/api/admin/payment-reconciliation` with its current schedule/secrets.
- Private PostgreSQL, encryption keys, Google Calendar credentials/assignments, Redis, and transactional email delivery needed by existing records and staff operations.
- Confirmation routes, authorized appointment/payment/attendance/no-show/refund tools, and current retention policies.

Do not disable the service Square flag to stop reservations: it also gates historical
reconciliation. Do not deactivate providers, services, or resources as a shutdown
mechanism. Do not cancel appointments, delete rows or Calendar events, revoke
credentials, bulk-expire holds, or extend payment sessions for this cutover.
Product checkout and training checkout/scheduling retain their current behavior.

## Release checks

1. Verify the release against an isolated test database: new entry points closed;
   catalog usable without booking-integration readiness; existing card/Afterpay
   sessions, confirmations, duplicate reconciliation, and staff record access intact.
2. Before promotion, record sanitized counts/status totals of existing appointments
   and unresolved payments, and confirm the normal database backup is available.
   Keep private identifiers and payment/session references out of shared evidence.
3. Staff must account for existing appointments in Fresha availability before new
   overlapping slots are offered. This release does not transfer appointments or
   synchronize the two booking systems.
4. Promote the release and verify exact entry redirects, no private query forwarding,
   API `410` responses, and retained payment/confirmation routes on the public domain.
   Protect or retire old deployment URLs that still share production data and can
   accept holds; changing the public alias alone does not close those deployments.
5. Compare appointment/status totals with the baseline, allowing expected completion
   of existing sessions. Review unresolved captures, Calendar finalization failures,
   duplicate events, email failures, and the next reconciliation invocation.

## Recovery

Use existing payment/booking runbooks to recover historical records. For a public
catalog or link defect, fix forward while keeping reservation closure in place.
Reverting to an older release can reopen in-app booking; any rollback must retain
the closed entry routes. Do not change payment flags or purge data to repair the
Fresha handoff. Further provider decommissioning requires a separate review after
all historical obligations and recoveries are resolved.
