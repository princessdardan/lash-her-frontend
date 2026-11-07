# Exact API main qualification

Course main `3c0a0d6eee64344d97f98387755e9f34195a4c42` and Community main `1ce696a7ae6073cb125da19146789693398b6cc4` are normal PR merge commits with passing required post-merge CI. [The original source-bound record](validation.json) retains exact tree equality, unchanged application/contract/migration/dependency bytes, test counts, artifact IDs and hashes.

- Course [CI 42134134628](https://github.com/princessdardan/lash-her-course-api/actions/runs/42134134628): 697 unit tests, 87 PostgreSQL tests, 22 down/up round trips, packaged PostgreSQL 18 and native runtime/migration qualification.
- Community [CI 42134273891](https://github.com/princessdardan/lash-her-community-api/actions/runs/42134273891): 364 unit tests, 31 PostgreSQL tests, migration rehearsal, packaged PostgreSQL 18 and all native API/worker/migration gates. [Course compatibility](https://github.com/princessdardan/lash-her-community-api/actions/runs/42134273771) also passes.

The native jobs explicitly use the accepted Ubuntu 24.04 baseline. Ubuntu 26.04 failed references and diagnostic source are retained; its SIGABRT control returned EACCES and the expected negative reproducer was rejected. The precise kernel/security-profile cause is not established. No negative-control predicate, capabilities, sandbox protection, patched behavior, installed-library comparison or HIGH/CRITICAL enforcement was relaxed. Frontend PR #91 native implementation remains unchanged.

The two native proof archives are retained here with exact [ZIP identities](artifact-archives.json). PostgreSQL 18 summaries omit private schema definitions. Original schema archives and full container logs remain in ignored owner storage under `.tmp/phase2-api-main-20261105`; original artifact ZIP hashes match GitHub metadata. These are CI-built image and source checks, not registry publication, deployed runtime/provider certification or G2 acceptance.
