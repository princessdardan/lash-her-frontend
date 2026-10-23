# First staging release

Current candidate: [release review](../../docs/api-integration/reviews/2026-10-22-p1-02-release-candidate.md).
Candidate tag: `staging-rc-p1-02-2026-10-22`. The protected frontend migration job
and exact SQL/journal inventory are prepared. Cloud migrations, migration pin and
first deployment remain gated on the approvals/evidence described in that review.
The operator confirmed a sole-developer workflow; no separate reviewer is available.


Configuration is applied; deployment remains blocked. Resource identities,
observed state and open gates are in [first-release.json](first-release.json).
[Preparation evidence](../../docs/api-integration/baselines/2026-10-22-p1-02-deployment-preparation.md)
records live verification, approvals, billing, and source/test limitations.

The staging Vercel project is linked to repository branch `staging`. Its build
command runs `scripts/validate-staging-release.mjs` before the normal prebuild and
Next build. The current remote branch lacks these uncommitted changes and cannot
pass this gate. Review/publish a candidate before requesting deployment.

After source review, set `STAGING_RELEASE_COMMIT` to its full Git SHA in protected
staging configuration. After protected one-shot migrations, set
`STAGING_MIGRATION_VERIFIED_COMMIT` to the same reviewed SHA with matching release
evidence. Leave both unset while the corresponding work is incomplete. They live
outside the source commit to avoid a circular self-referencing Git hash.

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
No CI/host access or cloud application migration is configured by this handoff.
Community remains empty, with no migration journal or certified application lineage.

The [provider configuration](providers.md) records the dedicated Google Identity
and Calendar clients in the new staging Cloud project, reviewed test users and
administrator, isolated Resend account with a verified sender/empty segment/11
published templates, and disabled Square/Resend/Sanity webhooks. All three have
separate approved protected ingress credentials; all-deployment authentication
remains enabled. Only Square supplies Vercel's required private bypass system
variable. See [ingress scope](webhook-ingress.md) and
[current provider evidence](../../docs/api-integration/baselines/2026-10-22-p1-02-provider-configuration.md).

Source review, protected migration pins and deployed OAuth/signature/email smoke
checks remain outstanding. Review the legacy enabled Square preview callback
before generating sandbox events. Mux still needs its isolated environment and
Course gateway origin. Keep shipping and CRM disabled until their isolation
evidence exists.

The [configuration approval record](pending-configuration.md) describes what was
approved and applied. It authorizes neither deployment nor application migrations.
