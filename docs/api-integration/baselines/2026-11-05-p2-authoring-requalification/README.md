# Actual local authoring requalification

All four Chromium scenarios passed on frontend `825d5ead4d6ae7b3fe4867635e0076104f0bc236` and clean Course `2847d953771adc8e8be287f9512b3003af94f190`. The final [source manifest](final-evidence.json), [terminal cleanup receipt](final-outcome.json), and [browser output](final-browser.txt) are separate retained artifacts. Both owned servers and PostgreSQL stopped successfully. The run used Node 24.18.0, Next 16.4.3/Webpack, actual Auth.js administrator JWT handling, actual frontend SQL identities, actual Course JWT verification/routes, and two disposable PostgreSQL 16 databases with 83 frontend and 22 Course migrations. The unchanged Course artifact is `0ebc41df298a5d515cde6a5d70f9428bfbc20058cfeedb8470d77debc0b95186`.

The scenarios cover:

- Owner authoring through persisted content, transcripts, quizzes, readiness and publication; stale edits retain unsaved input, and missing CSRF is denied.
- Unauthenticated and known non-editor page/handler denial.
- Keyboard ordering, archive/restore identity, dirty-editor cancellation, unavailable media and a narrow mobile viewport.
- Paid CAD publication and public catalog/page visibility; protected text remains private and checkout stays unavailable. The paid archive warning appears before a mutation, cancellation sends no mutation, confirmation uses the ordinary revision/archive body, and no extra mutation endpoint is called. Archived catalog access is denied; missing content prevents restoration until repaired and explicitly republished. IDs survive.

The original unconditional paid-publication placeholder was a material P2 gap because the accepted exclusion covers paid checkout. [Dardan's approved policy](../../decisions/2026-11-05-paid-publication-archive-policy.md) permitted the bounded correction. Course commit `bac4d589d9c808a350b546457f2c257b8c173678` passed `npm run verify` with 691 unit/contract checks and 11 actual PostgreSQL publication/archive checks. Those database checks verify existing-purchase denial, retained learning history and independent grants/payment references, no archive-created revocation, remaining Community eligibility, and republish that cannot override revocation, historical expiry, suspension or terminal deletion. The API integration owner's broader combined-source verification is separate evidence.

The driver requires explicit clean source paths and a full Course commit SHA, verifies the selected repository/HEAD and matching contract/dependency lock, exports that immutable source, invokes the installed Playwright CLI directly, and creates a fresh result directory per attempt. Missing revisions and a mismatched commit were refused before loopback resource allocation. Run from the selected clean frontend root:

```sh
COURSE_AUTHORING_API_SOURCE=/path/to/clean/course-checkout \
COURSE_AUTHORING_API_REVISION=2847d953771adc8e8be287f9512b3003af94f190 \
node scripts/test-course-authoring-browser.mjs
```

Six earlier failed browser/harness attempts remain separate with their original terminal receipts and completed cleanup. They cover unsupported native font mock forms, the actual Webpack Edge instrumentation import corrected by coordinator `3ba66f46`, blocked Speed Insights script/combobox lookup, incomplete synthetic header data, and an observed administrator refresh during first public-page compilation. The last issue was addressed by checking the public page after the archive/restoration interactions; all assertions remain. The earlier unit socket denial and missing synthetic lifecycle configuration are also retained separately from their passing reruns. Trace archives remain in ignored local output because they contain disposable session state; they are not copied into Git.

Workload verification, Sanity content, bundled fonts and the existing Speed Insights script are explicit fixture boundaries. Other external browser requests are blocked and fail the check. No Google/Resend sign-in, Mux provider operation, deployed gateway, staging activation, live paid publication, checkout, production activation or G2 acceptance is certified. [validation.json](validation.json) binds source/receipt hashes and exact check sources. The screenshots contain synthetic data.
