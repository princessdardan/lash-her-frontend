# P2Q first-install observations

These collectors observe a currently empty frontend database and the held host process/flock/current Docker inventory. They do not authorize first use, role preparation, migration, deployment, provider access or admission. Full first-install composition remains OPEN. No allocated isolated profile or authentic allocation/control/credential-custody authority factory exists.

## Interfaces and selection

`ops/platform/p2q-first-install.mjs` exports:

- `prepareP2qFirstInstallObservation(request)`: resolves only the fixed `qualification-target-profile.mjs` source module, requires identical references on candidate v3/job v2, rejects the current policy and unsupported requests. There is no alternate registry path or `fresh` selector.
- `withP2qFirstInstallDatabaseObservation(request, {client, verifySession}, task)`: attaches to the already held, actual TLS FE physical connection. The source parent must perform profile/target selection before acquiring that connection.
- `readP2qFirstInstallDatabaseObservation(handle)`: rereads the live scoped observation; copied/expired handles refuse. A handle is observation-only, not a release capability.

The request has exactly `qualificationTargetProfile`, `candidate`, `job` and `actionId`. The low-level collector observes the job target; it does not establish the future allocated profile's resource-selector relationship. `targetSelectionVerified:false` remains explicit. The future source parent/allocation factory must join registered selectors, original allocation/control/configuration/custody records, source/candidate hashes, actual target and physical scope. A source-resolved profile alone is insufficient.

The fixed registry/helper is not present in the package's `c89b` base. Current/unregistered public calls refuse before collector I/O; the resolved-current policy is additionally tested using an explicitly private interface fixture. Actual registered-consumer integration remains unqualified until root supplies the reviewed registry/helper. The package does not register an isolated profile or invent its selector schema.

## Database facts and continuity

The collector checks actual verified TLS, host/port/database/session user, role/database OIDs, backend PID/start, the existing FE migration advisory lock and a newly generated private nonce lock. It uses qualified PostgreSQL catalog queries and a read-only repeatable-read snapshot. Extra client sessions or non-system schemas, relations, functions, types, additional extensions, foreign servers/user mappings, publications/subscriptions or large objects refuse an empty observation. Safe role attributes are hashed for drift; passwords and role setting values are never read. This is not a runtime-role least-privilege qualification.

It verifies the physical/parent scope before and after reads and callback work, detects role/catalog/session/lock drift and connection loss, expires its handle, and releases only its own nonce. The parent's global lock/client remain parent-owned. Failed nonce cleanup or lost physical state cannot return a successful observation. No application DDL, journal/admission installation or role SQL is implemented here. API empty-target proofs must come from the two API owners' existing primitives; FE-shaped observations are not relabeled as API proof.

## Host facts and continuity

`ops/platform/host/p2q_first_install.py` provides `HostObservation` and an observation-only `observe`/`check`/`close` pipe. Policy is checked before opening its fixed host flock or starting Docker. It observes the actual machine ID, process PID, lock inode/device, daemon identity and complete current container ID list; an existing container, changed lock/machine/daemon/metadata or prior gateway lineage refuses. Parent pipe closure/exit releases the actual descriptor.

Retained-root inventory is metadata only. It never reads or hashes configuration/credential file contents and cannot prove immutable configuration or original custody. Empty current Docker inventory or absent lineage never becomes historical zero/first-use evidence. Supported creation/control/surface/configuration/provider-before-use factories and root's new dispatch/coordinator integration are separate prerequisites. No shared Broker/Supervisor/release/migration/profile/workflow file changed.

## Owned qualification and limits

The fixed command is:

```sh
P2Q_FIRST_INSTALL_OWNED_TEST=true PG_BIN=/absolute/owned/pg18/bin node --import tsx ops/platform/test-p2q-first-install-local.mjs
```

The source-only fixture creates a disposable PG18 TLS/SCRAM cluster, holds actual FE physical/global/nonce locks and an actual Python flock process. Its nine checks cover empty observations/handle lifetime, contention, foreign table/journal/schema/function refusal and repair, extra sessions, global role drift, lock loss, unverified TLS, actual backend death and actual host guard death. It executes no migrations, role preparation or admission installation. The 83 approved FE tags are read only as source metadata.

The fixture copies the collector under a private owned test root with a private interface resolver and projected Docker command metadata. That resolver is not registered, is not accepted by the production module and does not mint authority. The source root/current-only public path remains unavailable. Actual Docker/provider/SSH/root installation, the real registered isolated target, provider/control/custody/history proof and a complete first install are unqualified.

[The evidence manifest](baselines/2026-11-06-p2q-first-install-observations/validation.json) pins source `401a7ef1`, actual PG18 receipt, four Node tests, seven real POSIX host tests and lint. Original fixture setup refusal is retained as a hash-bound private-source reference, not restamped as success. These results complete only the bounded observation collector package.
