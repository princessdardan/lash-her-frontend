# P1-02 provider configuration evidence - 2026-10-22

The requested Google OAuth, Resend isolation and protected webhook configuration
is complete. P1-02 remains open for the release and platform gates. No deployment,
cloud application migration, email, provider test event or production-contact
import occurred. See [machine-readable evidence](2026-10-22-p1-02-provider-configuration.json)
and [operator configuration](../../../ops/staging/providers.md).

## Applied and verified

- Google project `lash-her-staging-20261022`, number `185770842371`, contains two
  distinct web clients with staging-only callbacks. Identity has only the staging
  JavaScript origin; Calendar has no JavaScript origins. Existing project
  `87626194287` was not changed. Client secrets are sensitive variables only in
  the dedicated staging project's Production and Preview targets.
- Consent remains External / Testing. Four explicitly approved test users were
  saved. Only the designated staging account is the staging administrator and
  test Calendar owner. Calendar API is enabled; the approved five consent scopes
  were read back. User addresses remain in the private handoff and console;
  repository metadata stores counts and an administrator-set SHA-256 pin.
- The independent `dardanlashher` Resend account boundary was verified through its
  approved Full access key. `mail.staging.lashher.com` is verified, with receiving
  and open/click tracking disabled. Four sender DNS records were added without
  altering existing records. Its separate marketing segment remains empty.
  All 11 templates generated from repository source were published, read back,
  and installed only in staging. Recipient allowlist and admin recipient remain
  `delivered@resend.dev`. No paid team/subscription was purchased.
- Square, Sanity and Resend have three independent approved Vercel bypass tokens
  and disabled provider registrations. All-deployment Vercel Authentication stays
  enabled. Only Square is selected for the mandatory private bypass system
  variable; Sanity and Resend are not exposed through that variable. Resend's
  provider signing secret is installed as a sensitive staging variable.
- Vercel metadata reports 73 staging variables, all targeting Production and
  Preview in the dedicated staging project. Database owner aliases are absent;
  runtime DB URL and provider secrets are sensitive. No production project was
  mutated by these provider bindings.

## Validation and limits

Six release-preflight tests pass, including negative cases for changed/shared
OAuth clients, production callbacks, added administrators, cross-account email
configuration, unverified sender and missing release/migration pins. Changed
JavaScript scripts pass ESLint. A scan of 189 candidate files found no known private
credential values; handoff JSON and local links validate. Private credential files
are mode 0600 inside a mode-0700 directory. Earlier provider preparation passed 44 focused
Square webhook tests and TypeScript checking; subsequent source changes are in
JavaScript release checks, configuration and documentation.

The private environment metadata check finds no missing provider credentials.
It correctly remains blocked on approved source/migration evidence and deployed
identity/branch checks. Its system fields come from an earlier CLI snapshot;
it is not a deployed Vercel claim attestation or end-to-end OAuth test.

The first Identity secret appeared in a tool observation through Google's copy
button label. It was replaced before installation and the initial secret was
verified disabled. Google notes that credential/configuration changes can take
time to propagate. Only the replacement is installed in staging.

The Resend browser-origin observation was rejected because its permission could
cover unrelated teams. Scoped API checks used the approved isolated-account key;
no further broad Resend browser access was attempted. The old production-team
sending credential is no longer installed in staging but was not revoked from
that production account.

## Remaining release gates

1. Review/publish the uncommitted source candidate, choose the release SHA, apply
   authorized protected migrations and pin matching migration evidence.
2. Deploy and verify Vercel identity claims, OAuth callback/cookies, sole-admin
   authorization, test Calendar connection/encrypted credentials, email allowlist,
   isolated contact/unsubscribe flows and valid/invalid/duplicate webhook handling.
   Keep all new webhooks disabled until those checks pass.
3. Review the enabled legacy Square sandbox webhook
   `wbhk_0185e717faf34f3d8acd1d7e3e521748`, which still targets
   `https://preview.lashher.com/api/webhooks/square` with 153 event types. It was
   not changed and can still receive sandbox events.
4. Complete remaining Course/Community lineage, Mux isolation, Lightsail host,
   private network/CA, monitoring, cost and native scheduled-test requirements.

The [DB release-store handoff](2026-10-22-p1-02-release-handoff.md) remains unchanged.
