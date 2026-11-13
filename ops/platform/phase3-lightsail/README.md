# Phase 3 Lightsail synthetic rehearsal release

The staging action adds the reviewed Course mapping table and imports one synthetic free practice draft. The public deployment, candidate API and gateway containers, the retained rollback project, and existing admission files remain in place during the action. The imported draft is not published. The fixture uses no external media or customer data.

## Exact source and artifacts

1. Publish the reviewed Course and frontend commits through the existing source review and CI workflow. Community retains its reviewed source pin. The artifact workflow expects Course and Community on their canonical `main` heads and the frontend on `staging`. After a merge, refresh the frontend Course revision pin to the exact merged commit and check the reviewed contract again. [Source candidate publication](../source-gate.md)
2. Start the existing **Platform artifact candidate** build for the exact staging source tuple. Download the successful attested candidate and the matching PostgreSQL 18 operator schema evidence. Verify the candidate attestation and immutable image digests using the existing artifact procedure. The local release notes are insufficient to authorize a write.
3. Assemble the existing staging migration bundle with Course `approvedPendingTags` set to `["0022_legacy_course_imports"]`, Course `allowEmptyBootstrap` set to `false`, and empty Community and frontend pending lists. Course target is PostgreSQL 18 at `course-postgres-staging:5432/lash_her_course_staging` under the existing migration role. Use the retained Course predecessor schema whose digest is emitted by the baseline command. Keep schema files and review inputs in private storage. [Migration bundle assembly](../../../docs/api-integration/operator-migrations.md)
4. Prepare the synthetic import package from the candidate attestation and matching clean source checkouts. The preparer verifies the GitHub attestation against the exact staging workflow and source revision.

```sh
node ops/platform/phase3-lightsail/prepare.mjs \
  "$STAGING_BUNDLE" "$RETAINED_COURSE_SCHEMA" "$CLEAN_COURSE_SOURCE" "$PRIVATE_IMPORT_PACKAGE" \
  "$CANDIDATE_ATTESTATION_BUNDLE"
```

## Review on the host

Reuse the existing private pinned staging SSH settings. Cache only the reviewed Course migration image by digest using the existing authenticated image path. The launcher never pulls an image or starts/stops either application project.

```sh
node ops/platform/phase3-lightsail/owner.mjs baseline "$STAGING_SSH_SETTINGS"
node ops/platform/phase3-lightsail/owner.mjs plan "$STAGING_SSH_SETTINGS" "$PRIVATE_IMPORT_PACKAGE"
```

The host plan checks the staging machine ID, both gateway identities, all retained container IDs, closed admission, private PostgreSQL networks and the retained schema receipt. It validates the packaged command offline and checks the actual migration role, hostname-verified TLS, exact 22-entry journal and predecessor schema, and absence of the synthetic draft. The plan emits a digest that also binds these host observations. It creates no durable host action directory.

## Owner-started staging action

```sh
node ops/platform/phase3-lightsail/owner.mjs apply "$STAGING_SSH_SETTINGS" "$PRIVATE_IMPORT_PACKAGE" "$VERIFIED_HOST_PLAN_SHA256"
```

Review the displayed package and enter `IMPORT PHASE 3 STAGING DRAFT`. Apply repeats the read-only plan under the host release lock and refuses drift. On one verified TLS session, the Course migration runner holds its database lock while it verifies the predecessor, applies only the approved forward migration, checks the resulting schema and role policy, and imports the hash-bound fixture in a transaction. The importer writes the SQL and draft receipts separately. The target receives no frontend or Community migration and no provider traffic.

Success emits `STAGING_PHASE3_DRAFT_IMPORTED`. Retain the private plan and action receipts off-host. A missing or failed outcome requires reconciliation of the journal and synthetic course/mapping against the receipts. Do not rerun the action or run the down migration against populated mappings. Keep the original gateway and both database lanes available.

## Runtime rehearsal boundary

This action prepares the database and draft only. The subsequent runtime/browser rehearsal needs the exact reviewed Course runtime and gateway images and matching frontend deployment. Stage those as a separate isolated release with a synthetic learner/provider configuration before moving reads or authoring. Existing staging routes, native schedules and customer-write admission remain closed during draft import. Deferred P2 checks and production are outside the release.
