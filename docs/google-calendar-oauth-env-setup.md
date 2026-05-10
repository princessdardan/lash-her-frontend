# Google Calendar OAuth Environment Setup

This document explains how to create the Google service configuration required by the booking system and how to populate these environment variables:

```env
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=
```

These values are server-side secrets used by the booking OAuth setup flow. Do not prefix them with `NEXT_PUBLIC_` and do not expose the client secret in browser code.

## What These Variables Do

- `GOOGLE_CLIENT_ID`: Identifies the Google OAuth web application that asks Nataliea to approve Calendar access.
- `GOOGLE_CLIENT_SECRET`: Authenticates this Next.js server when it exchanges Google's OAuth callback code for tokens.
- `GOOGLE_REDIRECT_URI`: The exact URL Google sends the browser back to after approval. In this app it must point to `/api/booking/oauth/callback`.

The implementation uses the `googleapis` package with the Google Calendar API scope:

```text
https://www.googleapis.com/auth/calendar.events
```

That scope lets the app read and create events on the connected calendar. The long-lived Google refresh token is not stored in these variables; it is generated during the protected admin setup flow and saved server-side in Upstash Redis.

## Service You Need To Configure

Configure one Google Cloud project with:

- Google Calendar API enabled.
- An OAuth consent screen.
- An OAuth 2.0 Client ID of type `Web application`.
- Authorized redirect URIs for every deployed environment that will connect a calendar.

Use separate OAuth clients for staging and production if possible. That keeps staging callback URLs and consent testing separate from production.

## Step 1: Create Or Choose A Google Cloud Project

1. Open the Google Cloud Console: `https://console.cloud.google.com/`.
2. Create a new project, or choose an existing Lash Her project.
3. Keep a note of which project owns the OAuth client so future credential rotation is easy.

Recommended naming:

- Project: `Lash Her Booking`
- Staging OAuth client: `Lash Her Booking Staging`
- Production OAuth client: `Lash Her Booking Production`

## Step 2: Enable Google Calendar API

1. In Google Cloud Console, go to **APIs & Services** > **Library**.
2. Search for **Google Calendar API**.
3. Open it and click **Enable**.

The booking code calls Calendar Events endpoints, so the Calendar API must be enabled before OAuth setup and booking requests can work.

## Step 3: Configure The OAuth Consent Screen

1. Go to **APIs & Services** > **OAuth consent screen**.
2. Choose the appropriate user type:
   - **External** is usually required for a normal Gmail or Google Workspace account outside your Cloud organization.
   - **Internal** only works for accounts inside the same Google Workspace organization.
3. Fill in the app information:
   - App name: `Lash Her Booking`
   - User support email: Nataliea's business/admin email
   - Developer contact email: the technical owner email
4. Add the Calendar Events scope if Google asks you to declare scopes:

```text
https://www.googleapis.com/auth/calendar.events
```

5. If the consent screen is in **Testing**, add the Google account that owns or manages the booking calendar as a test user.

For a private admin-only setup flow, the app can usually remain in testing while you connect the calendar with an allowlisted test user. If Google blocks access because the app is unpublished or the user is not allowlisted, add the account as a test user or publish the consent screen.

## Step 4: Create The OAuth Client

1. Go to **APIs & Services** > **Credentials**.
2. Click **Create credentials** > **OAuth client ID**.
3. Choose **Application type**: `Web application`.
4. Name the client for the environment, for example `Lash Her Booking Production`.
5. Add authorized redirect URIs.

For local development:

```text
http://localhost:3000/api/booking/oauth/callback
```

For staging:

```text
https://<staging-domain>/api/booking/oauth/callback
```

For production:

```text
https://<production-domain>/api/booking/oauth/callback
```

The redirect URI must exactly match `GOOGLE_REDIRECT_URI`, including protocol, host, path, and trailing slash behavior. This app expects the path:

```text
/api/booking/oauth/callback
```

## Step 5: Copy The Env Values

After creating the OAuth client, Google shows a client ID and client secret.

Set them in the matching environment:

```env
GOOGLE_CLIENT_ID=<oauth-client-id-from-google>
GOOGLE_CLIENT_SECRET=<oauth-client-secret-from-google>
GOOGLE_REDIRECT_URI=https://<domain>/api/booking/oauth/callback
```

Local example:

```env
GOOGLE_CLIENT_ID=<local-or-staging-client-id>
GOOGLE_CLIENT_SECRET=<local-or-staging-client-secret>
GOOGLE_REDIRECT_URI=http://localhost:3000/api/booking/oauth/callback
```

Production example:

```env
GOOGLE_CLIENT_ID=<production-client-id>
GOOGLE_CLIENT_SECRET=<production-client-secret>
GOOGLE_REDIRECT_URI=https://www.<production-domain>/api/booking/oauth/callback
```

Also confirm the booking setup has these related server-side variables, because the OAuth routes and token storage require them:

```env
BOOKING_ADMIN_SETUP_SECRET=<long-random-admin-setup-secret>
KV_REST_API_URL=<upstash-redis-rest-url>
KV_REST_API_TOKEN=<upstash-redis-rest-token>
```

## Step 6: Add Env Vars In Vercel

For each Vercel environment:

1. Open the Vercel project.
2. Go to **Settings** > **Environment Variables**.
3. Add `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI`.
4. Select the correct target environment, such as **Preview** for staging and **Production** for production.
5. Redeploy after saving changes so the running app receives the new values.

Keep staging and production values separate when using separate OAuth clients.

## Step 7: Connect The Calendar

After deploying the env vars, run the one-time protected setup flow in the target environment:

```text
https://<domain>/api/booking/oauth/start?secret=<BOOKING_ADMIN_SETUP_SECRET>
```

Expected flow:

1. The route validates `BOOKING_ADMIN_SETUP_SECRET`.
2. The app redirects to Google's OAuth consent screen.
3. Nataliea signs into the Google account that owns or can edit the booking calendar.
4. Nataliea approves Calendar access.
5. Google redirects back to `GOOGLE_REDIRECT_URI`.
6. The app stores the returned refresh token in Upstash Redis.
7. The browser shows: `Google Calendar booking OAuth is connected`.

If Google does not return a refresh token, visit the setup URL again and approve consent. The app already requests `access_type=offline` and `prompt=consent` to force refresh-token issuance.

## Step 8: Verify Booking Access

After OAuth connection:

1. Open Sanity Studio and configure the `bookingSettings` singleton.
2. Set the Google Calendar ID to the connected calendar ID.
   - For the primary calendar, this is often the Google email address.
   - For a secondary calendar, copy the calendar ID from Google Calendar settings.
3. Add availability marker events in Google Calendar using the configured marker title, defaulting to `Available for booking`.
4. Open `/booking` on the same deployed environment.
5. Confirm availability loads.
6. Create a test booking and confirm a Google Calendar event is inserted.

## Troubleshooting

### `redirect_uri_mismatch`

The `GOOGLE_REDIRECT_URI` value does not exactly match an authorized redirect URI on the OAuth client. Fix the Google Cloud OAuth client or the env var so they are identical.

### `Missing env var: GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, or `GOOGLE_REDIRECT_URI`

The env var is absent from the running server environment. Add it to Vercel or `.env.local`, then restart or redeploy.

### Google says the app is not available to this user

The OAuth consent screen is probably in testing and the signing-in Google account is not listed as a test user. Add the calendar owner account as a test user or publish the consent screen.

### The setup route returns `404`

The `secret` query parameter does not match `BOOKING_ADMIN_SETUP_SECRET`. Use the exact deployed secret value.

### The callback says Google did not return a refresh token

Retry the setup flow and approve consent. If the account previously approved the app, remove the app from the Google account's third-party access list, then run setup again.

### Availability still fails after OAuth connects

Check the related service configuration:

- `KV_REST_API_URL` and `KV_REST_API_TOKEN` must point to the same Upstash Redis instance used during OAuth setup.
- The `bookingSettings` calendar ID must match the connected calendar.
- The connected Google account must have permission to read and write events on that calendar.
- The Calendar API must be enabled in the Google Cloud project that owns the OAuth client.

## Rotation Checklist

When rotating Google credentials:

1. Create a new OAuth client secret, or create a new OAuth client.
2. Update `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` as needed.
3. Redeploy the app.
4. Re-run `/api/booking/oauth/start?secret=<BOOKING_ADMIN_SETUP_SECRET>`.
5. Confirm the callback succeeds and booking availability still loads.
