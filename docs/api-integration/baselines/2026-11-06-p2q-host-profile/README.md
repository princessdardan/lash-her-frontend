# Bounded host qualification-profile source package

Source `4ba7428c140d6b783c613279d6e5ed6e7318abd9`, based on `5e007c4447cb1070c8718fa16bb0ca73e0b69213`, adds explicit current-profile planning and read-only checker joins. Independent review is pending. Nothing here authorizes a release, allocation, credential delivery or isolated first use.

The host previously accepted only candidate2/API job1/FE job1. An explicit source-selected `expected_profile` now accepts candidate3/API job2+target2/FE job2 and requires their exact registered references. Fixed `--profiled-current` entries resolve current policy before carrier reads. Missing or foreign refs, stripped new versions, and mixed receipt schemas refuse. Legacy entries remain unprofiled; profile metadata is never inferred, defaulted, removed or attached to historical receipts.

The host-only `runtime.json` version2 wrapper carries the reference. Its seven keys are closed. The existing nineteen configuration filenames, gateway/private-TLS/admission schemas and raw copy behavior remain unchanged. All PR91 runtime files and the 33 historical source profiles match the base tree byte for byte.

Profiled `migrate.execute` and `release.execute` apply refuse before bundle, credential, scope, child or external access because the full coordinating graph is still legacy-only. A plan or a caller flag cannot enable it. The read-only API checker instead uses the selected image's fixed `/app/dist-migration/src/db/qualification-target-profile.js` module before reading manifest/private stdin; no caller-selected import enters production main. The matching profiled FE image/leaf and actual image execution remain integration prerequisites.

Both selected API sources emit schemaVersion2 normative database receipts. Their CLI records differ: Course keeps its existing unversioned CLI records with a ref, while Community emits schemaVersion2 with a ref. Host validation preserves this source-specific distinction. SQL artifacts, schema baselines, query text, physical target hashes, JWTs, TTLs and topology are unchanged.

Executed checks:

* 187 affected host tests, zero skips, including owned local HTTPS and POSIX guard cases. Most runtime/provider metadata is projected in those fixtures; no managed database or Docker execution occurred.
* 11 Node checker tests, zero skips, with modeled SQL and the actual reviewed profile codec. The fixed production image import is guarded in source tests; actual image/Linux execution is not claimed.
* Selected JavaScript ESLint, Python syntax compilation and diff whitespace checks passed.
* Public migration/runtime offline plan bytes were independently compared with exact base source and matched. This is not an exhaustive byte comparison of every historical receipt.

The original broad sandbox attempt is retained privately, including loopback/process-inspection denial and one real partial-selector rotation-copy regression. That regression was corrected without accepting candidate3 on a legacy path or weakening full candidate parsing. The final permitted run passed all 187 tests. Raw failure logs remain under the private evidence directory; only their hashes and sanitized disposition are in `validation.json`.

The isolated source producer selected 502 files, 40,604,631 decoded bytes and 54,212,916 public transport bytes. Limits remain 512 files / 41 MB decoded / 56 MB public / 2 MB per file / 24 MB private. This measurement does not qualify the future integrated root union.

No provider, staging, SSH, secret-store, resource, registry-publication or live action was performed. Full profiled coordinating/recovery/certification/rotation/B/C graphs and resource/provider creation-control authority remain open.
