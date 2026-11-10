# Frontend binding preflight source qualification

All ten jobs passed at `f78cf3af38665acca73d111fe1241e0a3d99bfe0` in CI run 42339874540, attempt 1. The terminal report binds the nine original ZIP digests, including two Docker build records, and three job-log hashes. The private archive contains 15 files plus its manifest. Manifest SHA-256 `bd758b2c6743345aa52ce3c2b19ff146b80eeaf971fc49d1809264d875a5b1d6`. Terminal report SHA-256 `845fd235ca6f1c2a4c72d85f852c29e11f285348856a57ef481dcf8535f4d384`. [CI run](https://github.com/princessdardan/lash-her-frontend/actions/runs/42339874540) · [Terminal report](terminal-report.json).

- Chromium, Firefox and WebKit recorded 582 passes, 159 skips, zero unexpected outcomes and zero retries. Seven required scenarios ran in each browser.
- Owned PostgreSQL 18 applied 83 frontend migrations. The platform fixtures passed 29 role, 18 release, nine native and ten certification checks. Nineteen identity and lifecycle cases passed. Seven interrupted-restoration negative cases preserved all three journals.
- Linux host checks recorded 932 passes and eight skips. The offline source receiver passed all 11 checks. Frontend and gateway image scans each retained two raw HIGH findings, 35 MEDIUM and eight LOW. Both qualified scans reported zero findings.

The new release preflight verifies the required variable names on the selected staging Vercel project before arming. It records names only. The previous staging observation identified missing customer identity, signing and admin origin settings. The owner-created Google client was observed separately. Actual configuration, frontend database lineage and deployed sign-in still require evidence. [Binding inventory](../2026-11-06-p2q-44dd-ci-and-bindings/README.md) · [Google client observation](../2026-11-06-p2q-google-customer-client-created/observation.json).

## Staging binding checklist

Use the Production target of the dedicated staging Vercel project `prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM`.

- Set `CUSTOMER_AUTH_URL` to `https://staging.lashher.com`. Bind `CUSTOMER_AUTH_GOOGLE_ID` and `CUSTOMER_AUTH_GOOGLE_SECRET` from the owner’s private handoff for **Lash Her Staging Customer Identity**. Verify the registered callback is `https://staging.lashher.com/api/customer-auth/callback/google`.
- Set a dedicated `CUSTOMER_AUTH_SECRET` of at least 32 bytes and set `CUSTOMER_AUTH_RESEND_KEY` and `CUSTOMER_AUTH_EMAIL_FROM` for the reviewed staging sender.
- Set `AUTH_URL` to `https://staging.lashher.com`. If `NEXTAUTH_URL` exists, use the same origin. Bind `AUTH_SECRET`, the reviewed `ADMIN_OWNER_EMAILS`, and the separate administrator `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET`. Verify the administrator callback is `https://staging.lashher.com/api/auth/callback/google`.
- Bind `COURSE_LEARNER_JWT_CURRENT_SECRET`, `COURSE_ADMIN_JWT_CURRENT_SECRET`, `COURSE_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET` and `COMMUNITY_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET` to the matching reviewed staging API verifier material.

Keep the source record limited to variable names and the public origin. The release preflight checks that the names exist. The staging browser journey verifies the actual provider callback and session.

## Certification profile compatibility

An owned fixture passed the current-only release plan with candidate v3 and frontend job v2. The bounded certification planner refused v2 settings. Presenting the same candidate under v1 settings still refused in frontend migration preparation. A positive legacy native-plan control passed before the matching v3 form was refused. The current-only release keeps admission closed, so this gap prevents starting its deployed lifecycle certification through the existing runner. [Local reproduction](certification-profile-join.json).

The host certification and interrupted-restoration entrypoints also use legacy release readers. The timing entrypoint refuses live execution, and its playback observation does not supply two hashes required by its finalizer. The normal source-owned browser and worker evidence readers exist. A deployed timing finalizer must join their retained evidence and the actual S12 receipt. G2-Q still requires both the profile-aware execution and actual staging results.
