# Course media recovery and account-export cleanup

These two processes are part of the pinned Course runtime image. Source review
used Course commit `11ea33d085e277bf4d9517476b683b5389c8eaa8`, including
`src/db/client.ts`, both standalone entrypoints and their process-env parsers.
The image must contain the corresponding compiled files before deployment.

| Compose service | Entrypoint | Private env file | Local operational port | Parser |
| --- | --- | --- | --- | --- |
| `course-media` | `dist/mux-media-worker.js` | `course-media.env` | 4003 | `dist/config/mux-media-process-env.js`: `parseMuxMediaProcessEnv()` |
| `course-export-cleanup` | `dist/account-export-cleanup-worker.js` | `course-export-cleanup.env` | 4004 | `dist/config/account-export-process-env.js`: `parseAccountExportProcessEnv()` |

The adjacent `.env.example` files contain reserved `.invalid` database hosts and
cannot qualify a release. Render separate protected files in the reviewed
release directory using the selected Course runtime role and verified TLS.
For production use `DATABASE_TARGET=prod` and `PROD_DATABASE_URL`; never include
both database bindings. The host release owner must register both files and
enforce their closed environment scopes before using this Compose candidate.

The common file scope is `NODE_ENV`, `DATABASE_TARGET`, and exactly the selected
`STAGING_DATABASE_URL` or `PROD_DATABASE_URL`. Media additionally permits
`MUX_TOKEN_ID`, `MUX_TOKEN_SECRET`, `MUX_ENVIRONMENT_ID`,
`MUX_MEDIA_RECOVERY_ENABLED`, `MUX_MEDIA_CLEANUP_ENABLED`, and
`MUX_MEDIA_RECOVERY_POLL_INTERVAL_MS`. Export cleanup additionally permits
`COURSE_ACCOUNT_EXPORT_CLEANUP_ENABLED` and
`COURSE_ACCOUNT_EXPORT_CLEANUP_POLL_MS`. Unknown variables must refuse at the
host guard, including unrelated learner/admin JWT keys, application service
credentials, Mux signing keys and webhook secrets. Zod ignores unknown keys;
the process parser alone does not establish credential separation.

Both loops default to disabled in the actual parsers and examples. Compose
supplies only `NODE_ENV`, `PORT` and a heap limit, so it does not override the
reviewed enablement flags in a protected env file. Media recovery requires its
three scoped Mux bindings when enabled; media cleanup requires recovery and
separate explicit enablement. Export cleanup requires only its database.
Enabling either loop is a later reviewed staging action, not a consequence of
adding these service definitions. Production activation remains excluded.

## Runtime boundaries

Each worker has its own egress bridge and no shared application mesh, API
backend, TLS volume, published port or service-to-service route. Existing
container hardening applies: read-only filesystem, dropped capabilities,
`no-new-privileges`, bounded processes, ephemeral `/tmp`, and bounded local
logs. Separate bridges isolate direct container adjacency. They do not impose
destination-level Internet or database allowlists. Media needs the selected
PostgreSQL endpoint and Mux; cleanup needs only PostgreSQL. Neither receives
gateway/application credentials. No additional public listener or monitoring
activation is introduced.

`/health` reports process liveness. `/ready` performs the real bounded database
probe even when the loop is disabled; a missing/unavailable database means 503,
not healthy disabled readiness. Docker probes `/ready` on the explicit worker
port with a four-second timeout. `/metrics` exposes enablement and existing
worker counters inside the isolated container network; no external collector
is enabled. These probes do not certify migrated business tables or enabled
provider work. Those need the normal candidate migration and staging checks.

SIGTERM/SIGINT interrupt the wait and await the current iteration, HTTP server
and database pool closure. Compose allows 60 seconds before forced termination.
Media provider requests have a ten-second timeout with SDK retries disabled;
upload scans have a twenty-second budget checked between requests. Ordinary
business SQL has no process-wide timeout, so shutdown has no hard completion
guarantee before Docker's deadline. Forced termination is a recovery condition:
retain durable media intent/leases, reconcile provider receipts after lease
expiry, and re-run idempotent expired-export cleanup. Do not infer completed
provider effects from a terminated process.

Compose restarts crashed processes. The existing host watchdog has a fixed
service list and a thirty-second restart override; adding these workers to
unhealthy-process recovery requires the serialized host owner to add both
names with a sixty-second override and a longer subprocess timeout. Keep its
existing durable restart intent, rate limits and release lock. Until that
change lands, do not claim watchdog coverage for the new workers.

## Resource and connection accounting

Each new worker has a 192 MiB memory ceiling, 128 MiB V8 heap limit and 0.2 CPU
ceiling. The existing one-host topology gains 384 MiB of memory ceilings and
0.4 CPU: ten ordinary services total 2,688 MiB and 3.25 CPUs of ceilings. Both
optional migration-inspection containers add 512 MiB and one CPU while active,
for 3,200 MiB and 4.25 CPUs of ceilings. CPU ceilings can oversubscribe the host;
these sums are configuration bounds, not measured workload consumption or
capacity certification. Preserve existing technical capacity smoke and failure
checks. This package does not resize a host, add a host or paid service, change
the US$50 monthly target, or introduce billing/headroom forecast approval gates.

The Course source creates independent pools capped at ten ordinary connections
and one readiness connection per process. API, publisher, snapshot, media and
export cleanup therefore have a maximum of 55 runtime connections per replica
set, plus one isolated migration connection. `databaseConnectionBudgets.course`
records five processes, maximum 55, migration maximum one and reviewed limit
floor 60. Disabled loops still start an operational process and can use the
readiness pool; ordinary pools open lazily. A limit of 60 is a configuration
requirement, not evidence that a deployed database role/provider has that
capacity. Verify the actual selected runtime-role/database limits under the
existing release checks before enabling added work. Extra replicas require
new accounting. Community remains 22 runtime plus one migration connection.

## Serialized host release changes

The host release owner applies these changes to `host/release.py`; this package
does not edit that file:

1. Append `course-media` and `course-export-cleanup` to `ENV_FILES`.
2. Add both to the independent worker `STAGES` entry containing
   `course-snapshot` and `community-worker`, after APIs/private TLS and before
   publisher/gateway startup. No API peer dependency is needed by either worker.
3. Map both names to `courseRuntime` in `IMAGE_KEYS`.
4. Add `NODE_CONFIG_CHECKS` importing each tabled module and invoking its parser.
5. In `environment_values`, reject keys outside the service scopes above before
   evaluating Node config. Keep existing exact database target/role/TLS checks.
6. Add the bounded watchdog handling described above. Keep historical C07
   restoration assertions tied to the original eight-service release.

The serialized owner must test protected-input snapshots, parsed Compose
environment, preflight config checks and staged health checks for both names.
Existing published images that lack these entrypoints cannot start the expanded
ten-service candidate. Reusing an earlier accepted release must retain its
original Compose/config/source, rather than applying this candidate to it.

## Verification

Run the ordinary platform suite with Node 24:

```sh
node --test ops/platform/*.test.mjs
```

To verify the actual compiled Course modules from a reviewed built checkout:

```sh
COURSE_WORKER_RUNTIME_DIR=/absolute/path/to/reviewed-course-checkout \
  node --test ops/platform/course-workers-runtime.test.mjs
```

The explicit runtime suite uses only synthetic loopback configuration and an
empty temporary working directory. It checks minimal production parsing,
invalid flags, real process liveness, disabled metrics, readiness refusal with
an unavailable database, and SIGTERM exit under the configured heap limit.
Local listeners are required. Without the explicit directory those four cases
are skipped; that run provides no compiled-runtime evidence. Provider work,
migrated business SQL, deployed container limits, external egress and staging
certification remain separate checks.

## Existing C07 catalog bootstrap

The accepted C07 record identifies frontend source
`b99d4f346696f897fa6a6729dfcc52d6503fe8d6`, release
`p1-41748860504-1`, and gateway image
`ghcr.io/princessdardan/lash-her-platform-gateway@sha256:2bdd89062050b8e975a6205c47beb707010bc4e0845dab789c0800d0ad78774d`.
At that source, `ops/gateway/policy.mjs` accepts `/course/...` aliases and
`routes.json` explicitly allows workload-authenticated `GET /v1/courses`.
Current admission bootstrap still calls the ordinary `runGatewaySmoke` path;
its published-v1 catalog response schema is unchanged from C07. An alias or
catalog-schema upgrade is therefore not required solely to bootstrap against
that exact accepted gateway/API pair. This conclusion uses source and retained
C07 receipts, not a new live probe or a claim about a changed deployment.

Before SQL, independently compare the actual gateway digest/config and run the
genuine server-SDK workload catalog probe against the selected deployment. If
the exact binding differs or the probe fails, stop before SQL and require a
separately reviewed **gateway-only** compatibility action:

1. Hold the environment and host release locks. Keep maintenance/new work
   closed and preserve the reviewed recovery profile and durable admission
   bindings. Inventory the eight existing service identities and database
   lineages without changing them.
2. Select a scanned, source-pinned gateway artifact proven compatible with the
   existing Course runtime and old private TLS policy. Preserve the exact
   workload identity/project/target, TLS origins, allowlists and admission
   configuration. Do not run the new ten-service release stages or replace
   API/worker/TLS containers as a shortcut to a catalog read.
3. Replace only the gateway under the reviewed action. Prove genuine SDK
   workload `GET /course/v1/courses` and validate its response; prove missing
   workload, private authority and hidden operational routes still deny.
   Reconcile gateway receipt/admission acknowledgements and unchanged peer
   containers before declaring bootstrap compatibility.
4. On failure retain original receipts and the observed partial state. Keep
   admission closed and require deliberate recovery; do not automatically
   reopen admission or replay a replacement. Continue to application SQL only
   after the successful read-only bootstrap and the separate writer-fence gate.

The release coordinator owns this action if it becomes necessary. No gateway
implementation or deployed change is included here.
