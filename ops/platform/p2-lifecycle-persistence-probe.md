# P2 lifecycle persistence qualifier

This package supplies the read-only persisted-state evidence required by staging
scenarios S14 and S15. It does not create an export, delete an account, run a
cleanup duty, replay a lifecycle command, change admission, alter native cron
state, apply SQL, or accept P2/G2.

## Fixed stages

Run the stages against one approved disposable staging account, serially:

1. `capture-export-ready`, after the supported account export is ready and both
   receiver deliveries are acknowledged.
2. `capture-delete-baseline`, after the real 24-hour expiry and the normal
   frontend, Course, and Community cleanup duties have completed. This proves
   the private export bytes are gone and captures the records that deletion must
   remove, deidentify, or retain.
3. `verify-delete`, after the supported deletion flow and both ordered receiver
   acknowledgements have completed.

Each stage acquires a fresh bounded canonical host flock. No lock or process is
held across the 24-hour interval. The three databases cannot supply one atomic
snapshot; the qualifier reads frontend lifecycle state before and after the two
API snapshots and refuses relevant drift. The certification operator must keep
mutations for this account serialized.

The package also exposes the `lifecycle-account` profile for the separately
owned S12 negative-action runner. That profile is a fresh state witness, not the
required proof that frontend/gateway admission is closed, native scheduling is
off, or the global writer ledger is drained.

## Inputs and output boundary

The offline public plan binds the exact release/candidate/configuration, all
three source commits and database targets, selected API images, deployed
frontend evidence, migration counts, and the exact operator program. It reads no
credential and performs no network operation:

```sh
node ops/platform/p2-lifecycle-persistence-probe.mjs plan /absolute/private/p2-persistence-settings.json
```

Install the exact committed operator source through the existing
`committedOperatorSource`/`installSource` handoff. The fixed current-stage host
entry is:

```text
sudo -n /usr/bin/python3 -I -u \
  /opt/lash-her/operators/<exact-frontend-commit>/ops/platform/host/p2_lifecycle_persistence_probe.py
```

Invoke it only through the existing pinned SSH transport. Its bounded stdin
packet has exactly `version`, `operation`, `bundleDirectory`,
`configurationDirectory`, `reviewed`, and `private`. `operation` is `plan` or
one of the fixed stage names. There is no URL, SQL, command, endpoint, output
path, or arbitrary query field.

The private witness contains the dedicated user UUID, original normalized email,
exact export command, exact attempt/grant/Community stream/inbox UUIDs, and, for
the final stage, the exact delete command and previous private record. The email
is required because `customer_verification_tokens.identifier` has no user
foreign key. It is checked against the actual pre-delete frontend account; the
tombstone email can never substitute for it.

The frontend runtime database URL comes from the operator-local, mode-0600 role
preparation result and is sent through SSH stdin only. It is not copied to the
host filesystem. Course and Community use their exact selected containers'
runtime database environments. Do not fetch a secret value into a shell or
agent context. If an AWS-held value must be resolved for an invocation, use
`asm-exec` with a `{{resolve:secretsmanager:...}}` dynamic reference.

The exact `p2LifecycleStateWitnessV1` is retained in a new mode-0600 private
record. Use a distinct reviewed `privateDirectory` with a pre-existing
mode-0700 parent for every stage; a stage never adopts or overwrites a prior
directory. Common stdout contains only fixed status, booleans, integer counts,
source/binding/witness hashes, and nonsecret receipt hashes. It never contains
the account/email/record UUIDs, timestamps, PII, answers, export data, provider
values, credentials, or credential hashes.

## Database boundary

The current identity probe's Linux/root host-lock, container-inventory,
source/configuration recheck, timeout, and process-group cleanup are reused by a
narrow subclass. Only the exact selected Course or Community container can run
the fixed Node child. No public or private HTTP endpoint is added.

Every database connection verifies the exact host, port, database, runtime role
and role OID, PostgreSQL major, SNI, built-in CA set, `rejectUnauthorized`, and
the authorized Node TLS stream. It pins `search_path=pg_catalog,public`, starts a
`REPEATABLE READ READ ONLY` transaction, confirms
`transaction_read_only=on`, applies a ten-second statement timeout, and rolls
back. The child accepts a fixed operation name only; every statement is a
source-defined parameterized `SELECT`.

## Assertions

The export-ready stage requires the exact frontend export command, two
acknowledged deliveries without leases or later commands, present frontend and
receiver artifacts, Course/Community expiry exactly 24 hours after readiness,
and frontend expiry equal to the minimum of its own 24-hour bound and the two
receiver expiries. Export JSON is never selected.

The post-expiry stage requires the frontend artifact to be expired with both
private byte fields null, both receiver artifacts absent, and immutable command
and acknowledgement receipts retained. A meaningful deletion baseline requires
an active account, an actual session, Google provider link, pending email proof,
preferences row, Course progress, identified attempt with nonempty answers,
grant reference, and Community projection/inbox references. These records must
come from normal owned UI/API journeys in staging; the qualifier has no seed or
write path and does not require marketing opt-in.

The deletion stage requires the exact next version and both acknowledgements.
It proves the frontend tombstone and removal of sessions, provider links,
preferences, original-email proofs, and private export bytes; Course account
tombstone, profile-email removal, progress removal, export removal and exact
attempt deidentification; and Community tombstone/export removal. It compares
only the approved immutable attempt outcomes, minimal grant references, and
Community operational identities/digests. It does not require mutable grant
status fields to remain byte-identical and never hashes answers or PII payloads.

HTTP denial, exact/conflicting replay, stale restore, delayed enrollment and
terminal access remain their owning staging scenarios. This observer reports
persisted state only.

## Owned verification and live gap

Run the disposable proof with Node 24 and PostgreSQL 16:

```sh
P2_LIFECYCLE_PERSISTENCE_OWNED_TEST=true \
PG_BIN=/absolute/postgresql16/bin \
P2_COURSE_SOURCE_ROOT=/absolute/clean/course \
P2_COMMUNITY_SOURCE_ROOT=/absolute/clean/community \
node --import tsx ops/platform/test-p2-lifecycle-persistence-local.mjs
```

It applies the actual 83/22/11 migration histories to three owned TLS/SCRAM
databases and exercises positive export/deletion observations plus wrong-email,
missing-acknowledgement, identified-attempt, retained-export and output-leak
refusals. Its fixture advances state directly inside disposable databases; it is
not a real 24-hour wait, deployed container proof, cleanup scheduling proof, or
staging certification. PostgreSQL 18 CI and all three actual current-stage runs
remain required.
