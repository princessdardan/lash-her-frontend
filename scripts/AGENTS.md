# SCRIPTS

## OVERVIEW

Operational scripts are high-risk because they can mutate external CMS assets/documents, databases, or canonical git state.

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Strapi migration | `migrate-strapi-to-sanity.ts` | Large one-off migration from legacy Strapi shapes to Sanity. |
| Private DB migration | `migrate-private-db.ts` | Applies private checkout database migrations. |
| Git remote verification | `verify-git-remote.mjs` | Confirms pushes target the canonical frontend repository. |

## DEPLOYMENT INSTALL CONTRACT

- Vercel uses the default root install and build detection for this Next.js app.
- No private Motion registry token is required for deployment install.

## MIGRATION CONTRACT

- Treat migration as external-side-effect work; do not run without explicit user approval.
- Source is legacy Strapi; destination is Sanity.
- Preserve `_key` generation for arrays and publish/mutation sequencing assumptions.
- Keep rich-text/image conversion logic isolated to the migration script; do not leak Strapi shapes into live loaders.
- Verify required env vars and dry-run/target dataset expectations before execution.

## DATABASE MIGRATION CONTRACT

- Treat database migrations as external-side-effect work; do not run without explicit user approval.
- Confirm `DATABASE_URL` targets the intended staging or production database before running `npm run db:migrate`.
- Generate migrations from the root with `npm run db:generate` only after confirming schema changes are intentional.

## ANTI-PATTERNS

- Do not invent or restore a custom Vercel install script unless deployment requirements change.
- Do not run migration scripts just to inspect behavior.
- Do not build new app code around migration-only Strapi response shapes.
