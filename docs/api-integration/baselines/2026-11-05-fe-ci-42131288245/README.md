# Frontend CI 42131288245: retained qualification failures

Run `42131288245`, attempt 1, checked out exact frontend `d3cf6f9952c5ca3bac740b1d75432f1c145d3e65`. The two affected jobs failed. Their logs, step states and artifact metadata are retained without rerunning the workflow.

## Frontend operator migrations

Job `127608254078` successfully built migration image `sha256:28359c5dae3896a16e0991d56689a7ec5fda8acc249f7eda1c0e3c949ddff2d6`, passed the offline image-boundary checks, and built the owned PostgreSQL 18 fixture. The operator rehearsal then failed in `frontend-bootstrap-owned-probe`, whose sanitized child result reported `configuration`. Subsequent scan steps were skipped; the qualification upload's missing-files failure was secondary.

The source fixture mounted only `v1/manifest.json`. The actual protected route eagerly imports `gateway-smoke` and `response-validation.ts`, which imports `v1/course-api.json` and `v1/community-api.json`. A small import-only probe using the exact revision reproduced `Cannot find module '../../../contracts/api-integration/v1/course-api.json'`; supplying those unchanged JSON files made the same import succeed. This probe made no database or provider calls. The child catch did not log its underlying exception, so the import probe identifies a concrete closure defect rather than claiming access to the hidden original exception.

The candidate rehearsal also retained older partial source mounts. The approved correction makes its read-only source inputs match the current parent fixture: full `src`, `scripts`, package and TypeScript configuration, and both contract directories. The minimal SQL image payload is unchanged.

## Gateway and platform

Job `127608254623` passed JavaScript and Python tests, host namespace/offline checks, gateway audit, image build, read-only/nonroot checks and the raw scan. The independent native reference build then rejected the negative control. Its stderr contains the expected `failed-write-before` assertion at `failed-write.c:42`; the exact return code was not printed in this frontend job. The verifier returned `PATCHED_RUNTIME_VERIFICATION_FAILED`. Qualification remains failed.

Artifact `13462594878`, `gateway-runtime-qualification`, was downloaded and its ZIP digest verified as `sha256:2898d0d8801c41e65a0c3ceb6309f27615a30440853ca054596977bb38bdb731`. It contains only `gateway-runtime-raw.json`. There is no successful verification record, runtime SBOM or VEX document in that artifact.

Both jobs used Ubuntu 26.04.1, runner image `ubuntu-26.04` version `20261101.186.1`. Related Community diagnostics observed denied self-signaling in the plain Docker reference context; the precise kernel or sandbox cause remains unproven. The approved workflow correction restores the explicit Ubuntu 24.04 native qualification baseline. It does not change the reproducer, exact signal/assertion predicate, runtime capabilities, security options or native source.

## Correction and scope

Commit `afdf0b64c2c125eb08f18fa627bdb1e8348fbbc5` pins the two native CI jobs and artifact candidate job to Ubuntu 24.04 and completes the read-only rehearsal mounts. All 24 focused workflow, package and actual validator-import guards passed, as did lint and YAML checks. PR #91 native files, the minimal SQL Dockerfile and its ignore file were unchanged by this correction. Actual image/native and PostgreSQL 18 qualification must pass in fresh CI; local tests do not replace those checks.

Logs preserve decoded GitHub output, including original formatting. `validation.json` binds all retained files, source revisions, job states, advertised artifact digests and the unchanged native-source inventory. No workflow rerun, artifact publication, live migration or deployment was performed here.
