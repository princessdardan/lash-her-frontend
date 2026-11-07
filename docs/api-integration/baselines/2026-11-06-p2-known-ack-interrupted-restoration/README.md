# C interrupted-restoration qualification

The frozen production source is `d5ee9bee1d3ef6ba23774bb41883eb3c8fb605c7`; the two approved shared seams are the separate `aff6ef68c4871816f0215fca82462bd5bd595548` commit. The exact helper SHA is `a0801a1ea55cba4a9d792f7804bf73b7a954bcfff0c9288dc17f473f61e42c90`. See [the runbook](../../p2-known-ack-interrupted-restoration.md) and [retained-record audit](retained-record-audit.md).

| Evidence | Result | Scope |
| --- | --- | --- |
| `pg18-positive.json` | PASS, 146.0 s | Final frozen source; actual new process/FE backend/flock/three databases, 83/22/11 migrations, fresh single-use authority, five fixed stages, unchanged journals, fenced terminal. |
| `pg18-seven-negatives.json` | PASS, 173.7 s total | Exact same `run-owned.mjs --negative-cases` entry; seven named cases below. Per-case elapsed values are cumulative checkpoints. |
| `pg16-source-context-positive.json` | PASS, 139.4 s | Source `51d0385c`, genuine original pre-ACK formatter/config/current-ready/fault lease records. The final two-predicate-only narrowing is recorded in `pg16-applicability.patch`; this is applicability evidence, not an exact-final-source PG16 rerun. |
| `host-tests.log` / `host-and-shared-tests.log` | 24 / 39 PASS | C retained-context, isolated actual main identity, single-use/guard/child/reaping/FD regressions; approved dispatcher and ordinary scope regressions included in the latter. |
| `node-tests.log` | 5 PASS | New action/receipt structure, actual flock subprocess, ordering/death, no serialized authority. |
| `owned-entry-guards.json` | 2 PASS | Unknown argument and negative-entry ownership refusal before PostgreSQL work, with a forbidden PG sentinel path. |
| `lint.log` | Exit 0 | The four owned JavaScript entry/test/driver files. |

The seven actual PG18 cases are `original-bytes`, `original-config-drift`, `missing-lineage`, `pending-lineage`, `backend-effect`, `active-backend-loss`, and `active-guard-loss`. The first five execute no restore stage. Configuration drift keeps a valid original chain, changes a valid fresh input map and models a missing API frontier; it refuses the original-configuration join. The unrelated backend effect is an actual Course lifecycle row. Active cases each perform exactly one projected stage before terminating the actual FE backend or actual POSIX guard-writer process. They retain no B/C terminal, preserve old uncertainty one and all three journals, stop the projected runtime, disable projected native scheduling and clean both fixed readonly namespaces.

## Reproduction

Use Node 24.18, the exact API mains named in `validation.json`, the root dependencies and the gateway's separately installed locked `jose` 6.2.3 dependency. The resolver must land under `ops/gateway/node_modules/jose`, never the root fallback. Set `PG_BIN` to an owned PostgreSQL 16 or 18 installation, `OWNED_POSTGRES_MAJOR` to its major, `P2_INTERRUPTED_OWNED_TEST=true`, and the two source-root variables below to clean exact-source API checkouts. No credentials are accepted from the ambient environment. Generated credentials remain private child inputs.

```sh
node --import tsx docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/run-owned.mjs
node --import tsx docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/run-owned.mjs --negative-cases
```

Required source-root variables are `P2_KNOWN_ACK_COURSE_SOURCE_ROOT` and `P2_KNOWN_ACK_COMMUNITY_SOURCE_ROOT`. `validation.json` records the actual closed environments and commands. Only the literal negative flag is accepted. The source deadline is 900 seconds and the fixture bounds its child to 900 seconds and outer process to 1200 seconds; production deadlines were not relaxed.

## Evidence boundaries and original failures

The fixture uses actual TLS PostgreSQL, application cron/admission/dispatcher, canonical HTTP receivers, TLS gateway ACK-loss/replay, specific FE settlement and source current/role/journal read programs. Runtime/container/Docker operations, native provider metadata, Linux-root installation and system layout are projected. The owned Node call passes a no-op committed-source callback; the production entry invokes `committedOperatorSource`, while the owned Python broker continuously verifies its installed source closure and reader. This fixture does not prove CI/SSH/root installation, live Vercel/native behavior, frontend workload freshness, staging readiness or traffic authorization.

`pre-review-*`, `pre-context-*`, `source-269-six-case/`, original review reproductions and setup/refusal logs remain unchanged. Earlier positive receipts precede the final context/configuration joins and cannot qualify the corrected source. Loader reproductions demonstrate omitted predicates, not a demonstrated whole-runtime or whole-barrier bypass. The invalid optional receiver-loader case was already checked by the fresh reader before authority; the later early check is not an authority-bypass fix.

The final positive independently retains all six original causal raw-file hashes before C and checks them after C, then joins the terminal exactly. Outer `domainProofSha256` remains the canonical-domain digest, not a settlement-file digest. The original B terminal remains absent. No provider/cloud/staging action was performed. Independent reviewers retain their own reports; this implementation-authored manifest does not confer review clearance.
