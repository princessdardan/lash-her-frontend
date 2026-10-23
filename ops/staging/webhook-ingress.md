# Staging webhook ingress change

The three provider-specific staging credentials and their disabled webhook bindings
are configured and read back. The project-wide scope and Vercel's mandatory system
environment selection were both explicitly approved. The first incomplete attempt
was rolled back before retrying with the approved setting.
[Configuration](webhook-ingress.json) and [registration metadata](webhook-registrations.json)
record actual state without credential values. Deliveries remain disabled; no
application deployment or provider event was created.

The [setup script](configure-webhook-ingress.mjs) prints a read-only plan by
default; writes require `--apply`. Vercel requires 32-character alphanumeric
credentials. They are generated from 16 cryptographically random bytes (128 bits)
and stored only in the owner-controlled mode-0700 private directory/mode-0600 file.

The target is exclusively `prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM` in team
`team_2Hrn5eMZyZxfAWdmYvyKi9t3`. Production is outside the script's fixed target.
All-deployment Vercel Authentication remains enabled. No domain-wide exception or
firewall rule is proposed. Three independent credentials are configured:

| Consumer | Delivery | Application authentication |
| --- | --- | --- |
| Square sandbox | Private registered URL query `x-vercel-protection-bypass`; runtime verifies that exact URL | Existing Square raw-body HMAC and provider-issued signing key |
| Sanity staging project `7o23yrvk` | Private `x-vercel-protection-bypass` webhook header | Existing Sanity webhook signature and staging dataset/type filter |
| Resend isolated `dardanlashher` account | Private registered URL query `x-vercel-protection-bypass` | Existing Svix signature with the provider-issued signing secret |

The credentials are **not path-scoped**. Anyone possessing one can bypass
platform authentication and some firewall/bot checks across the staging project;
application authorization and webhook signatures remain necessary. Square's
subscription object does not support a custom authorization header, so its URL
would contain the credential. Provider settings, dashboards or platform request
logs may retain that URL. This change does not claim to redact those external logs.

The approved configuration keeps all three credentials in a private mode-0600 operator file and
selects the Square token as `VERCEL_AUTOMATION_BYPASS_SECRET` as required by Vercel.
Sanity and Resend remain `isEnvVar=false`. The selected Square token becomes available to
staging build/server code in future deployments. It is not a `NEXT_PUBLIC_` value,
but code running in that project can read it; untrusted code must not be deployed.
This required difference from the original operator-file-only proposal was explicitly approved.
The exact Square notification URL and provider-issued signing key are installed as
sensitive staging variables. Its provider subscription is disabled until the approved candidate
and migrations are ready. Resend has its separately approved token bound to the disabled isolated-account webhook; its signing key is a sensitive staging variable. No application deployment or delivery activation is included.

The current uncommitted application change removes query strings/userinfo from
Square signature-mismatch diagnostics. It retains the full query only in memory
for exact HMAC diagnosis; a mismatch is still rejected. Valid protected URLs and
credential-redacted failures are covered by tests; all 44 focused Square webhook
tests pass. This fix must be in the reviewed source before enabling delivery.

If the project-wide credential scope is unacceptable, a separately reviewed
route-restricted ingress service is needed. That would require a service location,
resource/deployment approval, credential delivery, body/header forwarding and
signature contract; it has not been provisioned or substituted silently.

Vercel protection/key metadata and all three disabled provider bindings were verified.
Verify signatures against the reviewed source and final deployed ingress before
activation. Rotate by
registering a new provider-specific token, updating the disabled subscription and
exact verification URL/header, testing it, and revoking the old token. Do not paste
credential-bearing URLs into tickets, logs or committed files.

[Vercel automation bypass documentation](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation)
confirms project-wide scope and bypass behavior. Checked 2026-10-22.


The existing Square sandbox subscription `wbhk_0185e717faf34f3d8acd1d7e3e521748`
still targets `https://preview.lashher.com/api/webhooks/square` and subscribes to
153 event types. It was not changed. New staging subscriptions do not prevent it
from receiving sandbox events. Review/retire or otherwise isolate that legacy
callback before sending sandbox payment tests; it is an activation gate.
