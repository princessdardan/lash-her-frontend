# P1-02 — Environment configuration and resource inventory

Prepared 2026-10-04; updated 2026-10-22. Status: Lightsail/OIDC planning baseline
selected; [authenticated inventory and local guards](baselines/2026-10-22-p1-02-progress.md)
are recorded. The [staging project setup](baselines/2026-10-22-p1-02-setup.md)
configures both projects' APP_ENV/APP_VERCEL_TEAM_ID and prepares host IaC.
[Deployment preparation](baselines/2026-10-22-p1-02-deployment-preparation.md)
adds the Git connection, isolated frontend/Community Neon and Redis resources,
separate Sanity project, sandbox/email credentials and a failing release preflight.
[Protected release handoff](baselines/2026-10-22-p1-02-release-handoff.md) adds the
Community runtime role and initialized operator-only AWS secret store, with
provider request plans.
[Provider configuration](baselines/2026-10-22-p1-02-provider-configuration.md) adds
the new staging Google project/two OAuth clients and reviewed test audience,
verified isolated Resend sender/segment/templates, and three disabled signed
webhooks with separate approved ingress credentials.
P1-02 remains **BLOCKED** on host provisioning, provider isolation,
operator inputs and complete itemized costs (EXT-01–EXT-03, EXT-05–EXT-15,
COST-01–COST-08). Accountable owner: Dardan; delivery: OPS with each application
owner. These requirements do not establish that resources are provisioned.

[ENV-01e](decisions/2026-10-17-lightsail-ingress.md) replaces Render and removes
Vercel Static IPs from the plan. Keep Next.js on Vercel; consolidate the APIs and
required workers as separate containers on one production Lightsail VPS. Keep
existing PostgreSQL providers. Use a separate reproducible staging VM on demand,
with isolated data, secrets and provider settings; never co-host it with production.
The earlier Render/Railway/VPS comparisons in the
[decision log](decisions/2026-10-04-p1-02.md) are historical alternatives.

The accepted cost constraint remains zero current users and an expected 50–100
registered launch users. Concurrency and process resource use are unmeasured.
AWS MCP now verifies account `691588646557` through the scoped deployment role
in `us-east-1`; no instances or static IPs were returned there. Other regions and
denied storage/network inventory remain unverified. Vercel production project
`prj_wvBLVsXzC1XMZ11hSIfBi2bHXsyy` and its team/domain were refreshed. Dedicated
staging project `prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM` was subsequently created and
verified; see the [setup evidence](baselines/2026-10-22-p1-02-setup.json).

The [audit follow-up](decisions/2026-10-17-audit-remediation.md) records ENV-02-01,
accepted by Dardan on 2026-10-17: use the dedicated staging project's Production
target, server-only `APP_ENV=staging`, and `staging.lashher.com`. Production keeps
its own project's Production target, `APP_ENV=production`, and `lashher.com`.
Keep separate staging compute, providers and exact OIDC project bindings. Both
OIDC environment claims are `production`; environment-only authorization is
insufficient. The validated resolver and Sanity/Square/shipping guards now have
local unit evidence. APP_ENV/APP_VERCEL_TEAM_ID are configured on both projects'
Production/Preview targets and the real staging ID is recorded in the uncommitted
source candidate. Resource bindings and remaining OAuth/webhook/credential gaps
are recorded in the [release manifest](../../ops/staging/first-release.json).
Deployed isolation evidence remains required for P1-02; native scheduled tests remain required for P1-07.

## Process mapping

| Process | Repository | Deployment | Ingress / readiness |
| --- | --- | --- | --- |
| Frontend and its scheduled financial delivery | frontend | Vercel; isolated staging project | Same-origin browser handlers; OIDC on outbound backend calls in P1-03 |
| Course API | course-api | Separate Lightsail Compose container | Gateway route allowlist; exact signed Mux webhook exception; deployed revision unverified |
| Course enrollment publisher | course-api | Separate private worker container | Private HTTPS/metrics; P1-03/P1-04 verification |
| Course snapshot worker | course-api | Separate private worker container | Private health/metrics; P1-04 verification |
| Community API | community-api | Separate private API container | Private enrollment receiver; gateway member/admin routes as implemented |
| Community repair/reconciliation worker | community-api | Separate private worker container | Private authority HTTPS/metrics; P1-03/P1-04 verification |
| Community media worker | community-api | Separate private worker container | P5-03 implementation; reserve resource/deployment wiring in P1-04 |
| HTTPS gateway with OIDC verification | frontend ops | Public gateway container on the same VM | Only published application port; exact route and token controls P1-03 |
| Metrics collector | frontend ops | Private collector container on the same VM | Off-host destination/host-loss alert; P1-08 certification |
| API maintenance and migrations | owning repo; OPS coordination | Bounded one-shot containers | Protected target/lineage/lock controls P1-04/P1-07 |

Compose/bootstrap/gateway/release configuration belongs in frontend ops. Runtime
and migration images remain in their owning repositories and are built in CI,
pinned by GHCR digest and deployed under the manifest/migration sequence. Separate
container limits, private peer addresses/networks, pool budgets, graceful shutdown,
restart/heartbeat recovery and TLS must be specified before deployment.

## Resource inventory still required

| Resource | Staging | Production | Required closure evidence |
| --- | --- | --- | --- |
| AWS account, region, Lightsail bundle and VM | No VM/static IP found in authorized us-east-1 inventory; separate staging provisioning required | No VM/static IP found; same account 691588646557 and scoped deployment-role access verified | Final bundle/operator choice, administrator-controlled provisioning, instance/firewall/address/DNS mapping and reproducible lifecycle; denied storage/network reads remain gaps |
| Vercel project and domain | Created prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM with all-deployment authentication; APP_ENV/team configured; staging.lashher.com bound to Production and verified with configured DNS; OIDC/system variables independently read back; Git connected with staging Production branch and release preflight build command; no deployment | Project prj_wvBLVsXzC1XMZ11hSIfBi2bHXsyy, team and lashher.com verified; APP_ENV/team configured for subsequent deployments | CLI API readback verified settings; deployed claims, approved source/migration pins, deploy permissions and isolated callbacks remain unverified |
| Frontend operational PostgreSQL | New Neon morning-tree-37564896; separate restricted runtime role verified; owner aliases removed; local PG18 compatibility passed; cloud DB unmigrated | Existing populated provider retained | Target IDs, runtime/direct migration mapping, pool/backup limits |
| Course PostgreSQL | Existing separate staging endpoint read-only verified: PG16.15, 12 tables/journal; lineage not certified | Configured target reported in P0 | Fresh lineage/isolation and distinct runtime/migration credentials |
| Community PostgreSQL | New Neon still-darkness-27201043, unconnected to frontend; separate runtime role configured; pooled runtime/direct owner credentials imported into operator-only AWS Secrets Manager and protected-resolver TLS verified; PG18.6 empty | Unverified | Provider/DB IDs, direct migration target, lineage and connection limits |
| Protected staging DB release store | AWS Secrets Manager in 691588646557/us-east-1; Community runtime/migration and frontend migration records initialized; dedicated rotating CMK; operator-only, no CI/host access | No production records created | Separate release identities/trust, rotation workflow and persistent audit retention before deployed use |
| Frontend ingress boundary | OIDC bound to staging project/target | OIDC bound to production project/target | Signature/claim/rotation verification plus application authorization, exact route policy, spoofing/abuse tests; no Vercel Static IP entitlement |
| Private HTTPS/CA and peer networking | Unverified | Unverified | Certificate lifecycle, exact private peer/source/proxy mapping, unpublished ports and IPv4/IPv6 tests |
| Monitoring and host recovery | Unverified | Unverified | Off-host alert/log destination, external heartbeat, retention, operator and replacement-host rehearsal |

The table's unverified entries remain closure requirements. Current DB release-store
metadata and provider preparation are in the [handoff evidence](baselines/2026-10-22-p1-02-release-handoff.md). [Provider evidence](baselines/2026-10-22-p1-02-provider-configuration.md) records the
completed Google/Resend configuration and disabled webhook bindings.
[Preparation evidence](baselines/2026-10-22-p1-02-deployment-preparation.md)
records the applied provider credentials, role grants, new isolated resources and
remaining release gates. Redis is tidy-monarch-236694.upstash.io; Sanity is the
separate project 7o23yrvk with the published editorial copy. New Neon projects use
shared Launch billing and Upstash uses paid pay-as-you-go billing. Lightsail
[provisioning configuration](../../ops/aws/README.md) remains prepared only; no host,
application deployment or cloud application migration has run.

## Secret and provider isolation

Store values in protected provider/environment stores. Version only the names,
owners, target mappings and rotation references. Use environment-specific groups,
then service-specific delivery so a worker receives only credentials it needs.

| Configuration family                    | Consumers                                     | Isolation/closure requirement                                                                                      |
| --------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Operational DB runtime/direct migration | Each owning application/job                   | Three independent databases; distinct environment/runtime/release credentials                                      |
| User and administrator JWT              | Frontend signer; corresponding API verifier   | Four independent audience/profile keys per environment; bounded rotation overlap                                   |
| Gateway workload identity | Frontend adapters/scheduled calls; gateway verifier | Exact issuer/audience/team/project/target; dedicated staging project; public JWKS rotation, no browser exposure; existing application JWTs remain separate |
| Service JWT                             | Named producer/receiver only                  | Independent entitlement/publication/authority/lifecycle credentials; see v1 contract README                        |
| Google/Resend authentication            | Frontend                                      | Separate customer/admin sessions; environment callback origins and email-link endpoints; sender/template ownership |
| Mux                                     | Course API                                    | Environment credentials/webhook/playback signing; public signed webhook route only                                 |
| Square                                  | Frontend                                      | Sandbox/live merchant/application/location mapping and webhook keys; preserve existing commerce                    |
| Stripe Tax                              | Frontend                                      | Test/live configuration with scoped access; approved tax policy remains P4                                         |
| S3 media                                | Community media path/worker                   | Private environment buckets/IAM/lifecycle; quarantine/processed separation P5-03                                   |
| Notifications                           | Frontend/Community delivery workers as needed | Sender/domain ownership, environment recipients, transactional templates; preserve consent rules                   |
| Redis/OAuth/maintenance                 | Owning current frontend workflows             | Environment-isolated existing consumers, no shared staging/production locks or tokens                              |
| GitHub App/GHCR/deployment              | Protected CI/release jobs                     | Read-only sibling Contents scope and narrowly scoped deploy/publication credentials                                |

## Production and temporary-staging cost worksheet

The total cannot be calculated from verified account/usage inputs yet. Unknown
costs are not zero. Registered-user count does not establish concurrent load.
Use one VM bundle for all API-stack containers per active environment, including
seven base long-lived processes, any required TLS proxies and the future media worker; do not charge
one VM per process. Include bounded jobs and measured update headroom.

`total = production VM + temporary staging + snapshots/retained storage/transfer + existing databases/PITR + Vercel + protected secrets/KMS + monitoring + application providers + contingency`

| Input | Source | Evidence still needed |
| --- | --- | --- |
| Lightsail VM compute and temporary staging | [Lightsail pricing](https://aws.amazon.com/lightsail/pricing/) | Region/bundle, active hours, measured RAM/CPU/burst use and update overlap; US$24/month 4 GB or US$44/month 8 GB are test candidates |
| Snapshots, retained addresses/storage and transfer | [Lightsail pricing](https://aws.amazon.com/lightsail/pricing/) | Snapshot retention/GB, transfer allowance and regional overages, resources retained between staging runs |
| Vercel application and ordinary usage | Existing account billing; [OIDC availability](https://vercel.com/docs/oidc/api) | Actual subscription/function/build/transfer usage, staging-project mapping; no Static IP add-on |
| Three PostgreSQL providers and backups | Existing provider billing | Fixed plans, storage/PITR, connection ceilings and isolated staging targets |
| Protected staging secret store | [Actual resource/cost metadata](../../ops/staging/release-store.json); AWS Secrets Manager/KMS pricing checked 2026-10-22 | Initial full-month storage USD 2.20 for three secrets and one key, plus requests/tax/FX and future key-rotation surcharges; retained resources continue billing |
| Operations and monitoring | Selected protected stores/monitoring providers | Host patching, CA/certificates, off-host alerts/logs, retention, restore/recreation ownership and any billed services |
| Square/Stripe Tax | Merchant/provider account billing | Approved transaction/calculation quantities and account rates |
| Mux | Mux account billing | Stored/delivered minutes, resolution and environment allocation |
| S3/media/notifications | Selected account billing | Storage/requests/egress/email quantities and rates |

Lightsail bundle prices refreshed through GetBundles on 2026-10-22; public pricing
and billing documentation checked the same day. OIDC planning sources were checked
2026-10-17. Prices above are USD
before tax/FX and introductory credits. Snapshot storage is separately listed at
US$0.05/GB-month. This is not a complete or approved budget. Stopping a staging VM
does not stop billing: savings require safe deletion/recreation, with retained
resources still accounted for. No load balancer, NAT gateway or paid ingress
subscription is required by this design.

Keep COST-01–COST-08 open until source/date, region, billing currency, tax/FX,
usage, contingency and budget decision are recorded. P1-02 closes on reviewed
resource configuration and inventory; P1-03 verifies the new ingress boundary,
P1-04 verifies containers, and P1-07/P1-08 require deployed release/operations
proof. Selecting the topology does not complete those tasks.
