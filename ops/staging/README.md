# First staging release

Replacement candidate: [candidate .4 review](../../docs/api-integration/reviews/2026-10-24-p1-02-candidate-4.md).
Tag: `staging-rc-p1-02-2026-10-24.4`, based on .3 at `6cce23a`.
The [.3 release attempt](../../docs/api-integration/baselines/2026-10-24-p1-02-candidate-3-release-attempt.md)
failed the current mandatory audit. Candidate .4 pins patched dependencies and
preserves the retention/admin fixes. The owner authorized continued protected
verification, staging promotion and one retention invocation on .4.

[Current gate register](../../docs/api-integration/baselines/2026-10-24-p1-02-candidate-4.json)
retains A01-A07/R01-R04 and the R05 audit gate. P1-02 remains BLOCKED.
The allowed release branch runs the protected migration job after quality, DB,
audit, build and browser checks. Owner review and exact protected revision remain
required. Record the final receipt/deployment/acceptance evidence with the release.

The staging Vercel project follows `staging`. Its build command runs
`scripts/validate-staging-release.mjs` before the normal prebuild and Next build.
Both protected release pins currently identify `d915619`; keep them there until
the replacement's release and migration evidence has been verified.

For promotion, require successful CI at the exact candidate SHA and reviewed
recovery evidence. Reuse the protected migration job on an allowed release ref
with its expected-revision approval updated to that SHA. All SQL/journal bytes
are unchanged, so the job should verify existing lineage and runtime grants
without applying new DDL. Retain its new receipt before changing
`STAGING_MIGRATION_VERIFIED_COMMIT`. Source and migration pins must both match
the replacement before deployment. Then verify anonymous label API 401 and
non-admin 403, and separately authorize and record one authenticated retention
run. The prior failed retention run remains a failure; earlier independent steps
may have committed. Do not claim a completed cleanup from local tests.

Inspect an explicitly supplied staging configuration snapshot locally with:

```sh
node scripts/validate-staging-release.mjs --env-file /absolute/private/staging.env
```

This command reads the supplied snapshot without merging the repository's
production `.env.local`. A successful check does not certify deployed OIDC claims,
provider flows, native schedules or smoke tests. Do not invent credentials or
mark migrations verified to make it pass.

`frontend-runtime-role.sql` records the applied frontend role grant scope.
Owner/direct credentials belong only to the protected migration process; the
frontend runtime receives only its pooled least-privilege connection. The SQL
file is a scope record, not an instruction to rerun database setup from a shell.

Community staging project `still-darkness-27201043` has no frontend binding.
Its separate runtime role `lash_her_community_staging_runtime` is configured and
verified. Runtime and direct owner/migration credentials are imported into separate
operator-only AWS Secrets Manager records, alongside the frontend migration record.
All three stored records passed protected-resolver read-only TLS checks. See the
[release-store handoff](release-store.md), [public metadata](release-store.json)
and [current evidence](../../docs/api-integration/baselines/2026-10-22-p1-02-release-handoff.md).
The original handoff did not configure CI/host access. The subsequent frontend protected migration is documented in the first-deployment evidence.
Community remains empty, with no migration journal or certified application lineage.

The [provider configuration](providers.md) records the dedicated Google Identity
and Calendar clients in the new staging Cloud project, reviewed test users and
administrator, isolated Resend account with a verified sender/empty segment/11
published templates, and disabled Square/Resend/Sanity webhooks. All three have
separate approved protected ingress credentials; all-deployment authentication
remains enabled. Only Square supplies Vercel's required private bypass system
variable. See [ingress scope](webhook-ingress.md) and
[current provider evidence](../../docs/api-integration/baselines/2026-10-22-p1-02-provider-configuration.md).

The replacement needs exact-revision CI, protected migration verification and deployed acceptance. First-deployment OAuth/signature evidence remains scoped to d915619; email business-flow checks remain outstanding. Review the legacy enabled Square preview callback
before generating sandbox events. Mux still needs its isolated environment and
Course gateway origin. Keep shipping and CRM disabled until their isolation
evidence exists.

The [configuration approval record](pending-configuration.md) describes what was
approved and applied. It authorizes neither deployment nor application migrations.
