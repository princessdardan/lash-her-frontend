# Owned published-image rollback and durable recovery check

This check runs actual published application images on disposable PostgreSQL18 databases. It changes no staging or production database, host, deployment or schedule. Its [successful receipt](baselines/2026-11-02-owned-rollback-image-verified-attempt-2.json) records exact runner/helper hashes and actual image/container identities. It is preparation for the separate live P1-07 exercise.

## Reproduce

Use Node24, the already-installed repository dependencies, a clean checkout of frontend `74ca26736e5834fce639407278b4575bf4d05670` with its dependencies installed, and the local Docker Unix socket. Cache the exact candidate runtime/migration images and the pinned PostgreSQL18 image first. The runner never logs in, builds or pulls images. On an ARM Mac, cache the reviewed Linux AMD64 images explicitly.

From `/Users/dardan/workspace/lash-her-frontend`:

```sh
/Users/dardan/.local/share/mise/installs/node/24.18.0/bin/node \
  ops/platform/published-recovery-harness.mjs \
  --source-root /private/tmp/lash-p1-staging-candidate-74ca267 \
  --candidate docs/api-integration/baselines/2026-11-02-transport-corrected-staging-candidate.json \
  --rollback-candidate docs/api-integration/baselines/2026-11-02-corrected-staging-candidate.json \
  --docker-host unix:///Users/dardan/.docker/run/docker.sock \
  --output /private/tmp/lash-p1-owned-recovery-new-result.json
```

The output path must not exist. Keep the Docker daemon local. All fixture networks are internal and all application host ports are removed. Credentials, TLS keys, identities and business data are generated solely for this owned test; real environment files are not read. Synthetic credentials and all fixture containers/networks/volumes are removed in cleanup. The remaining private fixture log is mode600; do not publish it without inspection.

## Verified behavior

- Apply the 17 Course and 10 Community migrations from the actual current migration images once, only to fresh owned test databases. Guard the database names, host, test mode and empty schema. No migration CLI or SQL is rerun during image transitions.
- Run the qualified source's 15 cross-app checks on current images, then the previous candidate's runtime images, then current images again: 45 passing checks. Inspect all eight running container image references and local image IDs in each round.
- Prove frontend SDK/OIDC/TLS, enrollment idempotency, actual publisher projection, private Course authority, peer/route/public boundaries, signed Mux handling, worker restart and maintenance-write behavior in each round. Fixture signing keys do not prove live Vercel key behavior.
- Stop the publisher, create two events through the actual Course API, and use the shipped repository implementation to retain one unexpired lease and one delayed retry. A competing claim before their eligibility floor returns no events. On the next image version, the real publisher recovers both with the same canonical digest and cleared lease, and delivers the scheduled retry with its attempt count retained.
- Preserve prior business rows across both transitions. Stop all eight processes before each version change; all exit0 without OOM. This establishes a maintenance-window approach, not safe simultaneous version overlap or production load capacity.

The final successful test starts the Community reconciliation worker only after the initial publisher event is applied and its source outbox row is delivered. This makes publisher proof deterministic without weakening the original assertion. An earlier run let reconciliation win that race and timed out; its [failed receipt](baselines/2026-11-02-owned-rollback-image-verification.json) remains preserved. An earlier shutdown fixture stopped its newly recreated gateway before readiness; the runner now waits for readiness and records every process exit state. Both that [failure](baselines/2026-11-02-owned-rollback-attempt-1.json) and the subsequent [functional pass](baselines/2026-11-02-owned-rollback-attempt-2.json) remain preserved.

The previous candidate was not a working live application baseline: its migration transport guard failed before deployment. This owned test proves its runtime compatibility with the current migrated owned schema. It does not establish a completed live staging rollback. Live producer fencing, host destruction/recreation, new-machine restore, deployed recovery and final traffic admission remain required under the accepted release policy.

Validation: the successful receipt binds runner SHA256 `6c5d9ab9958b281c06b2c3399109b4d76a821bcc0a6d34aaf4730d4030b01dc9`; ESLint passed for the runner and all three helpers. These supplemental tools are separate from PR60's exact-source CI045f2dd.

## Controlled administrator fixture extension

The [extended successful receipt](baselines/2026-11-02-owned-admin-durable-recovery.json) additionally tests the exact preparation/retention components intended for the separately reviewed live exercise. The gateway peer uses a synthetic short-lived first-party administrator token to create one draft course and two audited grants through existing private APIs. The Course user projections are created through normal grant handling; this extension seeds no schema or application rows with SQL. The test then invokes `staging_work.mjs` over the published outbox repository, retains one60-second lease and one45-second retry, exits without releasing the lease, and starts the actual publisher. Both events reach applied Community inbox state with their canonical digests and retry counts preserved, delivery after the eligibility floors, and leases cleared.

Community reconciliation stays stopped until publisher delivery is observed. The current/previous/current rounds still pass all45 original checks and24 graceful stops; the new draft, users, grants and projections join the data-preservation baseline before rollback. The [earlier HTTP-only extension](baselines/2026-11-02-owned-admin-fixture-image-verification.json) is also retained. The extended receipt records the new runner, fixture and helper hashes; it does not overwrite the older success/failure receipts. The same reproduction command now runs the extension. Local tests total194 host and83 platform tests. Focused ESLint passes for the changed runner/helpers.

The live runtime adapter is separately checked [read-only inside the existing staging API containers](baselines/2026-11-02-runtime-database-readonly-preflight.json), proving exact staging runtime roles and authenticated TLS without creating a fixture or claiming outbox work. A complete reviewed parent action is still required to use these components for live rollback or host recreation.
