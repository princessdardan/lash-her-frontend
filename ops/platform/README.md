# API platform operation

The local gateway, API-container topology, harness and host-bootstrap preparation are implemented and exercised against disposable fixtures. They have not been deployed to Lightsail. The [validation record](../../docs/api-integration/baselines/2026-11-01-source-integration-validation.json) identifies tested working trees, image IDs and the remaining live requirements. P1-01 and P1-02 remain completed within their accepted scopes.

Dardan is the sole operator; operator authentication and primary host inputs are supplied, while protected runtime/release credentials remain pending. [Operational monitoring and alerting are deferred](../../docs/api-integration/decisions/2026-10-29-sole-operator-and-monitoring-deferral.md) until after the current integration plan. P1-08 and monitor/alert delivery evidence do not gate this release.

Billing access, private spending/cost reports, headroom calculations and verified forecast/spending-cap controls are [removed from completion and release requirements](../../docs/api-integration/decisions/2026-11-01-affordability-without-billing-gates.md) throughout this plan. Affordability guides design; Dardan manages the US$50 monthly target. No billing evidence is required to qualify a release. Explicit sole-operator release approval and technical capacity/recovery limits remain.

## Components and boundaries

`compose.yaml` runs the public HTTPS gateway, two private TLS terminators, both APIs, Course publisher and snapshot processes, and the Community worker. The deferred collector and host exporter live only in `compose.monitoring.yaml`, which is excluded by default. Only gateway port 443 is published. Each API listens on its separate backend network; its TLS terminator is the only other process on that network. Private peers are identified from the actual TLS socket, then passed to API authorization through an explicit trusted proxy. Caller-supplied forwarding headers are discarded.

The published gateway mapping binds explicitly to IPv4. Docker forwarding rules must independently restrict external ingress; UFW alone does not protect published container ports. Validate the original destination port after DNAT with the Docker-supported firewall backend, following [Docker's Ubuntu installation guidance](https://docs.docker.com/engine/install/ubuntu/) and [iptables chain guidance](https://docs.docker.com/engine/network/firewall-iptables/). Effective host IPv4 and IPv6 checks remain required.

The gateway validates the dedicated Vercel project's production-target OIDC identity, including its project, owner, issuer, audience, subject, environment, signature and lifetime. Business staging uses the dedicated staging project's production target. Application bearer credentials remain separate. The signed Mux webhook is the only workload-token exception; Course validates its original request bytes and signature. Route policy comes from `../gateway/routes.json`; explicit service metadata selects `/course` or `/community`, with existing entries defaulting to Course. Community currently exposes only dedicated account command/private-export aliases, not member routes or the enrollment receiver. Configure `communityOrigin=https://community-tls:8443` in a reviewed release before using those aliases; an absent origin refuses them without falling back to Course. Account commands are recovery operations independent of new-work admission. Existing publishers, authority peers and operational endpoints retain their separate private policies.

Private TLS uses a supplied CA and hostname verification. Certificates and keys are delivered to separate read-only directories. Metrics, health endpoints and Course–Community internal routes are absent from the public allowlist. No container receives a Docker socket or host networking.

Runtime images and separate migration images use pinned nonroot distroless bases. The new migration images use the standard PostgreSQL client and exclude the retired signed-bootstrap/native libpq toolchain. They default to read-only inspection. Explicit operator execution uses the separate reviewed migration CLI; this default Compose profile does not run it.

## Repeat local verification

Use Node.js 24 and a running Docker engine. Install all three repositories at the sibling paths used by `local-harness.mjs`. A normal frontend `npm ci` also installs the separately locked contract generator. If lifecycle scripts are disabled, run `npm ci --ignore-scripts --prefix tools/api-contract-toolchain` explicitly. This pins the released OpenAPI generator independently of the application toolchain.

```sh
npm ci
npm ci --ignore-scripts --prefix ops/gateway
node --test ops/gateway/*.test.mjs ops/platform/*.test.mjs
python3 -m unittest discover -s ops/platform/host -p '*_test.py'
node ops/platform/test-databases.mjs --browser
```

The database runner creates its own loopback-only PostgreSQL 16 container, fresh application databases and fixture credentials. It accepts no external database URL. It applies all three migration chains, runs database tests, exercises both API migration round trips and optionally runs the desktop/mobile Course browser fixtures. It removes its container in `finally` and prints the private local diagnostic directory.

Build the harness images from the current sources:

```sh
docker build --sbom=true --provenance=mode=max -t lash-her-gateway:p1-local ops/gateway
docker build -f ops/platform/Dockerfile.frontend-migration --build-arg FRONTEND_SOURCE_COMMIT="$(git rev-parse HEAD)" --sbom=true --provenance=mode=max -t lash-her-frontend-migration:p1-local .
docker build --target runtime --sbom=true --provenance=mode=max -t lash-her-course-runtime:p1-local ../lash-her-course-api
docker build --target migration --sbom=true --provenance=mode=max -t lash-her-course-migration:p1-local ../lash-her-course-api
docker build --target runtime --sbom=true --provenance=mode=max -t lash-her-community-runtime:p1-local ../lash-her-community-api
docker build --target migration --sbom=true --provenance=mode=max -t lash-her-community-migration:p1-local ../lash-her-community-api
node ops/platform/local-harness.mjs
```

The harness resolves those tags to immutable local index IDs before starting. The shared resolver handles Docker29 containerd indexes separately from their platform manifests; registry candidate checks independently match the published digest before comparing harness IDs. It overlays the production topology with owned databases, generated CA/certificates and signed test OIDC keys. It bundles the actual frontend transport and official Vercel OIDC SDK, exercises real API publication/authority code and removes its containers and fixture secrets. The SDK token and JWKS are injected test fixtures; passing this harness does not certify a Vercel-issued token. API test processes use the explicit test database target and development runtime mode. Local ARM64 image results do not certify future AMD64 release artifacts.

The root CI workflow runs gateway/platform and host-policy tests, an isolated kernel firewall rehearsal, dependency audits and gateway image scans. Prepared monitoring rules passed local checks; they are outside the new required platform CI gate while rollout is deferred. Existing API diagnostics tests remain. Both API workflows build/scan runtime/migration images, run PostgreSQL16 checks and now exercise the packaged operator CLI on an isolated PostgreSQL18 cluster with a private schema export. The workflows cover deployable main and staging branches; their remote required-check/protection configuration remains to be verified.

## Fresh host preparation

`host/bootstrap.py` defaults to a read-only plan. It prepares a fresh Ubuntu 24.04 AMD64 host using five exact Docker package versions and SHA-256 values from the official repository, explicit daemon configuration, and IPv4/IPv6 forwarding rules reapplied after Docker starts. It refuses existing container installations or configuration, unexpected host/architecture, unreviewed lock hashes, and an alternate default-route interface. It changes neither SSH policy nor application configuration and fetches no secret.

```sh
python3 ops/platform/host/bootstrap.py --public-interface ens5
```

Use the actual approved host interface rather than assuming `ens5`. The plan contains the package lock hash and generated firewall policy. Apply requires root, `--apply` and `--lock-sha256` with the reviewed exact hash. Downloaded bytes and Debian package name/version/architecture are verified before installation. The receipt is written privately to `/var/lib/lash-her/host-bootstrap.json`; failures require local diagnosis before a maintenance retry. Review new pins for security updates. Ubuntu dependency/security updates remain subject to the operating-system patch policy.

The pinned Docker daemon accepts this configuration in an isolated AMD64 Ubuntu validation. Separate network-none kernel tests exercise IPv4/IPv6 rule creation and hook ordering across repeated invocations, including simulated Docker rule reordering. They grant `NET_ADMIN` only to the test container's own network namespace, with no host networking or Docker socket. These checks do not establish actual Lightsail reachability, reboot/recreation success or host capacity.

## Single-operator releases

The [current staging/production release policy](../../docs/api-integration/release-policy.md) replaces the external signed source gate and separate external migration executor. Dardan reviews exact commits with passing CI, manually builds a candidate, runs staging, then explicitly promotes the same API/gateway/migration digests to production with target and backup checks. Build the frontend separately with each environment's configuration. No signing keys, subject enrollment, per-run permits, second reviewer or paid GitHub upgrade is required.

`release.candidate.json` remains incomplete. `release.mjs` validates structure only; an `approved` field is neither a signature nor standalone execution authority. Version2 records operator approval for the specific release/environment and requires matching staging source/artifact identities for production. Actual receipts, target checks and running code must be verified by the release path.

Initial qualification proves the host, authentication, scheduler and recovery behavior. Routine releases reuse that evidence while it remains applicable; repeat affected qualification when relevant changes or failures invalidate it. Required source CI and release smoke checks still run. Generated component results are references within one release record, not separate manual approval forms. The complete one-action frontend/API release coordinator remains unfinished.

The manual `.github/workflows/platform-artifacts.yml` uses one read-only `PLATFORM_SOURCE_READ_TOKEN` repository secret for exact three-repository source/CI verification. It needs no GitHub environment, App registration, external key or identity workflow. Native branch protection is optional and accurately recorded. It builds six AMD64 candidates from immutable Git contexts, scans exact digests, verifies native provenance/SBOMs, runs the integration harness and rechecks source/CI. These automatic checks require no extra operator ceremony. See [source publication](source-gate.md).

Candidate collection and qualification require clean checkouts at the recorded commits. Modified, untracked or unexpected ignored source/dotenv files refuse qualification; only known locked dependency directories and Python bytecode caches are permitted. The local harness may exercise working trees, but those results cannot alone qualify a released candidate.

The [operator migration CLI, bundle preparer and host wrapper](../../docs/api-integration/operator-migrations.md) are implemented/tested locally using the existing locks/lineage cores. The [API runtime coordinator](../../docs/api-integration/operator-runtime-release.md) joins migration and dependency-ordered runtime startup under the same lock, with configuration/role/TLS checks and failure suspension. The [frontend migration component](../../docs/api-integration/operator-frontend-migrations.md) is locally verified and its SQL/schema digests are CI-bound. The host protocol includes all three migration images under one lock. An already-current frontend must prove lineage/schema/grants using a database-enforced read-only session before either API migration; pending frontend SQL still requires the parent coordinator to verify off-host producer suspension. The [initial staging coordinator](../../docs/api-integration/operator-staging-qualification.md) now connects the current frontend database stage, API migrations/startup, expiring workload probe, pinned frontend build and verified staging domain promotion under the same lock. Pending frontend SQL still requires real producer draining. Native scheduler/host/recovery qualification, producer restoration, final admission and production orchestration remain open. The old Course signed-bootstrap workflow/compiled guards remain disabled as a retired prototype; they need no enrollment or activation. Ordinary target/lineage/TLS/seed/test guards remain. No host, image publication or live migration is authorized or performed by this documentation change.

## Smoke and operational acceptance

### Independent integration rollout controls

`src/lib/api-integration/rollout-flags.ts` provides six server-only controls. Every
control defaults off; only the literal environment value `true` enables it.

| Capability | Environment binding |
| --- | --- |
| New customer account access | `INTEGRATION_CUSTOMER_ACCESS_ENABLED` |
| Course-backed reads | `INTEGRATION_COURSE_READS_ENABLED` |
| New Course checkout | `INTEGRATION_CHECKOUT_ENABLED` |
| Entitlement delivery/recovery | `INTEGRATION_ENTITLEMENT_RECOVERY_ENABLED` |
| Community reads | `INTEGRATION_COMMUNITY_READS_ENABLED` |
| Community writes | `INTEGRATION_COMMUNITY_WRITES_ENABLED` |

Feature entrypoints introduced in P2–P4 must call
`withIntegrationFeature(capability, operation)` before obtaining credentials or
starting network/database work. Keep existing authentication, authorization,
request validation and operational readiness checks inside that operation.
The Course-read test exercises this gate with the existing workload-authenticated
gateway transport and confirms that enabling reads cannot bypass application
authorization. The controls are a foundation for those feature adapters; they do
not add customer routes or activate unfinished features.

Flags are independent. Closing customer access or new Course checkout must not
implicitly close separately enabled entitlement recovery. Community reads and
writes are separate. These controls do not switch existing product checkout,
in-person training, Square reconciliation or private API worker processes.
Enabling the Course-checkout flag is not proof that delivery/reconciliation jobs
are operational; the future checkout handler must verify those prerequisites.

The guard reads the server process environment for every new operation and does
not cancel work already admitted. On Vercel, environment edits require a reviewed
redeployment before they affect deployed functions. No remote flag service or
browser-visible `NEXT_PUBLIC_` flag is needed. Leave all six disabled until the
corresponding feature is implemented and qualified. The existing gateway smoke
switch remains separate so platform qualification can run while customer features
are disabled. The current live frontend remains pinned to its existing qualified
source; adding these controls does not deploy or change that candidate.

The same-origin admin smoke route requires `settings:manage`; the scheduled route requires the constant-time checked cron bearer. Both are disabled unless `API_GATEWAY_SMOKE_ENABLED=true`. Select the exact staging or production gateway origin through the matching server-only environment variable. Enabling these handlers does not configure a native scheduler.

Qualify the selected native scheduler, callback transport, cancellation, standby eligibility, configuration provenance and bounded request/time limits before activation. Private account spending or monetary allowance evidence is not required. The R04 handoff remains mandatory; this implementation does not approve its historical proposed allowances or amendments.

Deferred preparation: Prometheus configuration would scrape APIs through private TLS and workers through the private mesh. Prepared rules cover scrape failure, gateway rejection/upstream failure, Community worker stalls, certificate expiry and host RAM/disk pressure. Existing API rules cover additional service metrics. Collector configuration has no Alertmanager destination. `blackbox.yml` prepares separate validated-TLS IPv4/IPv6 external checks. None is activated by the default stack.

P1-08 is deferred, without a completion claim. After this plan, its separate follow-up can select the service and recipient, expand operational coverage, and verify off-host worker/auth/host-loss delivery. No monitoring credential, recipient or notification approval is currently requested. The fixture-only harness observer reads private diagnostics to verify publication and worker recovery; it is not part of the deployed application or a monitoring rollout.
