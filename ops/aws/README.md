# P1-02 Lightsail provisioning

Prepared 2026-10-22. Configuration only: no Lightsail stack, host, address, DNS
record, key pair, credential, database or deployment was created. The existing
application deployment role remains unchanged.

`lightsail-host.cfn.json` creates one stateless Ubuntu 24.04 host and an attached
static IPv4. Use a separate stack per environment. `provisioning.json` records the
verified account/region, sizing candidate, Vercel identities and unresolved inputs.
`lightsail-staging.parameters.example.json` deliberately contains invalid required
placeholders; it cannot establish an operator or authorize spending.

## Inputs and authority

- Expected account: `691588646557`; region: `us-east-1`. Verify the provisioning
  identity and region before creating a change set. Use administrator-controlled
  CloudFormation access, separately from `LashHerDeploymentRole`.
- Staging stack candidate: `lash-her-api-staging`; zone: `us-east-1a`; blueprint:
  `ubuntu_24_04`; bundle: `medium_3_0`. AWS MCP verified the blueprint, all six
  regional zones and the 4 GB/2 vCPU/80 GB public-IPv4 bundle on October 22.
- Supply the assigned operations owner identifier, approved operator IPv4 `/32`
  and existing regional Lightsail key-pair **name**. Keep its private key in the
  protected operator store. Do not put credentials in parameters or user data.
- The verified 4 GB candidate has a US$24 monthly compute cap; the 8 GB
  `large_3_0` candidate is US$44. Capacity and the complete budget remain open.
  There is no production bundle selection. A stopped host is still billable;
  snapshots, transfer and retained unattached addresses can add charges.

## Network and host preparation

The Lightsail firewall permits TCP 443 from IPv4 clients and TCP 22 from the
operator's single IPv4. Every configured port has an empty IPv6 source list;
IPv6 ingress is closed. Port 80 is closed. The future gateway must use a
443-compatible certificate challenge or receive separately reviewed ACME routing.
No database, API, worker, metrics or internal TLS port is published.

User data prepares root-owned directories, disables SSH password/root login and
sets the same IPv4 ingress policy in UFW. It installs host security prerequisites;
it does not install Docker, run application containers or fetch secrets. Check
`cloud-init status --wait`, `/var/log/cloud-init-output.log`, `sshd -T` and
`ufw status verbose` through approved SSH access before installing workloads.
CloudFormation completion alone does not prove successful user data or readiness.

P1-04 must install Docker/Compose, apply effective IPv4/IPv6 forwarding controls,
and prove only gateway HTTPS is exposed. Docker-published ports can bypass UFW.
P1-03 must implement exact OIDC claims/routes, TLS/CA and application authorization.
No gateway DNS name, certificate policy or actual OIDC token is certified here.

Bootstrap input changes do not rerun user data on an existing host. Recreate a
host with reviewed parameters or coordinate the host firewall and SSH change
before changing the Lightsail rules. In particular, changing only the operator
CIDR in CloudFormation can lock out the operator at the old UFW rule. Bundle,
zone and blueprint changes require a replacement plan; Lightsail CloudFormation
does not support in-place updates for these properties.

## Provisioning and temporary staging lifecycle

1. Resolve the required parameters, named operations owner, staging test window,
   budget and independent provider/database configuration. Review the exact
   account, region, template and parameter values.
2. Run `cfn-lint ops/aws/lightsail-host.cfn.json` and
   `cfn-guard validate --rules ops/aws/lightsail-host.guard --data ops/aws/lightsail-host.cfn.json --output-format json`.
   The project guard rules check ownership, restricted SSH, gateway-only ports,
   closed IPv6 ingress and address ownership. They are a bounded project policy,
   not general AWS compliance certification.
3. An authorized provisioning administrator creates and reviews a CloudFormation
   change set using a completed copy of the parameter example. Check account-aware
   pre-deployment validation and CloudTrail auditability, then execute only with
   provisioning authorization. Do not grant broader permissions to the application
   deployment role to work around the separation.
4. Record stack/instance/address IDs and effective port states. Verify host
   preparation and SSH access. Record approved gateway DNS separately. Verify
   negative IPv4/IPv6 access tests before deploying the P1-03/P1-04 release.
5. Use immutable CI-built image digests, per-service secret delivery and the
   protected release workflow. Keep authoritative state in external PostgreSQL;
   preserve configuration, certificates and recovery material off-host.
6. After a staging test window, preserve sanitized evidence and explicitly
   authorize stack deletion. Both resources have `DeletionPolicy: Delete` and
   `UpdateReplacePolicy: Delete`; deletion destroys the root disk and releases the
   static address. Check snapshots/disks/addresses for residual charges and remove
   stale DNS. No deletion is performed by this configuration or this task.

Recreating a deleted stack allocates a new address; DNS must be updated and
verified. Use independently reviewed production parameters and a replacement-host
rehearsal before production. Snapshots and host preparation do not establish
database PITR or the required recovery objectives.

## Vercel configuration

| Project | Target | APP_ENV | APP_VERCEL_TEAM_ID |
| --- | --- | --- | --- |
| `lash-her-frontend` / `prj_wvBLVsXzC1XMZ11hSIfBi2bHXsyy` | Production | `production` | `team_2Hrn5eMZyZxfAWdmYvyKi9t3` |
| Same production project | Preview | `staging` | Same verified team |
| `lash-her-frontend-staging` / `prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM` | Production and Preview | `staging` | Same verified team |

These values are configured and target scopes were checked using the CLI. The
staging project uses Next.js, Node 24 and Vercel authentication on all deployments.
It is connected to `princessdardan/lash-her-frontend` with `staging` as its
Production branch. No application deployment has been created. `staging.lashher.com` is bound
to its Production target; the dedicated domain read confirms verification, and
Vercel reports correctly configured DNS with no conflicts. No DNS record was
written by this task. The repository's
existing local Vercel link still targets production; a temporary CLI directory was
used to inspect staging. Use explicit project/team targets for future operations.

After the initial automatic approval rejection, Dardan explicitly approved the
domain binding and project settings. The project update for
`autoExposeSystemEnvs=true` and
`oidcTokenConfig={enabled:true,issuerMode:"team"}` succeeded. The connector omits these fields; a subsequent authenticated CLI API read
independently confirmed both values. These settings
deliver system variables and server-side workload tokens to deployments. Exact
token-claim verification and gateway authorization remain P1-03 acceptance work.

The [first-release manifest](../staging/first-release.json) and
[deployment preparation evidence](../../docs/api-integration/baselines/2026-10-22-p1-02-deployment-preparation.md)
record the dedicated database, Redis and Sanity resources and remaining gates.
Before staging deployment, verify source/release controls,
configure `NEXT_PUBLIC_SITE_URL=https://staging.lashher.com`, the staging Sanity
dataset and independently isolated DB, Redis, payment, email and other providers.
Do not copy shared production credentials. No production redeploy is included;
new Vercel variables affect subsequent deployments only.

References: [CloudFormation instance](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-lightsail-instance.html),
[port properties](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-lightsail-instance-port.html),
[static IP](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-lightsail-staticip.html),
[Lightsail pricing](https://aws.amazon.com/lightsail/pricing/),
[Docker firewall behavior](https://docs.docker.com/engine/network/packet-filtering-firewalls/),
[Vercel environment variables](https://vercel.com/docs/environment-variables),
[Vercel project settings](https://vercel.com/docs/rest-api/projects/update-an-existing-project).


## Staging DB release store

The separate [release-store CloudFormation template](staging-release-store.cfn.json)
has been provisioned after the user's explicit AWS Secrets Manager selection.
It manages a dedicated rotating CMK, three staging DB credential records and
retained operator-only resource policies. The [handoff runbook](../staging/release-store.md)
and [actual public metadata](../staging/release-store.json) describe imports,
verification, permissions, billing and remaining release/audit/rotation gates.
This adds no Lightsail host, CI trust, host secret access or production secret.
