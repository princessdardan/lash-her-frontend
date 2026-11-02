# Operator API runtime release

`ops/platform/host/release.py` coordinates selected migrations and API runtime startup in one explicit operator action. It is implemented locally; it has not run on a Lightsail host. The [release policy](release-policy.md) remains authoritative. This command does not deploy the frontend, change feature flags or certify staging/production acceptance. Full bundles now include the frontend migration image and share the lock across all three databases. The standalone CLI refuses their apply until a reviewed frontend coordinator suspends/drains off-host writers and native schedules; that coordinator is still unfinished.

The [frontend provider component](operator-frontend-release.md) now implements native schedule disabling with readback and exact-source remote build staging without changing production domains. It is exercised against owned HTTPS fixtures and is not connected to this CLI. Schedule disabling alone cannot satisfy the frontend writer-quiescence callback, and no promotion/admission path is exposed by that component.

## Maintained inputs

Use the qualified candidate and private migration bundle from [operator migrations](operator-migrations.md). Candidate collection automatically records the selected Compose hash and private TLS peer/route policies. An older candidate without those bindings must be rebuilt. Production preparation additionally needs `workload: {environment: "production", projectId: "prj_..."}` in its target settings, using the separate production Vercel project. This changes environment configuration while preserving the staging-tested source and image pins.

Keep runtime configuration in an operator-owned mode0700 directory outside Git checkouts. It contains:

- `runtime.json`: version1, the selected `environment` and `releaseId`, the selected host's `/etc/machine-id` as `hostMachineId`, and existing `previousReleaseRef` / `maintenanceRef` references. For a fresh staging host, `previousReleaseRef` may identify initial creation with no previous release. These are maintained target/recovery inputs, not signing credentials or enrollment.
- `gateway.json` with `maintenance: true`, the exact Vercel identity, environment and public gateway hostname; `course-tls.json` / `community-tls.json` matching the candidate's generated policies.
- Five process-specific raw environment files: `course-api.env`, `course-publisher.env`, `course-snapshot.env`, `community-api.env`, `community-worker.env`. Keep each file private, with only that process's needed credentials. Values use literal `KEY=value` lines without shell expansion. [Compose raw file format](https://docs.docker.com/reference/compose-file/services/#format) preserves dollar signs and quotes. No ambient `.env` file is loaded by the command.
- The existing CA/certificate/key layout: `tls/ca.pem`; gateway `tls/gateway/{ca,cert,key}.pem`; Course and Community `tls/{course,community}/{cert,key}.pem`. Gateway and peer certificates must match their intended names. The private CA copy in the gateway directory must equal `tls/ca.pem`. Keys and environment files are mode0600 or0400 and owned by the operator running the command.

Each environment file requires the explicit database selector and named URL: staging uses `DATABASE_TARGET=staging` / `STAGING_DATABASE_URL`; production uses Course `DATABASE_TARGET=prod`, Community `DATABASE_TARGET=production`, and `PROD_DATABASE_URL`. URLs must identify the reviewed direct host/database and separate runtime role, with `sslmode=verify-full`. No other query parameters, legacy URL fallback, migration credentials, cloud/GitHub credentials or TLS/loader/process overrides are accepted. Keep URL values private. Resolve AWS-held values through existing `asm-exec` dynamic references at runtime; never put them in arguments or chat. No new secret service is required.

## Execute on the selected host

The default action shows the environment, host identity, target databases, images, maintenance/recovery references and dependency order without reading runtime environment files or keys:

```sh
python3 ops/platform/host/release.py BUNDLE CONFIGURATION RESULTS
```

Apply requires root on the selected Linux AMD64 host and its local Docker Unix socket. It refuses another machine or a remote Docker context. Use an authenticated host session and the reviewed source; this does not require a separately hosted executor. `RESULTS` must be a private mode0700 directory outside Git. Inject the two named migration URL variables through the existing private runtime wrapper as in the migration runbook, then invoke:

```sh
python3 ops/platform/host/release.py BUNDLE CONFIGURATION RESULTS --apply --confirm staging/RELEASE_ID
```

Use `production/RELEASE_ID` for the explicitly selected production target. Do not run the standalone migration command first: this command owns that stage too. There is no second approval click.

The command snapshots the selected inputs privately, validates the pinned topology and all eight process/TLS configurations in network-disabled containers, then runs the existing migration stage. Every selected migration credential must be available before any database is changed. Full bundles additionally use `FRONTEND_STAGING_MIGRATION_DATABASE_URL` or `FRONTEND_PROD_MIGRATION_DATABASE_URL`; only that named value enters the frontend migration container. Writer/scheduler quiescence must be established by the reviewed parent coordinator before any of the three database writes. Runtime files are validated against the reviewed runtime roles; they never replace migration credentials.

The same release/watchdog flock stays held across durable database success, receiver/read API startup, private TLS startup, workers/publisher and gateway startup. No dependency is implicitly started by Compose. Each stage waits for health, and final checks verify exactly one running container per service with the expected project, image and readiness state. It also probes public TLS/auth refusal, hidden metrics, private Course TLS/catalog and application-auth refusal, and the private Community peer denial. These checks create no enrollment/payment/write command. The gateway remains in maintenance mode: new application writes receive HTTP503 with Retry-After, while workload-authenticated read probes and signed Mux callbacks remain available. Runtime readiness is therefore not write admission.

## Outcomes and remaining acceptance

`RESULTS/RELEASE_ID/migration-outcome.json` records database verification independently. `RESULTS/runtime-RELEASE_ID/runtime-outcome.json` records runtime readiness and binds the migration result/candidate. `API_RUNTIME_READY` means the API stack is ready for the remaining coordinated frontend and live checks; it always retains `trafficAuthorized=false`, `frontendPromotionAuthorized=false`, `releaseAccepted=false`, `realVercelOidcVerified=false` and `externalIngressVerified=false`.

A startup/probe/retention failure stops the selected runtime and verifies writers are suspended while the flock is held. A failed cleanup is explicitly unverified. Never accept an existing outcome if `runtime-failure.json` exists or the command did not exit successfully. A failed runtime does not erase a successful migration receipt or roll the database back. Review actual state before a new deliberate attempt; existing attempt directories are never overwritten. Keep affected writes paused while correctness is uncertain.

Frontend private-DB execution is now included in the locally tested lock protocol. Frontend writer/scheduler quiescence and Vercel deployment ordering, real server/scheduled workload OIDC, external IPv4/IPv6 boundaries, native scheduler behavior, host recreation/restart and applicable recovery/compatible rollback remain live release checks. Finish them before the acceptance receipt or production domain/feature activation. The remaining frontend/acceptance coordinator must explicitly admit gateway writes after those checks; this API startup step never disables maintenance. Do not flip the configuration merely to bypass unfinished acceptance. Retain sanitized receipts and the compatible previous manifest/configuration privately off-host using existing storage. Private schema exports and credential-bearing snapshots must stay outside public Git history.

Local evidence covers mocked coordinator ordering/failure paths, eight real image production-config/TLS preflights with owned fixtures, and the actual packaged gateway's probes in the disposable integration harness. It does not establish host root/ownership behavior, real provider credentials, public certificate/DNS state or live deployment readiness. Billing evidence remains excluded; monitoring/alerts remain deferred.
