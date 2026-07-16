# Admin Dashboard V1 Plan — Superseded Authentication Design

This historical plan is superseded. Its original managed-auth vendor design must not be implemented.

The supported admin identity boundary is the self-hosted Auth.js configuration in `src/auth.ts`, using Google only as the OpenID Connect identity provider. Application roles, account status, and employee resource assignments remain authoritative in PostgreSQL through `admin_users` and `admin_user_resources`.

## Required constraints

- Do not add Clerk packages, environment variables, middleware, providers, metadata, or setup instructions.
- Do not store Google Calendar refresh/access tokens in the Auth.js session or JWT. Calendar authorization is a separate operational connection and its refresh token is encrypted with `BOOKING_CALENDAR_CREDENTIAL_ENCRYPTION_KEY`.
- Keep `/admin` protected by `src/proxy.ts` and resolve every authenticated identity through the PostgreSQL admin user store.
- Treat `ADMIN_OWNER_EMAILS` as local/bootstrap and break-glass configuration only. Normal role and status changes happen in PostgreSQL and must be audited.
- Enforce employee resource scope on the server for booking and schedule reads and writes.
- Keep public/editorial data in Sanity and private operational data in PostgreSQL.

## Current implementation sources

- Identity provider configuration: `src/auth.ts`
- Auth.js route handler: `src/app/api/auth/[...nextauth]/route.ts`
- Admin route protection: `src/proxy.ts`
- Database-backed identity resolution: `src/lib/admin/auth.ts`
- Permission model: `src/lib/admin/permissions.ts`
- Admin audit boundary: `src/lib/admin/audit-log.ts`
- Runtime configuration: `.env.local.example` under “Admin Dashboard Authentication (Auth.js + Google identity only)”

The original detailed plan is retained in Git history if historical comparison is needed. New implementation work must follow the sources and constraints above.
