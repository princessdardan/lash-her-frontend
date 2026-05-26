# Production Readiness Audit

Date: 2026-05-26

Scope: Next.js 16 public site, Sanity Studio/content workflow, booking and checkout APIs, private PostgreSQL boundary, Vercel preview/staging readiness, UI/accessibility, tests, and operational documentation.

## Scope assumption

This audit evaluates whether the codebase is production-ready **assuming the approved staging Sanity dataset and schemas are the launch source of truth**.

The intended release path is:

1. Stabilize and verify this codebase against the staging Sanity dataset/schema.
2. Replace the current production codebase with the approved staging codebase.
3. Export the approved staging Sanity dataset and import it into the production Sanity dataset during a controlled cutover.

Current production Sanity drift, current production content gaps, and missing production-scoped Vercel environment variables are not treated as codebase readiness blockers in this document. Those cutover tasks are tracked separately in `docs/production-readiness-migration-plan.md`.

## Executive verdict

The codebase is **not ready for production promotion yet**, even under the staging-as-source assumption. The strongest blockers are current failing unit/browser tests, legacy private-submission schemas and data still present in the public Sanity boundary, and launch-facing UI/accessibility regressions.

Do not promote the staging codebase or staging Sanity dataset into production until the blockers and critical/high findings below are resolved and re-verified against the staging environment. After this audit passes, complete `docs/production-readiness-migration-plan.md` for the production dataset/env cutover.

## Evidence gathered

- `npm run build`: passed locally. The build emitted repeated `--localstorage-file` warnings from Node/test tooling, but the Next build completed.
- `npm run lint`: passed with 0 errors and 12 warnings.
- `npm run test:unit`: failed, with 494 passing and 2 failing tests.
- Focused Playwright command `npx playwright test tests/navigation.spec.ts tests/responsive.spec.ts --project=chromium`: failed, with 62 passing and 3 failing tests.
- `node scripts/validate-sanity-env.mjs`: passed for local environment.
- Production-env simulation evidence was excluded from this revised readiness verdict because production Vercel env alignment is a cutover task, not a staging-backed codebase-readiness finding.
- `npm audit --audit-level=moderate`: reported 23 moderate vulnerabilities across `esbuild`, `postcss`, `qs`, `uuid`, and `ws` dependency chains.
- Sanity project metadata was checked read-only for project `3auncj84`: staging and production datasets are public, and staging contains submission-like legacy documents that must not be promoted into production without cleanup. Current production schema/content drift is moved to the migration plan.
- Browser smoke checks confirmed `/contact` renders with zero `<h1>` headings, mobile sheet dialog warnings, and nested landmarks on `/booking`.
- Earlier checkpoint evidence showed Square/training invoice changes in progress during the audit. This report does not assess unreleased work outside the evidence captured here.

## Findings moved to the migration plan

The following original audit items were about current production environment/dataset state or one-time cutover execution. They remain important, but they are not codebase readiness blockers under the staging-as-source assumption.

| Original item | New home |
| --- | --- |
| B3. Production environment validation fails in the local production simulation | `docs/production-readiness-migration-plan.md` |
| C2. Production deployed Sanity schema/content is behind source and staging | `docs/production-readiness-migration-plan.md` |
| Production-only parts of C1, including existing production submission documents | `docs/production-readiness-migration-plan.md` |
| Production env/schema/content launch gates from the old recommended launch gate | `docs/production-readiness-migration-plan.md` |

## Blockers

### B1. Unit test suite is currently red

**Evidence**

- `npm run test:unit` ended with `tests 496`, `pass 494`, `fail 2`.
- `src/components/booking/booking-flow.test.ts` failed `keeps booking product cards decoupled from product checkout objects` because `src/components/commerce/product-card.tsx` now contains checkout navigation (`router.push('/checkout?...')`).
- `src/components/commerce/product-card.test.ts` failed because `ProductCard` now calls `useRouter()` during server rendering: `Error: invariant expected app router to be mounted`.

**Impact**

This is a direct release gate failure. It also signals architectural coupling between product cards and checkout behavior that tests were explicitly guarding against.

**Remediation**

Keep Buy now as the deliberate `ProductCard` contract. Update the old checkout-decoupling test to reflect that approved behavior, while preserving coverage that booking product cards pass only the product-card data they need. Fix the rendering test by mocking Next navigation, or move that coverage to a browser test where the App Router is mounted.

### B2. Browser smoke tests are currently red

**Evidence**

- Focused Playwright run reported 62 passed and 3 failed.
- `tests/navigation.spec.ts` failed `should have a working logo link to homepage`; expected `/`, received `http://localhost:3000/contact`.
- Browser smoke confirmed `/contact` has no `<h1>`.
- Runtime console warned: missing Radix Dialog description for sheet content.

**Impact**

Navigation, accessibility, and page-structure regressions are present on public routes before launch.

**Remediation**

Fix the logo navigation regression, give `/contact` a real `<h1>`, add the missing sheet description, and rerun the focused Playwright specs plus the full Playwright suite.

## Critical findings

### C1. Legacy private-submission schemas and staging data still cross the public Sanity boundary

**Evidence**

- Legacy private-data schemas remain registered/exposed: `contactForm`, `generalInquiry`, `contactPopupSubmission`, and `bookingMarketingOptIn` in `src/sanity/schemas/index.ts` and `src/sanity/structure/index.ts`.
- These schemas include name, email, phone, Instagram, message, booking/training intent, and marketing opt-in style fields in `src/sanity/schemas/documents/contact-form.ts`, `src/sanity/schemas/documents/general-inquiry.ts`, `src/sanity/schemas/documents/contact-popup-submission.ts`, and `src/sanity/schemas/documents/booking-marketing-opt-in.ts`.
- Read-only Sanity checks found submission-like documents in the staging dataset that is intended to become the source of truth for production.
- Both staging and production Sanity datasets are public.

**Impact**

This violates the repository rule that Sanity stores only public/editorial content while PostgreSQL stores private submissions, consent, contact, booking, checkout, and payment history. If the staging dataset is promoted wholesale, legacy private submission records and workflows could be carried into production unless they are cleaned up first.

**Remediation**

Backfill/verify private DB records, then redact/delete legacy Sanity submission documents from the staging source-of-truth dataset before export. Remove these schemas from source and Studio, or quarantine them as archival read-only types outside live Studio workflows. Keep tests that prevent new runtime Sanity writes for customer submissions. Use `docs/production-readiness-migration-plan.md` for the production cleanup/import sequence.

## High findings

### H1. Checkout buttons can remain permanently disabled if the Helcim script fails

**Evidence**

- `src/components/commerce/helcim-pay-button.tsx` and `src/components/commerce/training-helcim-pay-button.tsx` disable the CTA while `!isScriptReady`.
- The Helcim `<Script>` only sets `onLoad`; there is no `onError`, retry path, visible loading copy, or support fallback.

**Impact**

Ad blockers, slow networks, CSP issues, or Helcim outages can make product/training checkout inert with no clear recovery path.

**Remediation**

Add a script-load error state, retry action, explanatory loading/error copy, and a support/contact fallback. Track script failure in observability if possible.

### H2. Training enrollment toggle can expose hidden form controls to keyboard users and risks hydration mismatch

**Evidence**

- `src/components/custom/training-enrollment-toggle.tsx` reads `window.location.hash` in the `useState` initializer; SSR defaults to `enrollment`, while a direct client load with `#contact` initializes to `contact`.
- Inactive panels remain mounted and are hidden only with opacity/pointer-events and `aria-hidden`.

**Impact**

Direct marketing links to `#contact` can hydrate differently from server output. Keyboard/screen-reader users can potentially reach hidden form fields.

**Remediation**

Initialize state deterministically, read hash in `useEffect`, and render only the active panel or apply `hidden`/`inert` with focus management.

### H3. Revenue-critical UI still uses undefined legacy brand classes

**Evidence**

- `rg` found `btn-primary-red`, `card-white`, `brand-pink`, `brand-dark-grey`, and `text-brand-red` in product confirmations, services pages, mobile navigation, cart sheet, training checkout/confirmation/schedule pages, and Helcim buttons.
- The same search in `src/app/globals.css` returned no definitions.

**Impact**

Payment, confirmation, cart, service booking, and mobile navigation surfaces can render with missing or weak styling, undermining trust at conversion moments.

**Remediation**

Replace legacy classes with current `lh-*` Tailwind v4 tokens or shared UI components, then re-run visual/browser smoke on checkout and confirmation pages.

### H4. Booking operations docs reference a stale content type

**Evidence**

- Runtime/source uses Sanity `service` for booking offerings and revalidation maps `service` plus `bookingSettings`.
- Docs and README smoke matrix still reference `bookingOffering` in places.

**Impact**

Launch operators may create or test the wrong content type, and webhook setup may omit the actual changed type.

**Remediation**

Replace `bookingOffering` references with `service` in runbooks, setup guides, launch checklist, README smoke matrix, and Sanity webhook filter guidance, unless `bookingOffering` is intentionally reintroduced.

### H5. Draft preview/editor verification workflow is not implemented

**Evidence**

- `src/sanity/sanity.config.ts` only uses the structure tool.
- Studio route only mounts `NextStudio`.
- There are no draft-mode route handlers, no Presentation Tool wiring, no `VisualEditing`, and no `SanityLive`/draft perspective flow.

**Impact**

Editors must publish to inspect changes on the site. This raises the chance of broken public content when staging is used as the source of truth for production.

**Remediation**

Add Presentation Tool or a simpler draft preview path: draft-mode enable/disable routes, draft-aware Sanity client/perspective, and visual editing/live preview if desired.

## Medium findings

### M1. `sanity.cli.ts` defaults unqualified Sanity CLI operations to production

**Evidence**

- `sanity.cli.ts` hardcodes `dataset: "production"`.

**Impact**

Unqualified `npx sanity ...` operations can target production when an operator expected staging. This is especially risky during the planned staging-to-production dataset promotion.

**Remediation**

Add explicit staging/production wrapper scripts and make docs require one of them. Consider a fail-closed CLI config or environment-controlled dataset selection with validation. The migration plan also calls this out as a cutover guardrail.

### M2. Site JSON-LD still contains launch TODO placeholders

**Evidence**

- `src/app/(site)/layout.tsx` includes placeholder logo URL, phone, email, blank locality/region, empty opening hours, and TODO comments in the `BeautySalon` structured data.

**Impact**

Local business structured data is incomplete or inaccurate, reducing SEO trust and potentially exposing incorrect business details.

**Remediation**

Populate verified business values from source-controlled config or CMS settings. Remove fields that are not yet known rather than shipping placeholders.

### M3. Public site layout globally loads and serializes product catalog data

**Evidence**

- `src/app/(site)/layout.tsx` awaits `loaders.getGlobalData()`, `loaders.getMainMenuData()`, then `loaders.getProducts()` for every public route.
- `CartSheet` receives the full products array globally.

**Impact**

Every public page pays product loader/cache and client serialization cost, even pages where cart/product data is irrelevant. This can hurt TTFB/RSC payload size and hydration scope.

**Remediation**

Parallelize global layout fetches and lazy-load/minimize cart product data when the cart opens or when commerce pages render.

### M4. Custom global error boundary file is not recognized by App Router

**Evidence**

- The file is named `src/app/(site)/global-errors.tsx`.
- Next App Router recognizes `global-error.tsx` or segment-level `error.tsx`, not plural `global-errors.tsx`.

**Impact**

Users likely see the default Next.js error UI instead of the branded recovery UI on public-site failures.

**Remediation**

Rename/move to `src/app/global-error.tsx` for root failures or add `src/app/(site)/error.tsx` for public-site segment failures.

### M5. Revalidation may race Sanity CDN freshness

**Evidence**

- The Sanity client uses CDN outside Vercel preview.
- `/api/revalidate` uses signed `parseBody()` and `revalidateTag(tag, { expire: 0 })`, but does not use delayed webhook parsing or a CDN-bypass first fetch path.

**Impact**

Next cache can be expired before Sanity CDN returns fresh content, causing stale content to be re-cached after a successful webhook.

**Remediation**

Use delayed webhook parsing where supported, bypass CDN for the immediate post-revalidation fetch path, or validate freshness as part of the Sanity publish smoke test.

### M6. Migration and private-data retention guardrails are manual

**Evidence**

- `drizzle.config.ts` and `scripts/migrate-private-db.ts` apply migrations to whichever `DATABASE_URL` is set.
- Private DB schema stores PII/payment-adjacent JSON snapshots, payloads, and metadata with lifecycle fields but no automated purge/redaction job was found.

**Impact**

Operators can migrate the wrong database, and retained PII/payment-adjacent records can exceed intended retention windows.

**Remediation**

Add migration target guards for host/project/branch/environment and explicit production confirmation. Define retention windows per table and implement scheduled purge/redaction jobs. Use `docs/private-database-migration-runbook.md` and the cutover migration plan for production execution evidence.

### M7. Some hot-path private DB lookups lack obvious indexes

**Evidence**

- Booking hold lookup filters by `checkout_order_public_id`, while schema indexes focus on other checkout/order fields.
- Order correlation lookup filters `provider_metadata->>'correlationId'` without an observed expression index.

**Impact**

Confirmation and webhook reconciliation paths can slow down as private order/hold tables grow.

**Remediation**

Add an index on `appointment_holds.checkout_order_public_id` and a partial expression index for Square correlation IDs.

### M8. Booking and mobile dialog accessibility issues remain

**Evidence**

- `/booking` renders an inner `<main>` inside the site layout main wrapper.
- Mobile navigation `SheetContent` has no `SheetDescription` and `sheet.tsx` renders a close control around a 16x16 icon without a 44x44 target.
- Mobile CTA uses `<Link><Button /></Link>` nesting.

**Impact**

Assistive tech landmarks, dialog context, and touch/keyboard usability are weaker than launch quality.

**Remediation**

Change inner booking `<main>` to `section`/`div`, add `SheetDescription`, enlarge the close target, and use `Button asChild` or styled links for CTA controls.

### M9. Dependency audit has unresolved moderate vulnerabilities

**Evidence**

- `npm audit --audit-level=moderate` reported 23 moderate vulnerabilities.
- Affected chains include `drizzle-kit`/`esbuild`, `next`/`postcss`, `qs`, `sanity`/`uuid`, `googleapis`/`uuid`, and `ws`.

**Impact**

Most appear to be framework/tooling/transitive risks, but they should be triaged before production, especially dev-server exposure and server-side dependency chains.

**Remediation**

Run safe `npm audit fix` candidates, review breaking upgrades separately, and document accepted residual risk where no safe patch exists.

### M10. CI/release remote expectations are inconsistent with the current checkout

**Evidence**

- `package.json` defines `git:push-staging` as `git push frontend staging` after verifying a remote named `frontend`.
- `git remote -v` currently shows only `origin`, pointing to the canonical repository.

**Impact**

The documented/prescribed staging push command will fail in this checkout unless `frontend` is added.

**Remediation**

Either add/update the local `frontend` remote before release work, or update scripts/docs to use `origin` consistently.

## Low findings

### L1. Playwright mobile and accessibility coverage is shallow

**Evidence**

- Current focused failures came from navigation/responsive smoke tests.
- Existing Playwright config has desktop projects enabled; mobile projects are not the primary coverage path.
- Several browser accessibility issues were found manually rather than by an automated axe-style gate.

**Impact**

Responsive and accessibility regressions can slip through despite broad smoke tests.

**Remediation**

Enable mobile browser projects or dedicated mobile CI, add accessibility checks for landmarks/dialog headings/forms, and make required navigation assertions non-optional.

### L2. Font payload is broader than necessary

**Evidence**

- Root layout loads many Inter weights.

**Impact**

Unnecessary font CSS/preload can add small performance cost.

**Remediation**

Use Inter variable default or restrict to weights actually used.

## Positive readiness signals

- Public Sanity reads are centralized in `src/data/loaders.ts`, matching the repository convention.
- Sanity revalidation uses `parseBody()` before consuming the request body and `revalidateTag(tag, { expire: 0 })`, which is the correct Next 16 immediate-expiry pattern.
- Transactional confirmation/schedule routes opt out of static caching where private query state is involved.
- Product/training/service payment mock mode is server-only and explicitly rejected for production by validation/tests.
- Webhook handlers include signature verification and idempotency-style tests for Helcim and Square flows.
- Private DB stores operational records for checkout orders, payment events, appointment holds, training enrollments, marketing contacts/submissions, and consent events.
- Current unit tests include valuable privacy/payment boundaries, including tests that new marketing submissions no longer write to Sanity form documents and that scheduling tokens are stored only as hashes.
- `next.config.ts` enables React Compiler and restricts image remote patterns to Sanity CDN.

## Recommended codebase launch gate

Before declaring the staging-backed codebase production-ready, require all of the following:

1. `npm run lint`, `npm run test:unit`, full `npm test`, and `npm run build` pass from a clean working tree.
2. `VERCEL_ENV=preview node scripts/validate-sanity-env.mjs` passes with staging-scoped variables for the approved staging deployment.
3. The staging Sanity schema matches source and staging content is complete for products, services, booking settings, global settings, menus, and training programs.
4. The staging Sanity dataset no longer contains live/private submission documents, or those documents are formally archived outside the public/editorial CMS boundary with access controls and retention policy.
5. Signed Sanity webhook delivery is tested against staging and proves page freshness after publish.
6. Product checkout, training checkout, service booking hold/checkout/return, Helcim webhook, Square webhook, contact form, and training inquiry are smoke-tested end-to-end with private DB verification.
7. Mobile navigation, contact page heading hierarchy, booking landmarks, and checkout CTAs pass browser and accessibility smoke checks.
8. Any in-progress Square/training invoice work is completed and verified, or kept out of the release branch if it is not part of launch.
9. After the codebase gate passes, complete `docs/production-readiness-migration-plan.md` before replacing the production environment or production Sanity dataset.
