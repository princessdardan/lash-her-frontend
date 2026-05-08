# FRONTEND PACKAGE

## OVERVIEW

Only active package boundary. Contains the Next.js app, embedded Sanity Studio, Playwright tests, and migration/deploy scripts.

## STRUCTURE

```text
frontend/
├── src/app/                  # App Router routes, layouts, actions, API routes
├── src/components/           # UI primitives and custom CMS-driven components
├── src/data/loaders.ts       # GROQ loaders and cache tags
├── src/sanity/               # Studio config, clients, schemas, structure
├── src/types/index.ts        # Sanity/page/block TypeScript shapes
├── tests/                    # Playwright E2E
└── scripts/                  # Vercel install and migration utilities
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add/change route | `src/app/(site)` | Public pages live in route group. |
| Add CMS data | `src/data/loaders.ts`, `src/types/index.ts` | Keep GROQ projections and types synchronized. |
| Add CMS block | `src/sanity/schemas/objects/layout`, `src/components/custom/layouts` | Also update registry and loader projections. |
| Change form behavior | `src/components/custom/collection`, `src/app/actions/form.ts`, `src/lib/form-validation.ts` | Client and server validation must agree. |
| Change images | `next.config.ts`, `src/components/custom/sanity-image.tsx` | Currently only Sanity CDN is allowlisted. |
| Deploy install | `vercel.json`, `scripts/vercel-install.mjs` | Private Motion deps require `MOTION_DEV_TOKEN`. |

## CONVENTIONS

- npm is the package manager; commands run from this directory.
- Tailwind v4 is PostCSS-driven; do not expect `tailwind.config.*`.
- React Compiler is enabled in `next.config.ts`.
- `/homepage` permanently redirects to `/`.
- Use `docs/lash-her-brand-kit.html` from repo root for all visual/design choices.

## ANTI-PATTERNS

- Do not add a parallel data access layer next to `src/data/loaders.ts`.
- Do not add image remotes without verifying current media source requirements.
- Do not replace embedded Sanity Studio with a separate package unless explicitly asked.
- Do not run or modify migration scripts casually; see `scripts/AGENTS.md`.

## COMMANDS

```bash
npm run dev
npm run build
npm run lint
npm test
npm run test:ui
npm run migrate
```
