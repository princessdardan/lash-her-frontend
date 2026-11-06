# S12 deployed receiver-negative action

This staging-only action tests the existing canonical lifecycle command against
both deployed receivers. It preserves the selected account/domain state. Receiver
authentication and rate-limit hooks may write quota rows; those tables are
explicitly outside the persistence witness. It creates no account, command,
delivery or learning fixture, applies no SQL, and changes no admission or native
schedule setting. Dardan starts an actual action under the existing single-operator
release policy. Plan generation does not authorize a live action.

## Fixed cases and prerequisites

The only implemented live profile is `suspended-head-negatives-v1`. The source-owned
persistence reader reconstructs an actual frontend suspend command at version N.
Frontend and both receiver heads must be N/suspended, each immutable receiver
command digest must match the original, both frontend deliveries must be
acknowledged without a lease, and later-command/pending/delivering counts must be
zero. The caller supplies only the private subject and selected command IDs/version;
it cannot supply a body, action, URL, SQL, token or command override.

| Case, against each receiver | Derived request | Required result |
| --- | --- | --- |
| Exact replay | Original canonical command and idempotency header | 200, exact original ID/version, `duplicate` |
| Changed replay | Same original ID/version/time/subject, fixed action `restore` | 409 idempotency conflict |
| Stale restore | Fresh source-generated ID, original version N, fixed action `restore` | 409 version conflict |
| Future gap | No live request | OPEN: current quiescence is not positively proved |

Course has uppercase conflict codes and a closed `{error:{code,message}}` envelope;
Community has lowercase codes and additionally requires `requestId`. Both must
return private/no-store. A 401, 429, redirect, malformed reply, unavailable service,
or unexpectedly accepted command fails the action. No automatic retry or repair
occurs. The deleted-account restore boundary is exercised by the owned fixture;
this live profile does not claim deployed deletion/restoration certification.

Both pinned receivers lock command ID and subject, decide known replay/digest
conflict, terminal deletion and monotonic version conflict before domain effects.
Consequently exact/changed/stale requests cannot advance the selected account.
The generated stale ID is checked absent from all three selected-subject command
arrays before and after. An astronomically unlikely collision with another
subject's immutable command fails safely with the wrong conflict code.

The live future-gap request is refused by both the private Node entry and host
scope. A host flock alone does not establish its safety. Enabling it requires a
separate source change with actual current frontend and gateway new-work/recovery
admission closed, native scheduling off, global active/uncertain zero, no selected
pending/in-flight deliveries, and stable N/both ACKs under the actual lease. No
caller boolean or historical receipt substitutes for these facts.

## Source and transport

`certify-p2-lifecycle-receivers.mjs` defaults to a public plan:

```sh
node ops/platform/certify-p2-lifecycle-receivers.mjs SETTINGS_JSON
```

The settings object is closed: `version:1`, `environment:'staging'`, `knownHosts`,
`sshKey`, `bundleDirectory`, `configurationDirectory`, and `reviewed`. `reviewed`
contains `version`, `environment`, fixed `profile`, `actionId`, the exact reviewed
persistence package settings, the assembled receiver `programSha256`, complete
`operatorSourceFiles` map, and a new private output directory. The persistence
plan supplies the candidate/configuration/source/three-target bindings, all ten
current container IDs/images/health states, migration counts, and original
release/frontend references. These references do not constitute new frontend SQL
or release-acceptance evidence.

Prepare the source maps from the final committed, reviewed operator tree using
`p2_lifecycle_persistence_probe.operator_hashes(source)`, its `private_program`
hash, `p2_identity_negative_probe.source_closure(source)`, and
`p2_lifecycle_receiver_negative.private_program(source)` hash. Existing pinned SSH
source installation must install exactly that tree at
`/opt/lash-her/operators/<reviewed frontend source commit>`. This action installs
no source and changes no source-transport caps.

Execution requires explicit `--execute staging/<actionId>`. Its private stdin is
exactly:

```json
{
  "frontendRuntimeDatabaseUrl": "<resolved privately at runtime>",
  "witness": {
    "version": 1,
    "environment": "staging",
    "stage": "lifecycle-account",
    "userId": "<existing private UUID>",
    "selectedCommand": { "commandId": "<existing private UUID>", "accountVersion": 1 }
  }
}
```

Resolve an existing private handoff at runtime; never paste its URL/password into
shell arguments, tracked settings, chat or logs. SSH uses the existing fixed host,
pinned known-host file and operator-owned key. The remote command is the fixed
installed `host/p2_lifecycle_receiver_negative.py` entry, never a caller command.

The host owns `/run/lock/lash-her-release.lock` continuously across each actual
SELECT witness, one POST, and fresh SELECT readback. It checks candidate/config,
complete installed source, actual machine, local Linux/amd64 Docker engine, exact
ten-container inventory, and read-only gateway/API mounts. Dedicated lifecycle
keys are read only from private runtime files and matched to the actual API
container environment. Private one-request children run in the exact gateway
container over fixed verified-TLS `course-tls:8443`/`community-tls:8443`, fixed
`/v1/internal/accounts/commands`, no redirects and bounded input/output/time.
Tokens use only the separate six-claim lifecycle service profile, expire after
120 seconds, and pass only through stdin/memory. This tests service authentication;
it does not establish frontend workload OIDC or Google authentication.

Before each POST an exclusive mode-0600 intent retains the actual witness and
case ID. The reader brackets the two receiver reads with an unchanged frontend
read. After each POST all three complete private witness objects must remain
identical, including commands, deliveries, domain counts and digests. Raw
observations/credentials are not retained. Private witnesses/HTTP receipts remain
under a new mode-0700 output directory; common output contains only fixed names,
statuses, counts, booleans and hashes. Any failure preserves prior files and stops.

The common terminal is `P2_STAGING_LIFECYCLE_RECEIVER_NEGATIVES_PARTIAL`: six cases
can pass while both live gap cases remain OPEN. `releaseAccepted`,
`frontendSqlVerified` and `oidcVerified` remain false. This does not complete S12,
P2-11, P2-12 or G2 by itself.

## Owned verification

```sh
node --test ops/platform/p2-lifecycle-receiver-negatives.test.mjs
python3 -I -B -c 'import sys,unittest;sys.path.insert(0,"ops/platform/host");import p2_lifecycle_receiver_negative_test as m;unittest.main(module=m)'
P2_LIFECYCLE_RECEIVER_OWNED_TEST=true PG_BIN=/absolute/postgresql16/bin node ops/platform/test-p2-lifecycle-receivers-local.mjs
```

The owned runner creates/deletes its own loopback TLS/SCRAM PostgreSQL 16 cluster,
applies 83/22/11 source migrations, and runs the actual pinned Course/Community
route/auth/repository modules behind local verified HTTPS. It proves positive
acceptance, exact/changed/stale/gap decisions and unchanged three-domain witnesses,
durable quota writes, unauthorized rejection and terminal deletion/replay. Its gap
test is an exclusive owned domain-decision test. It does not prove deployed native
quiescence, Linux/Docker/SSH execution, an immutable deployed image, provider
behavior, delivery-lease expiry or frontend worker restart. Those remain separate
certification evidence.
