# Frontend CI observation at `ab34cf9b`

[CI run 42139490765](https://github.com/princessdardan/lash-her-frontend/actions/runs/42139490765) checked source `ab34cf9bedde69cf2ddce54b717c9dc1a181c5d6`. This run does not qualify a candidate.

Quality/unit, build, audit and gateway/platform jobs passed. In particular, the gateway's strict native reference-build and backport verification passed on the explicit Ubuntu 24.04 runner. The unchanged PR #91 runtime is preserved.

All three browser jobs stopped before application scenarios: the locked Playwright 1.59.1 installer reported `Cannot install dependencies for ubuntu26.04-x64` and refused the selected browser. The locked package's platform and native dependency tables contain Ubuntu 24.04, without an Ubuntu 26.04 entry. The browser matrix is now pinned to `ubuntu-24.04`; browser coverage, dependency installation and failure propagation remain required. The ten platform workflow checks passed after this change.

The frontend migration image and owned PostgreSQL 18 image built; offline migration-image isolation passed. The operator rehearsal then failed at `frontend-bootstrap-owned-probe`, whose child reported `FRONTEND_BOOTSTRAP_PROBE_OWNED_FAILED`, phase `configuration`, without provider access. This remains under diagnosis. No successful SQL/bootstrap receipt or frontend native scan is inferred from the earlier build steps. Failed missing-artifact uploads are secondary consequences.

Independently, the exact released P2 contract CLI passed at frontend `ab34cf9bedde69cf2ddce54b717c9dc1a181c5d6`, pinned to final merged Course `3c0a0d6eee64344d97f98387755e9f34195a4c42` and Community `1ce696a7ae6073cb125da19146789693398b6cc4`, against the Git-archived released v1 baseline `a08e4659ab37cd989f7d87dab0116f87eac965ec`. This checks source/review/artifact identity; it is not deployed certification.

No provider setting, runtime credential, staging database, deployment or admission changed.
