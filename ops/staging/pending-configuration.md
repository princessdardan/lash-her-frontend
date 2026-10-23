# Staging configuration approval record

Status: Dardan explicitly approved the documented payload, database role, email key, and build command on 2026-10-22. These changes are applied and verified; deployment and application migrations remain excluded.

Scope: Vercel project `prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM` only, Production and Preview targets. No production project, deployment, migration, customer email, or production data change is included.

## Provider environment payload

Prepared script: `/private/tmp/lash-her-p1-02-staging/configure-env.mjs`.

- Public origin: `https://staging.lashher.com`; Sanity project `7o23yrvk`, dataset `staging-2026-05-10`, API version `2026-03-24`.
- Install the newly created read/write tokens belonging only to that separate Sanity project.
- Generate independent random authentication, encryption, webhook, cron, booking-action, shipping, and Course access secrets. Names are listed in the script; values are never printed or committed.
- Install the existing Square **sandbox** application ID, location ID `LE2H76M5V90AM`, and access token, verified against Square's sandbox API. `SQUARE_ENVIRONMENT=sandbox`, `SQUARE_COMMERCE_ENABLED=true`, service bookings/card-on-file flags `false`. `PAYMENT_GATEWAY_MODE=live` selects the provider adapter; this adapter uses Square's sandbox because `SQUARE_ENVIRONMENT=sandbox`. Mock mode is rejected by the current application on a Vercel Production target.
- Square webhook URL: `https://staging.lashher.com/api/webhooks/square`. Its provider registration/signature secret remains a separate prerequisite.
- Chit Chats environment `staging`, all shipping/checkout/US flags `false`; manual product checkout `false`.
- HighLevel sync, marketing, audited-account and reviewed-workflow flags `false`.
- Email recipient allowlist `delivered@resend.dev`, backup retention 7 days. The source recipient guard is tested but not deployed.
- Missing dedicated Google OAuth, email webhook/segment, administrator identity, and other provider credentials remain unset. This payload cannot pass the first-release preflight on its own.

## Frontend database runtime isolation

Apply `frontend-runtime-role.sql` only to the newly created frontend staging database (`morning-tree-37564896` / `ep-plain-field-b7yma047.c-13.us-east-1.aws.neon.tech`). Create `lash_her_frontend_staging_runtime` with a random password, CONNECT, public schema USAGE, table SELECT/INSERT/UPDATE/DELETE and sequence USAGE/SELECT, including defaults for future owner-created tables. It has no schema ownership or DDL grants.

Disconnect that store's managed environment binding from the staging frontend project while preserving the store. Remove owner-password and direct/owner URL aliases from the frontend's Production/Preview environments. Install only its pooled runtime `DATABASE_URL`. Preserve direct owner credentials privately for the protected migration process. Do not apply application migrations.

## Staging email credential

Create a dedicated Resend key named `Lash Her Staging`, permission `sending_access`, restricted to the existing verified `lashher.com` domain. Install it only in staging. Do not send email or create production contacts. Email webhook/marketing-segment configuration and template availability still require separate review.

## Build command

Set only the staging project's build command to:

```sh
node scripts/validate-staging-release.mjs && npm run build
```

The tested preflight requires an approved commit, matching migration evidence, PostgreSQL 18 compatibility evidence, isolated endpoints/roles, sandbox payments, allowed email recipients, and required credentials. It deliberately fails until these prerequisites are recorded. The current remote `staging` branch lacks this new script and must be updated through the normal reviewed release process before a deployment can succeed.

## Approval context

Automatic approval review rejected the initial bulk environment write and build-command change because the exact credential/settings payload and the then-unverified custom build script were outside its accepted authorization. This document records the concrete requested changes. Nothing in this document authorizes deployment or schema migration.

Release commit pins are set later in protected Vercel configuration (`STAGING_RELEASE_COMMIT`, `STAGING_MIGRATION_VERIFIED_COMMIT`) after source review and protected migrations. Keeping these outside the source commit avoids a circular commit hash. They remain unset.

## Community credential export follow-up

Dardan approved credential retrieval for Community staging project
`still-darkness-27201043`. The resource read returns secret metadata only, and
a resource credential-read request returned HTTP 403. Chrome is unavailable.
Automatic approval review then rejected opening the exact project URL
`https://console.neon.tech/app/projects/still-darkness-27201043` because browser
access is granted at origin level and could expose unrelated Neon account data.

Dardan subsequently explicitly approved `console.neon.tech` origin access.
Pooled/direct owner URLs for this project were exported into mode-0600 private
local release configuration without printing credentials. Read-only connections
verified client TLS 1.3 and authorized certificates on both endpoints; the new
PostgreSQL 18.6 database has zero public tables and no migration journal.
The password was hidden again and the temporary browser tab was closed. No
frontend binding, schema migration or role change was performed. Separate runtime
credentials and protected release-store import remain pending.
