# P1-02 staging deployment preparation

Recorded 2026-10-22. Configuration work is applied; the first deployment remains
blocked. P1-02 is still **BLOCKED** on its remaining acceptance requirements.
[Structured evidence](2026-10-22-p1-02-deployment-preparation.json) and
[first-release manifest](../../../ops/staging/first-release.json).

## Applied configuration

- Connected Vercel project `prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM` to
  `princessdardan/lash-her-frontend`, repository ID `1114139712`, with `staging`
  as its Production branch. Independent CLI API readback confirms the branch,
  `autoExposeSystemEnvs=true`, team-scoped OIDC, and build command
  `node scripts/validate-staging-release.mjs && npm run build`.
- Created frontend Neon project `morning-tree-37564896`, store
  `store_eo2hKOR243vTF0fw`. Its direct endpoint is
  `ep-plain-field-b7yma047.c-13.us-east-1.aws.neon.tech`; runtime uses the matching
  `-pooler` endpoint, database `neondb`, and independent role
  `lash_her_frontend_staging_runtime`. Verified TLS login and absence of superuser,
  CREATEDB, CREATEROLE, and public-schema CREATE privileges. The managed owner
  credential binding was removed. Live Vercel metadata confirms no owner URL or
  password aliases remain; runtime `DATABASE_URL` is sensitive.
- Created separate Community Neon project `still-darkness-27201043`, store
  `store_7ijIotasCFVQEKfl`, with zero Vercel project connections. Credentials are
  not installed in the frontend. After explicit Neon console origin approval,
  exported this project's pooled/direct owner URLs into an owner-only private
  local release file. Both connections passed read-only TLS 1.3 verification
  with authorized server certificates; PostgreSQL is 18.6, with zero public
  tables and no migration journal. Direct host:
  `ep-fancy-glitter-b81a2g6r.c-14.us-east-1.aws.neon.tech`; pooled host adds
  `-pooler`. Branch ID: `br-plain-hall-b8lmm4z8`. Separate runtime-role setup and
  protected release-store import remain pending. No Community schema or
  credential role changes were made.
- Retained the existing independent Course staging database at
  `ep-ancient-shadow-axzksq4b.c-4.us-east-2.aws.neon.tech`. Read-only TLS inspection
  found PostgreSQL 16.15, 12 public tables, and a migration journal. This is not
  migration-lineage certification; pending Course migrations remain unapplied.
- Created Upstash Redis `lash-her-staging-redis`, store
  `store_9ROJsD2RHvSMBe5d`, provider database
  `a404310a-a11e-4d9c-8464-2e311dc84efb`, endpoint
  `tidy-monarch-236694.upstash.io`. It is connected only to staging Production and
  Preview. A read-only REST `PING` returned `PONG`.
- Created separate Sanity project **Lash Her Staging**, ID `7o23yrvk`, dataset
  `staging-2026-05-10`, after the shared project rejected dataset-only roles
  without `advancedRolesManagement`. Copied 44 published editorial documents and
  54 referenced image assets. Verification found zero drafts, versions, unresolved
  references, or asset records pointing at the original project. Deployed the
  existing editorial schema and added the staging origin to CORS. Installed
  viewer/editor tokens belonging only to the new project. The original project
  and production dataset were not modified.
- Installed independent generated authentication, encryption, webhook, cron, and
  action secrets, canonical staging origin, and the documented provider flags.
  Square uses the existing verified sandbox application/location
  `LE2H76M5V90AM`; its sandbox locations API returned HTTP 200, ACTIVE and CAD.
  `PAYMENT_GATEWAY_MODE=live` selects the adapter with
  `SQUARE_ENVIRONMENT=sandbox`. New service bookings remain closed. Chit Chats
  shipping and HighLevel sync/marketing remain disabled.
- Created and installed a dedicated Resend `sending_access` key restricted to
  verified domain `lashher.com`. A negative API-key administration check returned
  `restricted_api_key` (401). No email or production contact write occurred.
  The new source guard rejects staging recipients outside an exact allowlist,
  currently only `delivered@resend.dev`, before a provider request.

All 51 configured Vercel variables target only staging Production and Preview.
Sanity, Square, email, and runtime database credentials are sensitive variables.
Provider values and fresh secrets were kept out of tool output and Git.
Private handoff files remain under `/private/tmp/lash-her-p1-02-staging` with
owner-only permissions; they are temporary operator material, not the final
protected release secret store. The repository's local Vercel link still targets
production; use the explicit staging IDs or the temporary staging link directory.

## Release controls and remaining prerequisites

The preflight rejects mismatched project/team/target, unreviewed source,
missing matching migration evidence, wrong DB host/role/TLS, runtime owner aliases,
production Square settings, enabled outbound integrations, missing credentials,
and unapproved email recipients. Release pins are supplied after review through
protected `STAGING_RELEASE_COMMIT` and `STAGING_MIGRATION_VERIFIED_COMMIT` values;
this avoids committing a file containing its own commit SHA.

The remote `staging` branch still points at
`ea1772b20453a494dcd3ff635066ebd385906f6b` and lacks the new preflight and isolation
changes. The current local branch is `codex/fresha-service-booking-cutover`, based
on `1d8342ab93b6713bebbb3a9caabaa54a246f9957`, with substantial pre-existing changes.
Nothing was committed, pushed, or selected as an approved release. Publishing
this candidate needs normal source review; no broad working-tree commit is implied.

Before a first deployment:

1. Publish an approved candidate to `staging`, preserving unrelated work. Record
   the exact source revision through the protected release configuration.
2. Use the protected migration procedure and reviewed artifacts for the cloud
   staging databases. The frontend cloud database was empty at inspection and
   still has no application migrations. Certify Course lineage and complete
   Community runtime-role/protected-store handoff. Record matching migration evidence.
3. Configure dedicated Google Auth and Calendar OAuth credentials, with callbacks
   `https://staging.lashher.com/api/auth/callback/google` and
   `https://staging.lashher.com/api/booking/oauth/callback`. Supply reviewed admin
   identities and sender/admin email settings. Do not copy production OAuth secrets.
4. Register and verify staging Square, Resend and Sanity webhooks. Supply the real
   Square signature key, Resend webhook secret and isolated marketing segment ID;
   verify email templates and provider event isolation. The sending-only key cannot manage contacts, segments or campaigns at all.
   Those workflows need separately isolated account/credentials or reviewed
   disabled behavior; an isolated segment ID alone is insufficient. Mux isolation remains unconfigured and is required
   before media workflows are enabled. Disabled shipping/CRM do not certify their
   sandbox flows.
5. Re-run both the staging preflight and normal prebuild against the completed
   configuration, then perform the protected deployment and browser/API/provider,
   OIDC and native-scheduler smoke tests. No deployed identity claims are certified.

Hosted staging/Preview prebuilds now require Sanity project `7o23yrvk`. The
production project's existing Preview credentials were not changed by this
staging-only payload; future deployments there also need the separate project
configuration. Existing deployed production behavior is unchanged.

Lightsail configuration remains [prepared, not provisioned](../../../ops/aws/README.md).
Named operator, SSH CIDR/key pair, gateway DNS/CA, approved window, complete cost
estimate, host provisioning, and P1-03/P1-04/P1-07/P1-08 acceptance remain open.

## Validation and limits

- Node 24.18.0: 1,990 non-DB source tests and 27 script tests passed, 2,017 total.
  The initial sandbox run hit tsx IPC restrictions; the permitted run exposed
  three outdated email fixtures, which were corrected for the verified staging
  identity/recipient contract. Final tests passed, including a provider-call
  refusal test for unapproved staging email recipients.
- TypeScript and changed-file ESLint passed. `git diff --check` passed.
- Disposable PostgreSQL 18.6: all 80 frontend migrations through `0079` applied
  cleanly and all 174 DB tests passed. The test container was removed. This is
  local compatibility evidence for the current uncommitted candidate, not cloud
  migration or production upgrade evidence. Schema/private-DB input hash and
  image digest are in the structured evidence.
- Live metadata and known installed-value checks confirm variable scopes and no
  runtime owner aliases. The release preflight correctly fails on source/migration
  pins, absent deployed system identity, and missing OAuth/admin/webhook settings.
  System fields in the CLI snapshot are not deployment attestation.
- No application build/deployment, cloud application migration, AWS provisioning,
  production redeploy, email send, or production provider-secret copy occurred.

## Billing and approval record

The new Neon projects use the existing shared **Launch** installation billing;
Upstash uses paid pay-as-you-go billing. They must not be described as free.
Provisioning with `free_v3` initially changed the shared Neon installation plan.
This was detected and restored to its original `launch_v3`; fresh installation
readback verified restoration. Production database data was not changed. Complete
incremental cost/ownership evidence remains open.

Dardan explicitly approved the separate Sanity project, the documented provider
payload/runtime role/Resend key/build command, and Community credential retrieval.
Earlier automatic approval rejections of the payload/build command were resolved
by that approval. The Community API lookup returned metadata only, and a
credential-read request returned 403. Automatic approval review rejected browser
inventory and then the exact-project URL because origin-level access could expose
other Neon projects. Dardan explicitly approved `console.neon.tech` origin access.
The authenticated browser was used only for the Community staging project;
pooled/direct owner URLs were saved privately and verified without printing
passwords. Password display was hidden again and the temporary tab was closed.
Credential export is complete; runtime-role setup and protected release-store
import remain pending. [Configuration approval record](../../../ops/staging/pending-configuration.md).
