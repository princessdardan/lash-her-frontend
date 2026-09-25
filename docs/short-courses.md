# Email-gated short courses

Short courses live at `/courses/<slug>`. Editors manage them in Studio → Content → Short Courses. This is a marketing page gate: published Sanity content and asset URLs are public. Do not upload confidential material.

For editor instructions on adding videos and quizzes, publishing a course, and checking marketing signups, use the [course publishing tutorial](short-courses-tutorial.md).

## Authoring

1. Create a Short Course, supply its title, URL slug, introduction, optional cover, and SEO fields.
2. Add and reorder modules. Each needs a title, lesson text, Mux video, and at least one quiz question. Each question needs two to six answers, exactly one marked correct, and explanatory feedback.
3. Upload or select a video in **Video (Mux)**, keep playback **Public**, and wait for Mux processing to finish before publishing. Mux provides transcoding and adaptive streaming. See [Mux setup and migration](mux-course-videos.md) for dataset credentials and existing videos.
4. Optionally upload a poster and English WebVTT captions and add a transcript. Captions and transcripts should be included for spoken lessons.
5. Publish, then open `/courses/<slug>` to check the signup and playback experience. Add that URL to the existing Studio-managed navigation or another editorial link when ready. No sample course is published by the application or migration.

Keep existing modules when editing/reordering; their Sanity array `_key` values identify saved progress. Replacing a module creates a new identity. Quiz edits reset that module's answers/completion; replacing its video resets playback position. Reordering modules preserves progress. Drafts are not served through the course routes, including in presentation mode.

## Access and consent

- Signup requires an email address, phone number, and affirmative checkbox; Instagram handle is optional. Contact details, server-owned consent wording, timestamp, course reference, and source path are stored in PostgreSQL. `course_signup` is visible as “Course sign-up” in marketing reporting.
- The existing consent transaction queues Resend synchronization. There is no confirmation-email dependency or separate course email send. A database/Redis failure does not grant access; a delayed Resend job does not remove access.
- Existing contacts are deduplicated by normalized email. A fresh explicit signup may re-subscribe an unsubscribed contact. Returning with a valid grant never changes subscription state.
- A course-specific `lh_course_<hash>` cookie contains a signed version, course ID, random browser grant ID, and expiry. It contains no email. Cookies are HttpOnly, SameSite=Lax, host-only, and Secure in production. Their fixed lifetime is 365 days; ordinary visits do not renew them.
- Progress is stored under `lh_course_progress:<courseId>:<grantId>` in local storage. Quiz answers, last active module, completion, and playback position remain in that browser. Storage cannot grant access. Expired progress is discarded and cleaned up when a learner next opens an unlocked course.
- Users may attempt modules in any order. Any fully answered quiz completes a module, including a zero-score attempt. Retrying does not undo completion. Marketing unsubscribe leaves course access intact.
- Browser privacy settings, cleared cookies, secret rotation, or a new browser can require signup again. Blocking local storage prevents persistent progress but does not block a valid access cookie. Analytics consent is independent of functional course storage and email marketing consent.

## Configuration and deployment

1. Set an independent random `COURSE_ACCESS_SIGNING_SECRET` of at least 32 characters on each app environment. For example, generate one with `openssl rand -base64 48` and store it through the deployment secret manager. Never commit it. Rotation invalidates existing grants.
2. Configure the existing `DATABASE_URL`, `KV_REST_API_URL`, and `KV_REST_API_TOKEN`. Signup uses Redis quotas of 20 attempts per IP and 5 per email per hour; only keyed hashes are used in limiter keys. Missing limiter configuration fails closed.
3. Continue using `RESEND_SEGMENT_MARKETING_ID` and the existing marketing sync worker. `RESEND_SEGMENT_COURSE_SIGNUP_ID` is optional. General marketing topics apply; this version adds no course-specific topic or campaign automation.
4. Inspect the selected database with `npm run db:check`. Apply `0077_course_signup` using `npm run db:migrate` with the verified `PRIVATE_DB_MIGRATION_TARGET` and exact `PRIVATE_DB_MIGRATION_HOST`. Follow the existing production confirmation/backup requirements. The migration only adds an enum value; existing forms remain compatible. Apply it before deploying the application.
5. Deploy the source schema with the intended `NEXT_PUBLIC_SANITY_DATASET` set explicitly. Staging is `staging-2026-05-10`; production is `production` and also requires `SANITY_SCHEMA_DEPLOY_TARGET=production`. The `shortCourse` tag is handled by the existing signed revalidation endpoint; ensure the configured Sanity webhook includes creation, updates, and deletion of both `shortCourse` and `mux.videoAsset`.
6. Deploy the app with the matching dataset, database, and signing secret. No production content is seeded. Verify with an editor-provided course and an approved test address before adding a public navigation link.

For rollback, roll back the application while retaining the additive enum value. Unpublishing a course removes its page through normal revalidation; deleting its Mux videos or legacy Sanity file assets is a separate operation. Monitor existing marketing sync failures in the admin app and `[course-signup]` server errors; neither logs submitted email or access tokens.

If signup reports “We could not complete your signup,” run the read-only `npm run db:check -- --env-file <protected-env-file>` against the verified deployment database. A pending `0077_course_signup` causes PostgreSQL to reject the `course_signup` submission type (SQLSTATE `22P02`), rolling back the signup and preventing the access cookie. Apply the committed migration using the [private database migration runbook](private-database-migration-runbook.md), then retry. Server errors include a safe failure stage (`configuration`, `access`, `rate_limit`, `course`, `persistence`, or `cookie`) and a SQLSTATE code when available; raw exception messages and contact details are not logged.

## Verification

- Source unit tests: `node --import tsx --test src/lib/courses/access-token.test.ts src/lib/courses/progress.test.ts src/lib/courses/signup.test.ts src/sanity/schemas/documents/short-course.test.ts`.
- Database tests: provide an isolated `TEST_DATABASE_URL`, apply repository migrations, and run `node --conditions=react-server --import tsx --test src/lib/courses/signup.db.test.ts` with the normal Sanity environment values. This file is registered in the DB test runner.
- Browser tests: provide `COURSE_E2E_DATABASE_URL` pointing to an isolated localhost PostgreSQL database with migrations applied, then run `npx playwright test --config tests/courses.playwright.config.ts`. The dedicated configuration starts port 3107, fixtures Sanity/Redis transport, prohibits outbound Resend sends, and exercises the real server action and database. It runs desktop and mobile Chromium. No fixtures are activated in application production code.
- Staging smoke: upload and publish editor-provided Mux videos/captions/questions, verify gate and browser restart persistence, check the PostgreSQL consent/source fields and Resend sync result, then unsubscribe and verify access still works. Verify published edits and unpublishing invalidate cached content. Local fixture tests do not prove live Resend delivery or deployed webhook configuration.
