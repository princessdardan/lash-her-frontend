# Frontend recovery PostgreSQL 18 CI evidence

**Required frontend-operator job and complete CI run passed at exact source `9480cd91b2805e2a0ab85fa2ad2f56afa2d12a8d`.** [Run 42166753948](https://github.com/princessdardan/lash-her-frontend/actions/runs/42166753948) finished SUCCESS with all ten jobs successful. [Frontend-operator job 127724912018](https://github.com/princessdardan/lash-her-frontend/actions/runs/42166753948/job/127724912018) ran on `ubuntu-24.04`; every returned job step succeeded. Initial collection saw the run in progress; the separately retained terminal snapshot confirms completion.

This is source and owned CI fixture evidence. No deployed staging action, managed-database query, provider call, registry publication, historical fence, release acceptance or G2 acceptance occurred during collection. CI-built local migration-image qualification does not establish a published immutable candidate.

## Actual receipts

Counts below come from retained artifact or complete CI-log receipts, not expected fixture totals.

| Receipt | Actual result | Retained evidence |
| --- | --- | --- |
| Exact API identity tests | 19 passed, 0 failures, 0 skipped | [CI-log receipt](identity-recovery-log-receipt.json) |
| Current-only recovery on PostgreSQL 18 | 55 checks; 39 distinct privilege faults; 0 skipped | Same actual CI-log receipt |
| Composed roles / release / lifecycle-native | 24 / 17 / 9 checks, all PostgreSQL 18, 0 skipped | [Artifact receipt](p2-platform-postgres18.json) |
| Frontend packaged migration CLI | 83 migrations; packaged CLI verified; PostgreSQL 18 | [Source-bound schema summary](frontend-schema-summary.json) |
| Initial Course logins | 13 named checks; credential values not displayed | [CI-log receipt](course-initial-login-log-receipt.json) |
| Community runtime credential handoff | 13 named checks; credential values not displayed | [CI-log receipt](community-runtime-credential-log-receipt.json) |

The recovery receipt reports 83 frontend, 22 Course and 11 Community migrations in disposable owned databases. It records no SQL replay and no recreation of the original frontend terminal receipt. It also records actual non-superuser creator membership behavior, 17 initial and 17 continuous frontend privilege refusals, 22 API privilege refusals, two legacy API verifier refusals, pinned operator search path and poisoned-parent environment isolation. These counts describe overlapping fixture classifications; they are not added together into another test total.

The recovery summary is **not** inside the schema artifact: its two members are only `frontend-schema-summary.json` and `p2-platform-postgres18.json`. The complete job log's actual JSON receipt at line 2120 is preserved separately here. [Provenance](provenance.json) binds its extracted bytes to the original full log hash and source line; no artifact receipt was fabricated. Course and Community login receipts come from lines 2132 and 2144.

## Exact sources and image

The checkout log and source-bound receipts identify the selected frontend head directly. API receipt package/lockfile hashes and Git trees were independently checked against the local exact Git objects; all three P2 normative artifacts were checked against the frontend's exact manifest bytes and selected API revisions.

| Binding | Exact value |
| --- | --- |
| Frontend | `9480cd91b2805e2a0ab85fa2ad2f56afa2d12a8d` |
| Course | `a447bfde20299e12afab68a3331b3792ddd07598` |
| Community and enrollment event | `939de65dd52f0b1a43993a25c7c428dce6e2bb43` |
| P2 manifest SHA-256 | `f953a28763dbdf7b696bb8ea98aa2b4ac41a2925223e1e220a77f5641cc36f1a` |
| Local migration image digest | `sha256:30c8d78812703cb92554c59e368cd4ea28d06862895e684f08aff5b466f56bea` |

The schema summary's P2 binding and image digest match the actual identity/recovery receipt and native verification record. Original v1 manifest identity remains separate in the schema summary.

## Preserved artifacts and native proof scope

| GitHub artifact | ID | Original ZIP SHA-256 |
| --- | --- | --- |
| `frontend-operator-schema-summary` | 13479382371 | `0baa2965406eadd2e22f6d26a56ae6625bc47895ec4ce916e6990b4a6bf05ecd` |
| `frontend-runtime-qualification` | 13479731612 | `847d3327985e3d6509e2f553f9306e84acbd16d1e933bbc01fab3bcfcadc2ed0` |

Both original ZIP hashes matched GitHub's artifact digest and exact run/source metadata. The native artifact retains raw scan, SBOM, VEX, filtered scan and `PATCHED_RUNTIME_VERIFIED` record. Their recorded hash links, exact source input lock, independent-build/observed runtime evidence and VEX statements were checked offline using the unchanged selected frontend verifier exports. The verifier and input lock are byte-identical to accepted PR91 source `0d45f462c92a3de0af700e6f246bc4c57c8617b3`. No Docker build/run or native source modification occurred during this evidence collection.

The [raw scan summary](native-scan-summary.json) has one HIGH finding, reviewed `zlib1g` CVE-2026-76844; the HIGH/CRITICAL-filtered scan has zero unresolved findings. Raw MEDIUM 36 and LOW 8 remain raw observations. The severity-filtered result does not establish that those other severities were fixed.

A separate strict `verifyRecordedRuntime` attempt refused the retained raw scan's local `lash-her-frontend-migration:ci` ArtifactName at unchanged verifier line 58; the filtered scan and proof bind the immutable local image reference. This failure and its original private stderr hash are preserved in [validation.json](validation.json). The original raw scan was never rewritten. CI's live verifier performs its documented in-memory raw-name normalization while checking the built local image; the successful CI result is factual. These retained local-build files are not claimed to be strict registry-candidate collector proof. The immutable candidate workflow supplies digest-named scans separately.

## Correction closure and limits

The [earlier failed-source record](../2026-11-06-p2-ci-fixture-corrections/README.md) remains unchanged. Source `ef90e0295f8871619b6593f892ba682459f967ba` failed its identity/recovery phase when the isolated child lost the runner's active Docker socket context. The later exact-source job now passed that previously blocked PostgreSQL 18 step with the actual 19-test and 55-check/39-fault receipt. This does not retroactively qualify the earlier run or replace its failures.

Original job/run metadata, complete log, ZIPs, extracted originals and the failed strict offline recheck remain in an operator-private mode-0700 directory with private files. The original log SHA-256 is `f88973e53f799693355c01ee06bff0c7654f4d1de917ba0def7cd93c2f2a964a`. This public directory includes source-bound summaries and closed fixture receipts only. It excludes whole logs, private child output, SQL schema definitions, credential values and temporary download references. [Evidence file hashes](evidence-manifest.json) cover the public files; GitHub's original job/artifact records remain authoritative.
