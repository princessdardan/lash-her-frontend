# Google Calendar OAuth Environment Setup

Last verified: 2026-08-31

This guide configures the current per-resource Calendar integration. Owners and administrators manage Google accounts at `/admin/calendar-connections`; employees manage accounts for their assigned provider resources at `/admin/my-calendar`. Both flows return through `/api/booking/oauth/callback` and store encrypted refresh credentials with the Calendar connection in private PostgreSQL.

This is separate from admin sign-in:

| Responsibility               | OAuth environment variables                                       | Requested access                                                          |
| ---------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Auth.js admin identity       | `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`                            | OpenID Connect identity only                                              |
| Booking Calendar connections | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | Verified email, Calendar list discovery, event read/write, offline access |

Use different Google OAuth clients for identity and Calendar access. Also use separate Calendar clients for local, preview/staging, and production so redirect URIs and credential rotation stay environment-scoped.

## Runtime ownership

- PostgreSQL stores each Google account connection, its owner, status, scopes, last verification/error state, and the encrypted refresh token.
- `BOOKING_CALENDAR_CREDENTIAL_ENCRYPTION_KEY` encrypts/decrypts refresh tokens in the application. It must be distinct from checkout encryption keys.
- Upstash Redis stores the single-use OAuth state for ten minutes. It does not store current Calendar credentials.
- Calendar assignments select a canonical Google Calendar ID for a specific booking resource. The alias `primary` is rejected as durable configuration.
- Exactly one active assignment per resource may accept bookings. That destination also contributes busy time. Additional calendars may contribute busy time without receiving appointments.

## 1. Create the Google Cloud project and enable Calendar

For the target environment:

1. Create or select a Google Cloud project owned by the business.
2. Enable the **Google Calendar API**.
3. Configure the OAuth consent screen with the business support/contact information.
4. Choose the appropriate internal or external audience for the accounts that will connect.
5. During testing, add every admin/employee Google account that must authorize Calendar access as a test user.
6. If Google requires verification before production use, complete that process for the scopes requested by the application.

The operational consent URL requests:

- `openid`
- `email`
- `https://www.googleapis.com/auth/calendar.events`
- `https://www.googleapis.com/auth/calendar.calendarlist.readonly`

The app requests offline access and explicit consent so Google can return a refresh token. Do not reduce the scopes without also changing Calendar discovery, availability reads, and event creation code.

## 2. Create a Web OAuth client

Create an OAuth 2.0 client of type **Web application**. Add the exact callback for each environment to **Authorized redirect URIs**:

```text
http://localhost:3000/api/booking/oauth/callback
https://<preview-or-staging-domain>/api/booking/oauth/callback
https://<production-domain>/api/booking/oauth/callback
```

Prefer one client per environment instead of putting every origin on one client. The scheme, host, optional port, path, and trailing slash must exactly match `GOOGLE_REDIRECT_URI`.

Copy the client ID and client secret into that environment's secret manager. Do not put the Calendar client secret in a `NEXT_PUBLIC_` variable.

## 3. Configure application variables

Generate a dedicated 32-byte encryption key:

```bash
openssl rand -base64 32
```

Set the following server-only values:

```env
GOOGLE_CLIENT_ID=<calendar-oauth-client-id>
GOOGLE_CLIENT_SECRET=<calendar-oauth-client-secret>
GOOGLE_REDIRECT_URI=https://<domain>/api/booking/oauth/callback
BOOKING_CALENDAR_CREDENTIAL_ENCRYPTION_KEY=<base64-encoded-32-byte-key>
BOOKING_ADMIN_SETUP_SECRET=<high-entropy-legacy-compatibility-secret>
KV_REST_API_URL=<upstash-rest-url>
KV_REST_API_TOKEN=<upstash-rest-token>
DATABASE_URL=<private-postgres-url>
```

For local development, use the localhost callback. In Vercel, scope preview/staging values to Preview and production values to Production, then redeploy after changing them.

`BOOKING_CALENDAR_CREDENTIAL_ENCRYPTION_KEY` is part of the stored credential contract. Replacing it without re-encrypting or reconnecting every active Calendar account makes existing credentials unreadable. Treat a key change as a credential migration, not an ordinary environment edit.

`BOOKING_ADMIN_SETUP_SECRET` protects only the legacy global OAuth-start route. Current per-resource credentials do not use it as their authority, but the shared booking environment accessor still requires the value when it creates the Google OAuth client. Keep it server-only and unused by operators except for an explicitly approved legacy recovery.

## 4. Connect an owner-managed Calendar account

Prerequisites: the private database is migrated, Auth.js admin sign-in works, and the provider resources already exist.

1. Sign in to the protected admin dashboard.
2. Open `/admin/calendar-connections`.
3. Select **Connect Google account**.
4. Complete Google consent using the account that owns or has access to the intended calendars.
5. Confirm the dashboard reports an active connection and a recent verification time.
6. For each provider resource, choose a discovered Calendar and save its assignment.
7. Mark the intended Calendar as the booking destination. It will also block its own busy times.
8. Add any other busy-only Calendars needed to prevent overlapping appointments.
9. Check `/admin/setup`; the provider should no longer report a missing booking Calendar.

The OAuth-start route is permission protected at `/api/admin/calendar-connections/[id]/oauth/start`. Operators should begin in the dashboard rather than constructing that URL.

## 5. Connect an employee-managed Calendar account

An employee can self-manage only resources assigned to that employee:

1. Sign in and open `/admin/my-calendar`.
2. Select the assigned provider resource if more than one is available.
3. Select **Connect Google account** and complete consent.
4. Choose the canonical Calendar and whether it should receive bookings.
5. Confirm regular hours and time off through the linked availability controls.

The employee OAuth-start route verifies both connection ownership and resource access at `/api/admin/my-calendar/connections/[id]/oauth/start`. A Google account already managed by another employee or by the owner cannot silently be taken over; an owner must use the explicit ownership-transfer workflow.

## 6. Verify the connection

Use non-customer test data in staging:

1. Confirm the dashboard can list the account's Calendars.
2. Confirm the stored assignment uses a canonical ID, not `primary`.
3. Add a busy event to an assigned Calendar and verify the overlapping slot disappears from `/services/[slug]/booking`.
4. Complete one Square sandbox service booking and confirm exactly one event appears on the assigned booking destination.
5. Retry the finalization/reconciliation path and confirm it finds the existing event rather than creating a duplicate.
6. Confirm a resource with no active destination fails booking readiness instead of accepting appointments without a Calendar target.

Do not paste refresh tokens, OAuth codes, OAuth state, Calendar IDs tied to a private account, customer event bodies, or setup URLs into logs, tickets, documentation, or chat.

## Legacy global connection compatibility

`/api/booking/oauth/start?secret=...` and `BOOKING_ADMIN_SETUP_SECRET` belong to the legacy global Calendar setup. That path stores one environment-scoped refresh token through the historical Redis compatibility store and is used only while reconciling or migrating legacy booking records.

Do not use the legacy route for a new provider or resource. Current operational availability and appointment projection resolve the credential through the resource's PostgreSQL Calendar connection and assignment. The shared callback distinguishes current admin/employee state from the legacy cookie-state flow so historical records can continue to finish safely.

## Troubleshooting

### `redirect_uri_mismatch`

- Compare `GOOGLE_REDIRECT_URI` with the authorized redirect URI character for character.
- Confirm the deployment received the expected environment-scoped variables and was redeployed.
- Confirm the browser is using the same origin represented by the callback URI.

### OAuth authorization expired or was already used

Current OAuth state is single-use and expires after ten minutes. Start again from the dashboard. If every attempt fails immediately, verify the Upstash REST variables and service availability.

### Google did not return offline access

Start a reconnect from the dashboard and approve the requested access. Google may need the prior grant revoked before it issues a new refresh token. Do not insert an access token or copied credential directly into PostgreSQL.

### The account is owned elsewhere or does not match

The app prevents duplicate ownership and requires reconnects to use the account already bound to a connection. Review the account email/provider identity in `/admin/calendar-connections`; use the audited ownership-transfer control when responsibility genuinely changes.

### Calendars cannot be discovered

- Verify the Calendar API is enabled.
- Verify the grant includes Calendar list read access.
- Confirm the connected account has at least free/busy access to the target Calendar.
- Reconnect if the dashboard reports `reconnect_required` or a stored error.

### Availability works but event creation fails

- Confirm the booking destination's connection is active.
- Confirm the connected account can write events to the selected Calendar, not only read free/busy data.
- Confirm the assignment still references the same canonical Calendar and contributes busy time.
- Inspect `/admin/booking-issues`, `/admin/appointments`, and the payment reconciliation result before retrying. A captured payment with incomplete Calendar projection is manual/reconciliation work, not permission to charge again.

### Encryption-key errors

`BOOKING_CALENDAR_CREDENTIAL_ENCRYPTION_KEY` must decode to exactly 32 bytes. If the key was lost or changed, existing ciphertext cannot be recovered by the application; restore the protected key from the environment's secret backup or reconnect affected accounts under an approved migration plan.

## Rotation checklist

1. Create replacement credentials in the correct Google Cloud project/environment.
2. Update only the target deployment's server-side variables.
3. Redeploy and test Calendar discovery before disabling the old client secret.
4. If the OAuth client ID changes, reconnect each active account so its refresh grant belongs to the new client.
5. If the encryption key changes, re-encrypt or reconnect all stored credentials as one controlled migration.
6. Re-run busy-time and event-creation smoke tests.
7. Confirm `/admin/setup` and `/admin/calendar-connections` show healthy resources before restoring public availability.
