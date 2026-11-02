# Source candidate publication

The [single-operator release policy](../../docs/api-integration/release-policy.md) supersedes the November 1 external signing procedure. Dardan's authenticated manual workflow dispatch approves building the specified source revisions. No separate approval key, identity enrollment, signed permit, GitHub App or GitHub environment reviewer is required.

## One-time preparation

1. Publish/review the prepared source and CI changes in all three repositories. Private APIs use `main`; the frontend coordinator may use `staging` or `main`. No API staging branches are required. All selected heads must have passing CI.
2. Configure frontend repository Actions secret `PLATFORM_SOURCE_READ_TOKEN` with a fine-grained token limited to these three repositories: Contents read, Actions read, automatic Metadata read. Keep its value private and set an expiry. The existing compatibility workflows also need that same credential stored as `CROSS_REPO_READ_TOKEN` in both API repositories. These are three storage locations for one read-only credential. No cloud/database/package permission is needed. Registry writes use `GITHUB_TOKEN` separately.
3. Confirm the candidate GHCR packages are scoped correctly and private API images remain private. Native branch protection is useful where supported but is not required to buy or configure additional services.

## Each candidate

1. In frontend Actions, manually run **Platform artifact candidate** as `princessdardan`, choosing the frontend coordinator branch (`staging` or `main`; private APIs use `main`) and the exact three reviewed commit IDs. The frontend commit must match the workflow revision. This dispatch is the build approval; there is no second approval click.
2. The workflow verifies the canonical operator/repository/run, current branch heads and latest passing CI jobs, verifies the released Course–Community contract against the exact selected checkouts, then builds five immutable AMD64 artifacts. It scans exact digests, verifies native provenance/SBOMs, exercises the integration harness and records fresh source/CI evidence.
3. Use only a successfully qualified candidate. Retain its manifest and receipt with the release. A failed candidate is never deployable. A build rerun is allowed after checking the cause and revalidates current evidence. A failed migration is different: inspect database state before any deliberate retry.
4. Run staging through the operator release procedure. Production promotes the same verified artifacts after staging and its production checks. Artifact publication grants no deployment or migration permission.

## Remaining implementation

The source is committed and published as draft [frontend #55](https://github.com/princessdardan/lash-her-frontend/pull/55), [Course #3](https://github.com/princessdardan/lash-her-course-api/pull/3) and [Community #2](https://github.com/princessdardan/lash-her-community-api/pull/2). Both API primary CI runs pass; frontend follow-up checks remain in progress. Community's separate compatibility workflow cannot authenticate its private Course checkout. This remains a failed check pending the deferred read-only credential handoff; no secret value has been retrieved or changed. Exact-checkout release contract verification is independently required by the coordinator. GHCR publication and deployable-branch qualification remain unverified. The operator migration entrypoints/wrapper are implemented and locally tested; full deployment coordination and real staging execution remain unverified. The old separate source-signing code and identity workflow have been removed; historical signed-gate baselines describe the superseded implementation only.
