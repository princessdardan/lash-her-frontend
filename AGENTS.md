# PROJECT KNOWLEDGE BASE

**Generated:** 2026-05-04
**Commit:** 540d143
**Branch:** main

## OVERVIEW

Lash Her by Nataliea is a Next.js 16 beauty/lash artistry site with an embedded Sanity Studio and Sanity-backed page/forms content. The active app is `frontend`; root-level docs and planning exist, but there is no root package or active backend in this checkout.

## STRUCTURE

```text
lash-her/
├── frontend/                         # active Next.js app, Sanity Studio, tests, scripts
├── docs/lash-her-brand-kit.html      # design source of truth
├── docs/superpowers/                 # historical specs/plans
├── .planning/                        # historical phase plans/research
└── CLAUDE.md                         # repo guidance loaded by agents
```

## CANONICAL GIT REPOSITORY

- Canonical GitHub remote: `https://github.com/princessdardan/lash-her-frontend.git`.
- The `staging` branch for `staging.lashher.com` must be pushed to `lash-her-frontend`, not `lash-her`.
- Before any branch creation, PR, or push, run `git remote -v` and verify the target remote URL.
- Prefer the configured `frontend` remote or the package command `npm run git:push-staging` from `frontend/`; do not assume `origin` is correct in local checkouts.

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| App commands/dependencies | `frontend/package.json` | Run npm commands from `frontend`, not repo root. |
| Public routes | `frontend/src/app/(site)` | Async server pages; CMS data via loaders. |
| Global layout/metadata | `frontend/src/app/layout.tsx` | Fonts, analytics, Speed Insights, metadata. |
| CMS reads/GROQ | `frontend/src/data/loaders.ts` | Central Sanity fetch boundary and cache tags. |
| Shared shapes | `frontend/src/types/index.ts` | Mirrors Sanity schema fields and block unions. |
| Sanity Studio/schemas | `frontend/src/sanity` | Embedded Studio at `/studio`; manual schema registration. |
| CMS block rendering | `frontend/src/components/custom/layouts` | `_type` registry, animation, error boundaries. |
| Forms | `frontend/src/app/actions/form.ts`, `frontend/src/lib/form-validation.ts`, `frontend/src/lib/email.ts` | Validate twice, write to Sanity, email non-blocking. |
| Revalidation | `frontend/src/app/api/revalidate/route.ts` | Sanity webhook HMAC + Next 16 tag expiry. |
| E2E tests | `frontend/tests` | Playwright only; no Jest/Vitest. |
| Deployment install | Vercel default install | No private Motion registry token is required. |

## CODE MAP

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `loaders` | constant | `frontend/src/data/loaders.ts` | All page/global/menu/training Sanity reads. |
| `TLayoutBlock` | union | `frontend/src/types/index.ts` | Allowed CMS block shapes. |
| `COMPONENT_REGISTRY` | constant | `frontend/src/components/custom/layouts/block-renderer.tsx` | Maps Sanity `_type` to React component. |
| `BlockRenderer` | function | `frontend/src/components/custom/layouts/block-renderer.tsx` | Renders CMS blocks with wrappers. |
| `schemaTypes` | constant | `frontend/src/sanity/schemas/index.ts` | Manual Sanity schema registry. |
| `structure` | resolver | `frontend/src/sanity/structure/index.ts` | Singleton/page/content/submission Studio tree. |
| `submitGeneralInquiry` | server action | `frontend/src/app/actions/form.ts` | General inquiry write/email pipeline. |
| `submitTrainingContact` | server action | `frontend/src/app/actions/form.ts` | Training inquiry write/email pipeline. |
| `POST` | route handler | `frontend/src/app/api/revalidate/route.ts` | Sanity webhook revalidation endpoint. |

## CONVENTIONS

- `@/*` maps to `frontend/src/*`; prefer it for frontend imports.
- Sanity is the primary CMS. Strapi references are migration/legacy context unless explicit migration work is requested.
- Add CMS blocks across all layers together: schema, TS interface/union, GROQ projection, component, registry.
- Cache tags in `loaders.ts` must match `TYPE_TAG_MAP` in the revalidation route.
- Sanity singleton document IDs match schema names (`homePage`, `globalSettings`, `mainMenu`, etc.).
- Design decisions must use `docs/lash-her-brand-kit.html` as the source of truth.

## ANTI-PATTERNS (THIS PROJECT)

- Do not run frontend commands from repo root; there is no root `package.json`.
- Do not call `req.json()` before `parseBody()` in the Sanity webhook route.
- Do not change `revalidateTag(tag, { expire: 0 })` to deprecated single-arg usage.
- Do not assume registered Sanity schemas are rendered; `ctaSectionImage` and `ctaSectionVideo` are registered but not in `BlockRenderer`.
- Do not bypass dedicated Sanity clients; use read/write/form clients by purpose.
- Do not treat current Playwright API mocks as proof of current data flow; several are legacy Strapi-style mocks.

## UNIQUE STYLES

- Brand tone: quiet luxury, editorial restraint, precise/warm copy.
- Palette/fonts/radius/spacing come from `docs/lash-her-brand-kit.html`: Royal Mulberry, Midnight Espresso, Antique Champagne, Black Cherry, Dusty Silk; Cormorant Garamond, Cormorant SC, Inter.
- UI should avoid generic beauty-site pinks, neon/glitter effects, crowded badges, and loud CTAs.

## COMMANDS

```bash
cd frontend
npm run dev
npm run build
npm run lint
npm test
npx playwright test tests/homepage.spec.ts --project=chromium
```

## NOTES

- No checked-in lockfile was found; Vercel uses the default npm install behavior.
- `frontend/README.md` is still create-next-app boilerplate; prefer this file and `CLAUDE.md` for repo-specific guidance.
- `backend/` is mentioned in memory as legacy Strapi, but no backend directory exists in this checkout.
