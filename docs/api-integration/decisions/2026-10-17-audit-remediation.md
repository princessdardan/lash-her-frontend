# ENV-01e audit follow-up — staging and rate limits

Recorded 2026-10-17, America/Toronto. Owner: Dardan; delivery: FE, COURSE,
COMMUNITY and OPS. Follows the [audit](../reviews/2026-10-17-lightsail-plan-audit.md)
and [selected Lightsail/OIDC design](2026-10-17-lightsail-ingress.md).

## Decision and implementation status

| Item | Status |
| --- | --- |
| A1 staging target and provider strategy | Accepted by Dardan as ENV-02-01 on 2026-10-17. [October 22 progress](../baselines/2026-10-22-p1-02-progress.md) records authenticated inventory and locally verified resolver/Sanity/Square/shipping guards. Dedicated staging project/host, release setting adoption, other provider mappings/guards and deployed proof remain outstanding. |
| A2 replace the shared 120/minute source-IP quota | User authorized the change; local API implementation below; deployed verification outstanding |
| A3 Community 429 correction | User required explicit planning coverage; recorded below and implemented locally alongside A2 |

P1-02 remains blocked on actual inventory, provider mappings and costs. These
bounded corrections do not complete P1-03, the member-authentication work or
distributed-quota requirements in subsequent phases. No resources were deployed.

## A1 — Accepted explicit staging target (ENV-02-01)

On 2026-10-17, Dardan accepted the proposed arrangement: "We will proceed with
this proposed arrangement." This selects the architecture and configuration
contract below; it does not establish provisioned resources or completed safeguards.

Use the **Production deployment target of a dedicated staging Vercel project**.
Treat Vercel's deployment target and the application's business environment as
separate concepts. This makes the staging project's stable domain and native cron
behavior resemble production without sharing production credentials or data.
Vercel Cron invokes a project's production deployment URL; previews do not supply
that native scheduled target. [Vercel Cron](https://vercel.com/docs/cron-jobs).

The deployment targets, APP_ENV values and frontend domains below are selected.
The staging project display name and gateway domain remain suggested labels;
actual project IDs, DNS assignments and provider resources require verification.

| Setting | Selected staging arrangement | Production |
| --- | --- | --- |
| Vercel project | Dedicated project; suggested name `lash-her-staging`; actual project/team IDs to record | Existing production project; actual IDs to verify |
| Deployment target / `VERCEL_ENV` | `production` | `production` |
| Business environment | Server-only `APP_ENV=staging`; implementation required | `APP_ENV=production`; implementation required |
| Frontend domain | `staging.lashher.com`; DNS/project assignment required | Existing `lashher.com`, mapping to verify |
| API gateway domain | Proposed `api-staging.lashher.com` | Production gateway domain to assign |
| Release source | Reviewed release candidate through protected staging workflow | Tested revision through protected production workflow |
| OIDC allowlist | Exact staging team/project/subject and `environment=production` | Exact production team/project/subject and `environment=production` |
| Compute | Separate Lightsail staging VM, active during test windows | One production VM |

Keep automatic unreviewed PR deployments out of the staging project's trusted
target. A project named staging is not itself an authorization boundary. Every
gateway must check exact IDs and claims; checking `environment=production` alone
would accept the wrong project. Preview/development tokens remain unauthorized.

Before the first staging deployment, configure its Production-scope variables
with staging values only. Vercel creates a production deployment for a project's
first deployment, even when initiated from another branch.
[Vercel environments](https://vercel.com/docs/deployments/environments).

### Required application/configuration work before deployment

1. Implement one validated business-environment resolver used by build and
   server-side provider configuration. Local implementation and tests are recorded
   in the October 22 report; deployment configuration adoption is outstanding.
   Require an explicit value for hosted releases; do not infer business staging
   merely from a branch name, hostname or `NODE_ENV`.
2. Bind the business environment to actual Vercel project IDs in the protected
   release configuration. Reject production-project/staging-config and
   staging-project/production-config combinations. The setting alone must not
   become a way to disable production safeguards.
3. Update the current Sanity and Chit Chats checks to use that validated mapping;
   inventory other `VERCEL_ENV` checks for the same distinction. Preserve genuine
   production restrictions. Keep `NODE_ENV=production` for hosted runtime behavior
   and keep real sandbox integrations for staging, not payment mock mode.
4. Build the same reviewed source revision separately with each environment's
   configuration. Do not promote a frontend artifact containing staging build-time
   variables into production. API images can retain the same digests with separate
   runtime configuration and protected migrations.
5. Verify missing/mismatched environment values fail closed; production rejects
   staging data/providers; staging rejects live data/providers; preview secrets
   cannot be used to invoke either gateway.

The controlled-preview alternative was considered but is not selected. Staging
certification must exercise the dedicated project's native scheduler as well as
deterministic handler tests; a manual preview invocation cannot substitute for it.

### Provider mapping to record in P1-02

Keep a non-secret inventory of provider, account/project/resource IDs, environment,
region, endpoint/callback, consumer, credential-store reference, owner and evidence
date. Record values in provider stores, not this document. Provider capabilities
and actual account eligibility still require verification.

| Provider/configuration | Staging mapping | Production mapping |
| --- | --- | --- |
| Frontend, Course and Community PostgreSQL | Three isolated targets, synthetic records, own runtime/migration roles; no access to production targets | Existing independently owned targets and release-only migration roles |
| Sanity | `staging-2026-05-10`, scoped read/write/webhook credentials | `production`, separately scoped credentials |
| OAuth and sessions | Dedicated OAuth client/redirects to the stable staging origin; separate signing/session secrets and host-only cookies | Live callback origins and separate secrets; no shared parent-domain authentication cookie |
| API user/admin/service JWTs | Environment-specific keys and profiles for every producer/consumer | Separate production profiles/keys; reject staging issuers/audiences/keys |
| Mux | Separate Mux environment, credentials, webhook secret and playback-signing material; staging webhook destination | Production Mux resources and production callback; never reuse a signing/webhook secret |
| Square | Sandbox application/merchant/location and webhook credentials; sandbox payments | Live application/merchant/location and live credentials |
| Stripe Tax | Test-mode key/calculations and isolated test records | Live-mode scoped key/configuration |
| Chit Chats | Staging API environment and test account/settings; no live labels | Production account and API environment |
| S3 | Separate private staging buckets, scoped IAM, quarantine/processed paths and test lifecycle | Production buckets/IAM, retention and recovery policy |
| Redis | Isolated instance or strongly scoped namespace/credentials; no shared locks/OAuth state | Production state and access policy |
| Email/notifications | Test recipients only; recipient allowlist or delivery sink enforced server-side; isolated sender/templates/contacts | Live delivery with normal consent and suppression rules |
| Cron/admin maintenance | Staging-only bearer secrets and route-enabling settings | Independent production bearer secrets and settings |
| Logs, alerts and backups | Environment-labelled destinations, test alert routing, isolated restore target | Production alert recipient and retained backup/PITR policy |

If a provider lacks a suitable sandbox, disable that staging integration or use a
documented test adapter until a bounded live-provider test is explicitly agreed.
Do not substitute live credentials merely to make staging validation pass. Use
synthetic fixtures rather than copying live customers/orders into staging.

### Scheduled-test strategy

Use two complementary tests with the staging project's Production deployment:

1. **Deterministic release smoke:** after host readiness and migration checks,
   invoke each applicable scheduled endpoint from a protected runner using its
   staging bearer secret. If deployment protection applies, supply its separately
   scoped automation credential. Seed a bounded synthetic job and assert durable
   effects, idempotent replay, retry/lease behavior and sanitized outcome counters.
2. **Native scheduler certification:** enable the staging project's Vercel cron
   jobs for a bounded test window, observe actual invocations and capture their
   revision/environment and durable results. For infrequent schedules, use a
   reviewed staging-only temporary cadence if needed; verify the production
   artifact retains the canonical schedules. Account plan/cadence eligibility must
   be checked. An HTTP 200 alone is insufficient proof of work.

There are two independent authentication hops. The scheduled request enters
Next.js with its staging cron bearer. The function's outgoing API call obtains
the current Vercel OIDC token and separately supplies its route-specific service
JWT. Do not forward the incoming cron bearer as API authorization. Run the same
outbound transport used by server-request handlers; do not substitute a CLI token
or cached build-time OIDC token for runtime proof.

Preserve the existing eight scheduled routes and per-route enabling requirements
in the [scheduled-jobs runbook](../../scheduled-jobs-runbook.md). Planned course
delivery/reconciliation jobs join this matrix when implemented. Exercise wrong
cron secret, wrong OIDC project, expired workload token, invalid service JWT,
duplicate invocation and unavailable backend. Confirm no production DB mutation,
real charge, live shipment or email to a real customer occurs. The current backup
validation endpoint is a scaffold; its success is not a successful restore drill.

Before deleting staging compute: disable staging native cron and external test
producers, confirm no in-flight work remains or leases will recover safely,
account for provider webhook retries, preserve durable data/evidence and then
delete compute. On recreation, restore configuration, verify target isolation,
recover pending work, then enable schedules and test replay. Recheck scheduler
state after redeployments. Vercel exposes a project-level Disable Cron Jobs control.
[Cron management](https://vercel.com/docs/cron-jobs/manage-cron-jobs).

## A2 — Explicit rate-limit policy

The old global 120/minute source-IP limit is removed from both APIs. Keep private
transport-peer checks unchanged; a gateway address is not a user identity.

| Traffic | Initial local control |
| --- | --- |
| Ordinary HTTP requests in each API | `HTTP_AGGREGATE_RATE_LIMIT_PER_MINUTE=1200`; one explicit per-process budget, independent of source IP or caller-supplied identity headers |
| Course authenticated learner/admin requests | `HTTP_PRINCIPAL_RATE_LIMIT_PER_MINUTE=120`; keyed after verification by auth profile and stable subject, across routes; token refresh/IP changes do not reset it |
| Course Mux webhook | `MUX_WEBHOOK_RATE_LIMIT_PER_MINUTE=600`; independent route budget before signature verification; raw body/signature checks preserved |
| Existing internal entitlement, publication and authority routes | Existing dedicated service/network limits retained; no inherited ordinary HTTP ceiling |
| API health/readiness/metrics | Excluded from ordinary HTTP quota; remain private at deployment boundary |
| Future Community member/admin routes | Must add verified-principal quotas when their authentication is implemented; no claim that member identity exists in the current receiver-only API |

The 1,200/minute aggregate default is a provisional 20 requests/second average
budget for one API process, not a measured sustainable throughput guarantee or a
limit per user. It admits ordinary traffic above the obsolete shared 120/minute
ceiling while bounding total work. A busy/abusive caller can still exhaust an
aggregate budget; gateway connection/burst controls and post-auth quotas remain
required. Bound expensive route/media concurrency independently.

Local counters reset on restart and are not shared across replicas. Preserve the
plan's distributed-principal-quota work; before overlapping/scaling API processes,
use shared enforcement or reviewed divided aggregate budgets and certify the
result. Do not call these local changes complete distributed enforcement. P6-03
must tune limits against measured traffic, memory and burst capacity while keeping
the existing stress targets separate from the launch-usage forecast.

Required evidence: two valid principals behind one gateway have separate quotas;
forged/expired tokens cannot allocate a victim's quota; token rotation and spoofed
forwarding/identity headers cannot reset it; health remains usable during quota
exhaustion; service and webhook limits remain independent; unauthorized traffic
is bounded before expensive authentication/parsing at the gateway.

## A3 — Required Community 429 behavior

P1-03 must preserve **HTTP 429**, the safe Community error envelope and applicable
`Retry-After`/rate-limit headers when a framework limiter rejects a request. Do not
convert throttling to 500 or expose arbitrary exception messages. Unexpected
exceptions must still produce a sanitized 500.

The local correction explicitly handles framework status 429. Acceptance tests
must exercise the real limiter and error handler together, plus an unexpected
exception. Deployed gateway smoke tests must also prove the gateway preserves
429 and retry semantics. Frontend/service callers must respect retry timing and
idempotency rather than retrying immediately in a loop.

## Verification record

Both repositories passed `npm run verify` under Node 24.18.0, with
`DOTENV_CONFIG_PATH=/dev/null` and `NODE_ENV=test`:

| Repository | Unit tests | Other checks |
| --- | --- | --- |
| Course | 374 passed across 26 files | TypeScript, ESLint, enrollment contract/11 fixtures, migration journal, schema drift and OpenAPI drift passed |
| Community | 146 passed across 18 files | TypeScript, ESLint, enrollment contract/11 fixtures, migration journal, schema drift and OpenAPI drift passed |

New tests cover shared-gateway principal isolation, refreshed/forged/expired tokens,
forwarding/identity header spoofing, administrator quotas, aggregate exhaustion,
probe independence, separate Mux capacity, safe 429 headers/envelopes and unknown
500s. Course's existing loopback-listener tests required execution outside the
filesystem/network sandbox after its initial `listen EPERM`; the final full command
passed. An isolated logging-test harness was updated to register the limiter
dependency now required by authentication.

The three main plans remain synchronized; whitespace and local documentation-link
checks passed. Results are also recorded in the canonical execution tracker.
No live database integration tests, migrations, frontend runtime changes,
deployment or provider calls were performed. The accepted staging arrangement has not
been implemented; gateway, provider-isolation, distributed-quota and deployed
scheduling tests remain at their named gates. No secrets or provider resources
were changed.
