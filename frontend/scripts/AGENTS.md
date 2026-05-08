# SCRIPTS

## OVERVIEW

Operational scripts are high-risk because they mutate install behavior or external CMS assets/documents.

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Vercel install | `vercel-install.mjs` | Injects private Motion token, installs, restores placeholder. |
| Strapi migration | `migrate-strapi-to-sanity.ts` | Large one-off migration from legacy Strapi shapes to Sanity. |

## VERCEL INSTALL CONTRACT

- `vercel.json` runs `node scripts/vercel-install.mjs`.
- `MOTION_DEV_TOKEN` must exist in Vercel env.
- Script replaces `__MOTION_DEV_TOKEN__` in `package.json`, validates JSON, runs `npm install --no-package-lock`, then restores the placeholder.
- Failure logs Motion dependency specifiers with token masked.

## MIGRATION CONTRACT

- Treat migration as external-side-effect work; do not run without explicit user approval.
- Source is legacy Strapi; destination is Sanity.
- Preserve `_key` generation for arrays and publish/mutation sequencing assumptions.
- Keep rich-text/image conversion logic isolated to the migration script; do not leak Strapi shapes into live loaders.
- Verify required env vars and dry-run/target dataset expectations before execution.

## ANTI-PATTERNS

- Do not commit a real Motion token or leave token-injected package contents behind.
- Do not run migration scripts just to inspect behavior.
- Do not build new app code around migration-only Strapi response shapes.
