# PROJECT KNOWLEDGE BASE

**Generated:** 2026-05-04
**Updated:** 2026-05-12
**Branch:** staging

## OVERVIEW

Lash Her by Nataliea is a Next.js 16 beauty/lash artistry site with an embedded Sanity Studio and Sanity-backed page/forms content. The active app now lives at the repository root so Vercel can detect the Next.js app without a nested package boundary. Root-level docs, planning, canonical git metadata, and local agent state remain at root.

## STRUCTURE

```text
lash-her/
├── src/app/                         # App Router routes, layouts, actions, API routes
├── src/components/                  # UI primitives and CMS-driven components
├── src/data/loaders.ts              # GROQ loaders and cache tags
├── src/sanity/                      # Studio config, clients, schemas, structure
├── src/types/index.ts               # Sanity/page/block TypeScript shapes
├── tests/                           # Playwright E2E
├── scripts/                         # migration, database, and git utilities
├── drizzle/                         # private checkout database migrations
├── public/                          # static assets
├── docs/lash-her-brand-kit.html     # design source of truth
├── docs/superpowers/                # historical specs/plans
├── .planning/                       # historical phase plans/research
└── CLAUDE.md                        # repo guidance loaded by agents
```

## CANONICAL GIT REPOSITORY

- Canonical GitHub remote: `https://github.com/princessdardan/lash-her-frontend.git`.
- The `staging` branch for `staging.lashher.com` must be pushed to `lash-her-frontend`, not `lash-her`.
- Before any branch creation, PR, or push, run `git remote -v` and verify the target remote URL.
- Prefer the configured `frontend` remote or the package command `npm run git:push-staging`; do not assume `origin` is correct in local checkouts.

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| App commands/dependencies | `package.json` | Run npm commands from repo root. |
| Public routes | `src/app/(site)` | Async server pages; CMS data via loaders. |
| Global layout/metadata | `src/app/layout.tsx` | Fonts, analytics, Speed Insights, metadata. |
| CMS reads/GROQ | `src/data/loaders.ts` | Central Sanity fetch boundary and cache tags. |
| Shared shapes | `src/types/index.ts` | Mirrors Sanity schema fields and block unions. |
| Sanity Studio/schemas | `src/sanity` | Embedded Studio at `/studio`; manual schema registration. |
| CMS block rendering | `src/components/custom/layouts` | `_type` registry, animation, error boundaries. |
| Forms | `src/app/actions/form.ts`, `src/lib/form-validation.ts`, `src/lib/email.ts` | Validate twice, write to Sanity, email non-blocking. |
| Booking | `src/lib/booking`, `src/app/api/booking` | Google Calendar booking service, API routes, and validation. |
| Commerce/checkout | `src/lib/commerce`, `src/components/commerce`, `src/app/api/checkout` | Helcim checkout, cart, payment validation, and order storage. |
| Private DB | `src/lib/private-db`, `drizzle`, `drizzle.config.ts` | Private checkout database schema and migrations. |
| Revalidation | `src/app/api/revalidate/route.ts` | Sanity webhook HMAC + Next 16 tag expiry. |
| E2E tests | `tests` | Playwright only; no Jest/Vitest. |
| Operational scripts | `scripts` | Migration, database, and canonical remote helpers. |
| Deployment install | Vercel default install | No private Motion registry token is required. |

## CODE MAP

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `loaders` | constant | `src/data/loaders.ts` | All page/global/menu/training Sanity reads. |
| `TLayoutBlock` | union | `src/types/index.ts` | Allowed CMS block shapes. |
| `COMPONENT_REGISTRY` | constant | `src/components/custom/layouts/block-renderer.tsx` | Maps Sanity `_type` to React component. |
| `BlockRenderer` | function | `src/components/custom/layouts/block-renderer.tsx` | Renders CMS blocks with wrappers. |
| `schemaTypes` | constant | `src/sanity/schemas/index.ts` | Manual Sanity schema registry. |
| `structure` | resolver | `src/sanity/structure/index.ts` | Singleton/page/content/submission Studio tree. |
| `submitGeneralInquiry` | server action | `src/app/actions/form.ts` | General inquiry write/email pipeline. |
| `submitTrainingContact` | server action | `src/app/actions/form.ts` | Training inquiry write/email pipeline. |
| `POST` | route handler | `src/app/api/revalidate/route.ts` | Sanity webhook revalidation endpoint. |

## CONVENTIONS

- npm is the package manager; commands run from repo root.
- `@/*` maps to `src/*`; prefer it for app imports.
- Sanity is the primary CMS. Strapi references are migration/legacy context unless explicit migration work is requested.
- Add CMS blocks across all layers together: schema, TS interface/union, GROQ projection, component, registry.
- Cache tags in `loaders.ts` must match `TYPE_TAG_MAP` in the revalidation route.
- Sanity singleton document IDs match schema names (`homePage`, `globalSettings`, `mainMenu`, etc.).
- Tailwind v4 is PostCSS-driven; do not expect `tailwind.config.*`.
- React Compiler is enabled in `next.config.ts`.
- `/homepage` permanently redirects to `/`.
- Design decisions must use `docs/lash-her-brand-kit.html` as the source of truth.

## ANTI-PATTERNS (THIS PROJECT)

- Do not run app commands from a nested `frontend` directory; the app package is now at repo root.
- Do not call `req.json()` before `parseBody()` in the Sanity webhook route.
- Do not change `revalidateTag(tag, { expire: 0 })` to deprecated single-arg usage.
- Do not assume registered Sanity schemas are rendered; `ctaSectionImage` and `ctaSectionVideo` are registered but not in `BlockRenderer`.
- Do not bypass dedicated Sanity clients; use read/write/form clients by purpose.
- Do not treat current Playwright API mocks as proof of current data flow; several are legacy Strapi-style mocks.
- Do not add a parallel data access layer next to `src/data/loaders.ts`.
- Do not replace embedded Sanity Studio with a separate package unless explicitly asked.
- Do not run or modify migration scripts casually; see `scripts/AGENTS.md`.

## UNIQUE STYLES

- Brand tone: quiet luxury, editorial restraint, precise/warm copy.
- Palette/fonts/radius/spacing come from `docs/lash-her-brand-kit.html`: Royal Mulberry, Midnight Espresso, Antique Champagne, Black Cherry, Dusty Silk; Cormorant Garamond, Cormorant SC, Inter.
- UI should avoid generic beauty-site pinks, neon/glitter effects, crowded badges, and loud CTAs.

## COMMANDS

```bash
npm run dev
npm run build
npm run lint
npm test
npm run test:unit
npm run test:ui
npm run db:generate
npm run db:migrate
npx playwright test tests/homepage.spec.ts --project=chromium
```

## NOTES

- `package-lock.json` is allowed at the repo root and should not be ignored.
- `backend/` is mentioned in memory as legacy Strapi, but no backend directory exists in this checkout.
