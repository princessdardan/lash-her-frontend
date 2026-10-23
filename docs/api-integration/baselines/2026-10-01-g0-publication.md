# G0 — Publication and remote CI follow-up

**Observed:** 2026-10-01, America/Toronto  
**Result:** G0 remains **BLOCKED**. Remediation and P0 baseline commits are published on review branches; no PR has merged. Both API CI workflows pass. Private cross-repository credentials and remaining frontend browser evidence are pending.  
**Evidence:** [exact revisions and job results](2026-10-01-g0-publication-evidence.json).

## Published candidates

| Repository | Candidate revision | Review | Remote CI |
| --- | --- | --- | --- |
| Community | `ac88eb9840c8ec1ad85cc414d31c6f70831d1e3f` | [PR #1](https://github.com/princessdardan/lash-her-community-api/pull/1) | [36914046328](https://github.com/princessdardan/lash-her-community-api/actions/runs/36914046328): PASS quality, audit, PostgreSQL, migration round trips, Prometheus rules/tests, API and worker containers |
| Course | `a809b1e61051d8908892830bbeb80762448c879d` | [PR #2](https://github.com/princessdardan/lash-her-course-api/pull/2) | [36914736475](https://github.com/princessdardan/lash-her-course-api/actions/runs/36914736475): PASS quality, audit, PostgreSQL, migration round trips, Prometheus rules/tests, container and process entrypoints |
| Frontend | `273a9821a097a7a0beeb918e8b1c4c51932f73ab` | [PR #48](https://github.com/princessdardan/lash-her-frontend/pull/48) | [36914136266](https://github.com/princessdardan/lash-her-frontend/actions/runs/36914136266): PASS quality, audit, build, database and critical coverage; browser job pending |

The frontend Vercel preview check also passed. This does not certify production or replace the browser suite. The API runs used isolated GitHub PostgreSQL 16 services and built containers without publishing images. No shared database migration was performed. The P0-04 Community commit remains in the review branch history; the rebase onto unchanged remote main preserved it.

## Failures discovered and fixed

The first Course publication run [36914127495](https://github.com/princessdardan/lash-her-course-api/actions/runs/36914127495) reproduced failures that passed in the developer checkout:

- **OpenAPI generation:** app imports validated deployment configuration before the generator could operate with inert adapters. The generator now sets test mode before dynamically importing the app. A subprocess regression runs with no deployment variables and an empty dotenv file. It failed before the fix and passed afterward; production runtime validation is unchanged.
- **Publisher-lock test:** its observer held a transaction open and cached `pg_stat_activity` before the competing claim became visible. The test now clears the statistics snapshot before each poll. Priming that snapshot deliberately makes the regression deterministic. It still requires observing a real lock wait and an empty claim after the paused state commits. See [PostgreSQL statistics snapshot behavior](https://www.postgresql.org/docs/16/monitoring-stats.html#MONITORING-STATS-VIEWING).

Course full local verification passed 366 unit tests plus all 17 disposable database tests after the fixes. The same candidate subsequently passed all three remote CI jobs. These fixes change generation/test tooling, not application behavior or migration history.

## Private cross-repository checkout blocker

Both API repositories are private. The default workflow token cannot read the sibling repository, and no repository secrets were configured at inspection. Community's first compatibility run [36913808345](https://github.com/princessdardan/lash-her-community-api/actions/runs/36913808345) failed at the external checkout. The compatibility workflows and Course release gate now explicitly use `secrets.CROSS_REPO_READ_TOKEN` for that checkout with `persist-credentials: false`; missing credentials fail closed.

**Required owner action (Dardan):** configure `CROSS_REPO_READ_TOKEN` in both API repositories using a fine-grained token restricted to the two API repositories with **Contents: read-only** permission (metadata read is implicit). Keep the token out of chat and documentation. An existing suitably scoped GitHub App credential is also acceptable with a corresponding workflow update. The request is pending in this chat; no broad personal CLI token was copied into Actions.

Once access is configured, verify candidate compatibility, publish Community preserving `97361f173f6a42de238f374317b8f49f79e48876`, then publish dependent Course and run the default published-history release gate without a local reference override. Normal compatibility checks against the older released counterpart can expose the coordinated baseline difference before this sequence completes; they must be green against the final published revisions before G0 closes. No failed check has been waived and no merge has occurred.

## Gate status

The dependency audit blocker is resolved at the existing moderate threshold, with the documented low Quill finding still visible. Independent API CI evidence is now established for the candidate SHAs above. Frontend browser evidence, cross-repository access/checks, reviewed merges, and the approved starting revision record remain outstanding. G0 and D-06 stay open. Branch protection and protected deployment/migration controls retain their downstream P1 owners and gates; this follow-up does not grant production migration approval.
