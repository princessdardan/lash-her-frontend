# Actual local learner qualification

All six cases passed without skips or retries on frontend `6ed7825c192b1652827b64ffe5f51544fc7c8f33` and clean Course `5c23b8c53f7849426cf8a71703cc6a5c84fef3d7`. The corrected Course artifact is `5effaea43ac172be76f00ab2db910cd6786faed02c775380449b6d57fa37283d`; the frontend P2 manifest is `38d1d343cc697583977c88f5023845453a986c0637e09afc081045aee41895b1`. Node 24.18.0 and Next 16.4.3/Webpack ran with two disposable PostgreSQL 16 databases, applying 83 frontend and 22 Course migrations. Full frontend TypeScript checking and scoped harness lint passed on that source. No application behavior was changed for this qualification.

This supplements the earlier 28 learner edge-fixture cases and four legacy checks. Course responses in this run come from the selected actual Course server, JWT verifier, handlers, repositories and PostgreSQL. The browser uses actual Next customer-session validation, fenced learner-token issuance and same-origin academy handlers. The actor-cache fix `f561025a` and corrected administrator contract pins are included.

Three scenarios ran on desktop Chromium and again using the iPhone 13 viewport/device settings in Chromium:

- Free enrollment, private structured content and transcript, actual Course playback signing, stored resume restored in an independent browser context, zero-score practice completion, graded failure and successful retry. Direct SQL verifies the immutable grading receipts. No browser-local learning progress or API bearer/service origin leaks were observed.
- An actual concurrent progress update causes a Course revision conflict. The UI preserves the other device's saved resume/max and requires authoritative reload before continuing.
- Another account cannot read protected content, progress, attempts or playback before enrollment and receives independent state after enrollment. An audited actual Course administrator revocation denies the original grant. A controlled frontend fixture suspension then prevents further learner-token issuance and redirects the other session to sign-in. That last control tests frontend issuance denial; it does not claim cross-service lifecycle command delivery.

The final [Course database summary](actual-course-persistence.json) records eight free grants (six active and two explicitly revoked), ten progress rows with six completions, four graded attempts with two completions, and four practice attempts with four completions. The [source manifest](source-evidence.json), [terminal outcome](terminal-outcome.json), [browser output](browser-success.txt), and [validation hashes](validation.json) are separate retained receipts. The terminal outcome confirms that both owned servers and PostgreSQL stopped; every started child and SQL pool was awaited.

Fixture boundaries remain explicit. Customer rows and opaque sessions are generated in owned frontend SQL. Curriculum and quizzes are seeded through actual authenticated Course administrator HTTP routes. Ready media asset rows and media bytes are synthetic. The actual Mux SDK signs playback/thumbnail tokens locally with a freshly generated owned RSA key; the browser test independently verifies both signatures, audiences and maximum 600-second expiration. No live Mux credential, asset upload or provider HTTP operation is used. HLS/captions are intercepted locally, thumbnails intentionally return 404, and Sanity/fonts/the existing no-collection telemetry script are fixtures. Unexpected browser requests and Course provider fetches fail closed. Google/Resend login, live Mux delivery, deployed workload/gateway verification, staging/production activation and G2 acceptance are outside this evidence.

Run from a clean selected frontend checkout with PostgreSQL 16 binaries and matching installed dependencies:

```sh
COURSE_LEARNING_API_SOURCE=/path/to/clean/course-checkout \
COURSE_LEARNING_API_REVISION=5c23b8c53f7849426cf8a71703cc6a5c84fef3d7 \
node scripts/test-course-learning-browser.mjs
```

The driver accepts no external database URL. It requires the selected Course checkout to be clean at the exact requested commit, exports that source, checks matching contract/dependency bytes, and stores each attempt in a fresh `test-results/course-learning-browser/run-*` directory. An earlier request for the previous Course commit was refused before loopback allocation; [that receipt](old-source-refusal.txt) remains separate. The initial uncommitted test-helper type error is also retained separately from passing TypeScript output. Private storage state, signing material and traces are not copied into Git. The two screenshots contain synthetic lesson data and bundled fixture typography.
