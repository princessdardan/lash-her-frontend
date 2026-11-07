# S05 dormant host component

Source preparation only. Production ARM and sender activation are unavailable.
S05 live certification remains OPEN.

The source scope is two new files at source commit
`8e323605831f2a479c8778bc2a61b1e5da78c882`, following
`2ff5daac7756ac65a38dbc49a324d4568b9f867e`, on base
`ff4c0a340b578e0d2c4df1c2c942209227a9f24c`:

- `ops/platform/host/p2q_mux_capture.py`: 38,483 bytes.
- `ops/platform/host/p2q_mux_capture_test.py`: 31,959 bytes.

The total is 70,442 bytes, within the root-approved rebalanced 100 KiB host
limit (initially 104 KiB). Node 36 KiB plus host 100 KiB plus gateway 56 KiB
retains the same 192 KiB combined limit. No existing
parent, supervisor, scope, observer, Compose, source-closure, API, app, or
PR91 runtime file changed. Nothing was pushed.
Independent component review and integration remain separate gates.

## Fixed interfaces and limits

The public `P2QMuxCaptureStage` constructor and all ten operations always raise
`P2Q_MUX_SOURCE_AUTHORITY_UNAVAILABLE` before inspecting arguments or doing I/O.
This also holds for manually allocated instances, JSON assertions, callbacks,
and modified availability constants. No issuer or positive authority factory
exists.

Private helpers provide data processing only:

| Helper | Scope |
| --- | --- |
| `_encode`, `_decode`, `_validate` | Closed canonical metadata codecs; exact UTF-8 compact ASCII-key-sorted JSON plus LF; syntax-only profile references. |
| `_envelope`, `_decode_envelope`, `_join_raw_event` | Byte-preserving private envelope and raw-field consistency. No Mux signature authentication. |
| `_safe_capture` | Whitelisted common projection; excludes the private envelope hash and byte count. |
| `_inspect_capture` | Actual descriptor-relative fixed-file reads, ownership/mode checks, inode/readback checks, bounded reads, and current fsync observations. No path, URL, query, client, or verifier callback input. |
| `_ReplayBurnModel` | In-process one-use model with two separate replay metadata slots, fixed R1 order, response-ID/data joins, and unknown-on-loss. No durable start ACK or HTTP sender. |
| `_format_private_intent` | Private bytes only; preserves the original signature timestamp and envelope digest. No publication, signing, or POST. |
| `_assess_send_budget` | Supplied wall/elapsed observations checked against 120 seconds, the original header's 300 seconds, and 15 seconds remaining. No held clock/session authority. |
| `_assess_window` | Ledger/cumulative-counter coverage consistency only. Actual gateway/FE drain and provider queue qualification remain false. |
| `_reduce_media_projection` | Source-shaped D1/R1/A1 row projections only. No SQL connection, provider read, ordinary-UI lineage, or playback qualification. |
| `_safe_stage_size` | Safe-record and 196,608-byte aggregate limits applied together. No private records accepted. |

The schema is the root-approved corrected joint data contract
`c2c44f3895117af792b56bc0cd838e2a4f158f4e59a14d2be791b6f7349e1c8a`,
manifest `2bc1ac2ffb51f71e262d0097b6d0be1f297473aae19b3d5c0b048b6044e8242f`.
The original `3458d245...` schema remains retained by the joint-interface owner.
The correction excludes the all-zero profile-reference digest; ordinary data
hash grammar is unchanged. Validating a reference never resolves or registers
a target. Current and unregistered targets cannot activate this component.

The proposal manifest is
`58aa846dd76f3a457d69a12bdd3e6c9a4b0473033c4bb35f312547015483200c`.
The copied joint contract is data, not an authority document.

## Executed verification

Python 3.14.3 on macOS: 23 unittest groups PASS, zero skipped. Syntax compilation
also passed. The test log is retained without raw capture material.

```text
python3 -m unittest -v ops/platform/host/p2q_mux_capture_test.py
python3 -m py_compile ops/platform/host/p2q_mux_capture.py ops/platform/host/p2q_mux_capture_test.py
```

The cases cover pre-I/O public refusal, invalid Python object hooks, exact
canonical bytes, duplicate decoded keys, numeric/boolean rejection, nonzero
profile syntax, fixed selectors/case counts, nanosecond ordering/calendar
validation, envelope caps and raw-byte preservation, private/common separation,
fixed replay order and concurrent burn, collision/lost-response refusal,
unchanged signature expiry, ledger uncertainty/overflow, exact aggregate byte
limit and one-byte overflow, source-shaped row projections, and actual owned
descriptor/fsync/symlink/FIFO/readback-loss cases.

The filesystem tests project root/65532 UID/GID onto the actual owned macOS
UID/GID. They exercise real descriptors and fsync but do not qualify Linux
ownership, the fixed runtime mount, an outer root-owned parent, or a historical
producer fsync ACK. Logical private-buffer clearing is not a physical erasure
claim.

Node 24.18.0/Python canonical-byte and SHA-256 parity passed for 28 synthetic
vectors spanning all seven safe record kinds. The exact Node source revision
and source hash are in `qualification.json`. These vectors contain no private
envelope hash, signature, body, or real resource evidence. The joint contract's
15 closed key sets, ten operations, and three fixed case maps also match.
The final parity run used the corrected Node source
`83fcfcef9da54acdf0b6626c708fe6c2a629a3c7`, after its enumerable-data,
budget-binding, and registry-import corrections. The host imports stdlib only.

The initial 20-test run had one failed test assertion: 256 valid safe-capture
rows did not exceed the aggregate byte limit. The test data was corrected and
an exact-limit/+1 regression added. The original tool-result observation is
retained as an observation record, not mislabeled as a raw stdout log. No
production limit was relaxed to address it.

## Remaining boundaries

There were zero database sessions, network listeners, HTTP posts, provider
calls, credential reads, allocations, or live actions. No actual Course
read-only reducer or sender adapter was constructed. The row checks deliberately
exclude permitted scheduling fields, timestamps, and raw payloads; they do not
assert all-row immutability, exactly-once processing, or an event-inbox table.

An active source authority factory, registered allocated target, original
creation/control/provider-before-use proof, actual physical observer, private
sender, fixed mount/override, parent composition, and deployed/provider
certification remain prerequisites. Correct codecs, existing files, current
fsync, model counters, or caller JSON cannot supply these authorities.

`validation.json` hashes the portable evidence and both source files. Its own
digest is reported separately to avoid a self-reference.
