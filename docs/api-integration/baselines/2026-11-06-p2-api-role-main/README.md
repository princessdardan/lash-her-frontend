# Merged API role qualification evidence

This baseline binds the merged `main` revisions of the Course and Community APIs to their successful GitHub Actions qualifications on 2026-11-06.

## Source and runs

| Repository | `main` source | Workflow run | Result |
| --- | --- | --- | --- |
| `princessdardan/lash-her-course-api` | `a447bfde20299e12afab68a3331b3792ddd07598` | [CI 42162176192](https://github.com/princessdardan/lash-her-course-api/actions/runs/42162176192), attempt 1 | All three jobs succeeded |
| `princessdardan/lash-her-community-api` | `939de65dd52f0b1a43993a25c7c428dce6e2bb43` | [CI 42162186353](https://github.com/princessdardan/lash-her-community-api/actions/runs/42162186353), attempt 1 | All three jobs succeeded |
| `princessdardan/lash-her-community-api` | `939de65dd52f0b1a43993a25c7c428dce6e2bb43` | [Course contract compatibility 42162186016](https://github.com/princessdardan/lash-her-community-api/actions/runs/42162186016), attempt 1 | Compatibility job succeeded |

`validation.json` records the exact run, job, and artifact identifiers and the downloaded artifact hashes. `native-runtime-summary.json` is a sanitized projection of the image-bound native-runtime artifacts. It retains image and component digests, regression results, and filtered scan counts, but no SBOM, raw scanner output, signed download URL, credential, or private source payload.

## PostgreSQL 18 qualification

The private `operator-schema-postgres18` archives were downloaded to a mode-`0600` temporary directory and matched the SHA-256 digests published by GitHub. They were inspected only to validate their result receipts and were then discarded. No archive, schema baseline, schema payload, or DDL is retained here.

The Course receipt reported PostgreSQL 18, 22 migrations, 14 named migration checks, eight role/namespace fault cases, 18 ACL-refusal cases, the reviewed three membership rows, and `providerTouched: false`. The Community receipt reported PostgreSQL 18, 11 migrations, the same 14 migration checks, eight role/namespace fault cases, 18 ACL-refusal cases, its reviewed membership row, and `providerTouched: false`.

The migration checks include verified client TLS with backend plaintext inspection, wrong-host and wrong-CA refusal, forward and data-bearing upgrades, physical lock contention, already-current handling, wrong-role refusal, current and historical contract binding, lineage and schema-drift refusal, runtime DDL/journal isolation, and production-artifact promotion behavior.

## Claim boundary

This is source-bound CI evidence from isolated GitHub-hosted qualification. It proves the listed merged commits passed the recorded PostgreSQL 18, API verification, container-boundary, native-runtime, scan, and compatibility checks. It does not prove a staging deployment, provider access, live TLS endpoints, production activation, frontend integration, or G2 acceptance.
