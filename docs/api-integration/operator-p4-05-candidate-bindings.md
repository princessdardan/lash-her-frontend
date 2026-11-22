# P4-05 deployment-level provider bindings

`ops/platform/host/p4_05_candidate.py` prepares an isolated frontend build in
the dedicated business-staging Vercel project's Production target. The build
uses the exact reviewed Git source and requests no domain assignment. The
operator supplies bindings for this deployment in the creation request. The
existing project variables, schedules, and admission policy stay under their
separate release controls.

## Review inputs

- Use a qualified release bundle and the frontend migration job's
  `job-outcome.json` for the isolated database. The receipt must verify the
  exact source and lineage in read-only mode with zero pending migrations.
- Use an isolated candidate commit whose `ops/staging/first-release.json`
  names the reviewed frontend runtime database host, database and role,
  isolated Redis host, and Square Sandbox location. The build's existing
  staging validator checks these pins. Keep the shared staging manifest and
  project settings in place.
- Reserve a candidate-only HTTPS Square notification URL before staging
  the build. If the deployment requires protection or only receives its
  unique hostname after creation, use an isolated ingress whose downstream
  destination can be pinned to the new deployment. Keep the raw body and
  signature unchanged. Square and the application must use the same
  registered notification URL. [Square webhook verification](https://developer.squareup.com/docs/webhooks/step3validate)

The operator's reviewed JSON has the following shape. These are illustrative
pins and tax values for local verification.

```json
{
  "projectId": "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM",
  "sourceCommit": "<reviewed frontend commit>",
  "releaseId": "<reviewed release ID>",
  "database": {
    "runtimeHost": "p4-test-pool.example.net",
    "verificationHost": "p4-test.example.net",
    "name": "candidate_db",
    "runtimeRole": "candidate_role"
  },
  "redisOrigin": "https://candidate-redis.example.net",
  "gatewayOrigin": "https://candidate-gateway.example.net",
  "square": {
    "applicationId": "<Sandbox application ID>",
    "locationId": "<CAD Sandbox location ID>",
    "notificationUrl": "https://candidate-hooks.example.net/api/webhooks/square"
  },
  "courseClassification": "paid-fixture",
  "courseSalesPolicy": {
    "version": "synthetic-p4-05",
    "markets": [
      {
        "country": "CA",
        "region": "ON",
        "behavior": "exclusive",
        "disclosure": "Synthetic tax fixture.",
        "classifications": {
          "paid-fixture": { "taxCode": "ca-on-hst", "rateBasisPoints": 1300 }
        }
      }
    ]
  }
}
```

The rate is a test-only Ontario value for a single synthetic classification.
The candidate accepts one Canadian market and classification. Rates are
integer basis points. The rate table requires `SQUARE_ENVIRONMENT=sandbox`.
A zero rate requires an explicit `zeroReason` of
`product_exempt`, `zero_rated`, or `reduced_rated`. Checkout records the
policy version, selected rate and tax on the quote. Square captures the CAD
total and verifies refunds. The purchase ledger records each refund's tax
reversal against the original quote.

Review the plan before acquiring credentials. Run the entry point from the
operator checkout with the existing shared staging manifest. The default
invocation reads the bundle and receipt locally, rejects the known shared
staging database and Redis hosts, and returns only the target and binding
names.

```sh
python3 ops/platform/host/p4_05_candidate.py \
  /path/to/reviewed-bundle /path/to/candidate-bindings.json /path/to/job-outcome.json
```

## Private deployment inputs

The apply mode consumes only these private variables for the corresponding
deployment bindings. Supply them through the protected operator environment
or resolve AWS-held values at runtime with `asm-exec`. Keep values out of
shell arguments, the review plan, logs and retained receipts.

| Operator environment | Candidate environment |
| --- | --- |
| `P4_05_DATABASE_URL` | `DATABASE_URL` |
| `P4_05_KV_REST_API_TOKEN` | `KV_REST_API_TOKEN` |
| `P4_05_INTERNAL_SERVICE_JWT_SECRET` | `INTERNAL_SERVICE_JWT_SECRET` |
| `P4_05_SQUARE_ACCESS_TOKEN` | `SQUARE_ACCESS_TOKEN` |
| `P4_05_SQUARE_WEBHOOK_SIGNATURE_KEY` | `SQUARE_WEBHOOK_SIGNATURE_KEY` |
| `P4_05_COURSE_PURCHASE_RECOVERY_SECRET` | `COURSE_PURCHASE_RECOVERY_SECRET` |

The operator's existing `VERCEL_TOKEN` authorizes the deployment request.
Use the reviewed operator host and an empty private attempt directory. The
build operation checks that schedules are already paused and refuses to
change them. It sends the bindings as deployment runtime and build
environment variables in one creation request. The service JWT and runner
bearer are included only in the runtime bindings. Checkout, recovery, writer
admission and scheduler registration stay disabled on the new deployment.
The receipts retain names and IDs; the normal promotion path refuses this
candidate. [Vercel build and runtime environment flags](https://vercel.com/docs/cli/deploy#build-env)

### P4-07 Lightsail relay runtime handoff

After reviewing a frontend revision with the relay transport, supply
`P407_POSTGRES_RELAY_URL=wss://api-p407.lashher.com/internal/p4-07/postgres`
and `P407_POSTGRES_RELAY_DEPLOYMENT_PROOF` only in that held, unaliased
deployment's runtime bindings. Resolve the proof from the protected operator
store and include neither binding in build environment variables or project
defaults. Keep `DATABASE_URL` pinned to the isolated Frontend runtime role at
`p4-07-db.lashher.com:5432` with `sslmode=verify-full`. The separate operator
migration connection continues to use its reviewed private SSH path.

With release-probe authentication and a fresh challenge, use
`x-lash-release-mode: p407-postgres-relay` on
`GET /api/internal/release-probe`. Confirm
`FRONTEND_P407_POSTGRES_RELAY_PROBE_PASS` for the exact candidate source.
The probe checks the held feature controls and opens a PostgreSQL read-only
transaction that verifies the runtime identity, TLS and the relay's fixed
database-side address.

After an explicit approval for the hosted build, start it with the same
arguments plus `--attempt /path/to/private-attempt --apply --confirm
staging/<reviewed-release-id>`. A lost acknowledgement requires inspecting
the attempt and provider inventory before another create.

The loopback TLS fixture verifies the outgoing request, secret redaction,
and the unchanged production target and schedule inventory. The hosted
Git-source build must still demonstrate that Vercel applies the override
and that the resulting deployment is unaliased with its hold profile
effective before provider-backed qualification.
