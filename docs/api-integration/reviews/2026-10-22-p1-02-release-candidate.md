# P1-02 staging candidate review

The candidate is prepared from frontend `f955824` (current published main), in an
isolated checkout. The existing working trees in all three repositories are
preserved. Candidate publication is separate from deployment. The immutable
candidate tag is `staging-rc-p1-02-2026-10-22.2`; the full source SHA is supplied
through protected release variables after publication.

## Review and fixes

- Preserved main's HighLevel, service catalog, dependency remediation and CI work.
  Applied only the P1 contract, staging provider/environment, webhook redaction,
  secret-store/provisioning and release-control changes from the working tree.
- Fresh audit found five critical package findings inherited from main. Updated
  Next.js and eslint-config-next to exactly 16.4.2 and DOMPurify to exactly 3.4.17.
  Preserved reviewed dependency forks and overrides. Final audit has one existing
  low Quill finding, no moderate/high/critical findings.
- Fixed a Webpack resolution collision between `application-environment.mjs` and
  its TypeScript server wrapper by naming the wrapper
  `application-environment.server.ts`. Type checking alone did not expose this.
- Transactional staging email enforces exact recipient allowlisting before a
  provider call. Broadcast creation and delivery now refuse staging because a
  provider segment cannot enforce that allowlist. Production behavior is retained.
- The staging release preflight requires the exact pooled runtime role/host,
  `sslmode=verify-full` and only reviewed connection parameters. Source and migration
  pins remain separate; an unexecuted migration cannot satisfy the deployment gate.
- Reviewed API contract bytes match the published Course and Community commits in
  `contracts/api-integration/v1/manifest.json`. `ops/staging/migration-pins.json`
  pins every ordered journal entry and SQL SHA-256 across all three repositories.
  The integration bundle remains a candidate; this does not certify P2 identity or
  lifecycle implementations, API deployment, or a released P1-01 baseline.

## Executed validation

Node 24.18.0:

- 2,041 non-database source/script/security tests passed before the final additional
  runtime-TLS refusal test, which also passed separately.
- All 80 frontend forward migrations through 0079 passed on disposable PostgreSQL
  18. All 187 database tests passed there. No cloud application migration ran.
- Seventeen release-store/target/job refusal tests passed. Source and generated
  contract integrity checks and exact API committed-source checks passed.
- TypeScript passed. Repository lint had zero errors and eleven existing warnings;
  new release scripts also passed focused lint.
- `next build --webpack --experimental-build-mode=compile` passed with non-secret
  placeholders. This proves compilation and type checking, not prerendering or
  deployed provider flows. A normal local build without its CMS credential stopped
  at page-data collection. Full CI build/browser checks remain required on the
  published revision, using existing CI configuration.
- AWS protected resolver verified the exact frontend staging owner endpoint with
  a read-only certificate-verified TLS 1.3 connection. Values were withheld.

## Protected job and outstanding approvals

`.github/workflows/ci.yml` adds a frontend staging migration job after all quality,
DB, audit, build and browser checks. Its reviewed action revisions are pinned. It
requires a protected environment revision pin and recovery-evidence URL, a clean
checkout, the exact direct staging owner/database, verified TLS and PostgreSQL 18.
It holds the existing database advisory lock across complete preflight, per-entry
transactions, full post-lineage/runtime-grant checks and receipt persistence.
Unknown hashes/gaps, an unjournaled nonempty database or another runner fail closed.
The sanitized receipt and separate migration-source artifact are retained 30 days.
The runner's target/job guards were tested; its first approved cloud execution and
recovery-evidence approval remain outstanding.

GitHub environment `staging-migrations` exists with exact release/staging branch
restrictions, required princessdardan approval, self-review prevention and no
administrator bypass. princessdardan is the only collaborator and confirmed there
is no separate reviewer. A sole-developer gate with self-review permitted is
therefore proposed for explicit owner approval; no second developer is required
by this candidate. Administrator bypass remains disabled.

Automatic approval review rejected two actions: the initial self-review-permitting
configuration without explicit approval, and transfer of the staging owner DB URL
into GitHub's encrypted environment secret. The safer self-review-preventing
configuration was applied. No owner credential was transferred. The exact transfer
prepared in `install-migration-job-secret.mjs` resolves only the frontend staging
migration record through `asm-exec`, checks the approved protected environment and
sends the URL to `gh secret set` through stdin, never arguments or output. It does
not alter AWS access policies or deliver the owner URL to application runtime.

A broad secret-bearing local build was also rejected. The successful non-secret
compilation-only path resolves that validation step without broad credential
exposure. Full hosted build and deployed smoke certification remain open.

Before migration, approve the exact published candidate, sole-developer gate,
frontend-only credential transfer and target recovery evidence. Before deployment,
verify the successful receipt and set `STAGING_MIGRATION_VERIFIED_COMMIT` to the
same source SHA. Keep that pin absent until verification succeeds. Fast-forwarding
`staging` and the first actual deployment are subsequent steps; this request
prepares them. Course/Community migration execution, API images/host/gateway,
provider activation and deployed OIDC/native-scheduler acceptance remain open.

## Replacement candidate

The first published candidate `2390ff3` passed the full CI build and audit but
failed unit and coverage jobs because the release-check unit test depended on
sibling API clones. The replacement creates its own temporary Git source
repositories from the pinned bundle, commits those fixture bytes and uses their
exact revisions. All four contract-tool tests pass without sibling checkouts.
Runtime/migration code and SQL bytes are unchanged by this correction. The earlier
tag and CI failure remain available; the `.2` tag identifies the replacement.
