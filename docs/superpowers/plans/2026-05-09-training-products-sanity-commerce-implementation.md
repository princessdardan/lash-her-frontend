# Training Program and Product Commerce Implementation Plan

> **Historical note (2026-05-17):** This plan predates the shared private PII storage docs. Current private DB guidance supersedes any checkout-only wording and keeps new form/contact/marketing/consent records out of Sanity.

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` for implementation and `superpowers:executing-plans` for task tracking. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Model constraint:** Do not use Claude models for any implementation, review, design, planning, or subagent work on this plan. Use non-Claude agents/models only.

**Goal:** Implement a Sanity-editable redesigned training program experience, product catalog page, and product info page in the `booking-helcim-integration` worktree while preserving the existing booking and Helcim security boundaries.

**Architecture:** Extend the existing Next.js 16 App Router + Sanity + Helcim branch. Sanity owns editable content. `frontend/src/data/loaders.ts` remains the only read boundary. Public pages stay under `frontend/src/app/(site)`. Helcim payment initialization and validation remain server-owned through the existing commerce routes and helpers.

**Tech Stack:** Next.js 16 App Router, React 18, TypeScript strict, Sanity v4/next-sanity, Tailwind v4 CSS-first tokens, Framer Motion/Motion where already present, Helcim v2 API, HelcimPay.js, Playwright E2E, `tsx --test` unit tests.

> **Superseded checkout-storage boundary:** Before implementing any checkout-related work from this plan, follow `docs/superpowers/plans/2026-05-10-private-checkout-storage-security-remediation.md`. Checkout storage is no longer a product/training TBD: it must use private server-side storage, not public Sanity documents or Studio Orders.

---

## Status and Blocker

This plan is intentionally blocked for any still-unanswered training/content-model/payment changes. The product route decision is clarified: public product routes use `/products`, product details use `/products/[slug]`, and the prior shop routes are deleted.

## Current Worktree Facts

- Worktree: `/Users/dardan/Documents/lash-her/.worktrees/booking-helcim-integration`
- Product catalog route: `frontend/src/app/(site)/products/page.tsx`
- Product detail route: `frontend/src/app/(site)/products/[slug]/page.tsx`
- Product confirmation route: `frontend/src/app/(site)/products/confirmation/page.tsx`
- Existing product schema: `frontend/src/sanity/schemas/documents/product.ts`
- Legacy/current-risk order schema slated for removal or unregistration by the 2026-05-10 private checkout storage remediation plan: `frontend/src/sanity/schemas/documents/checkout-order.ts`
- Existing commerce UI: `frontend/src/components/commerce/product-card.tsx`, `frontend/src/components/commerce/cart-panel.tsx`, `frontend/src/components/commerce/helcim-pay-button.tsx`
- Existing training detail route: `frontend/src/app/(site)/training-programs/[slug]/page.tsx`
- Existing training schema: `frontend/src/sanity/schemas/documents/training-program.ts`
- Existing loader boundary: `frontend/src/data/loaders.ts`

## Locked Scope To Fill After Clarification

Before Task 1, replace every `TBD` with the approved answer.

- Redesigned training surface: `TBD: /training, /training-programs/[slug], or both`
- Product catalog route: `/products`
- Product info route: `/products/[slug]`
- Product catalog launch mode: `TBD: browse-only, cart checkout, buy-now, inquiry, mixed`
- Training payment mode: `TBD: none, booking-call only, deposit, full payment, invoice/manual follow-up`
- Inventory mode: `TBD: manual availability only, stock counts, variants, no inventory`
- Fulfillment mode: `TBD: pickup, shipping, digital/manual, service/training only`
- Product schema strategy: `TBD: extend product or introduce additional documents/objects`
- Training schema strategy: `TBD: explicit fields, blocks, or hybrid`
- SEO strategy: `TBD: reusable SEO object or simple fields`
- Seed content: `TBD: yes/no`
- Checkout storage: fixed by the 2026-05-10 remediation plan. Do not implement public Sanity `checkoutOrder` writes or Studio Orders exposure.

If any `TBD` remains, stop and ask the user.

---

## Task 1: Reconfirm Branch State and Install Context

**Files:**
- No source changes.

- [ ] **Step 1: Confirm worktree and branch**

Run from `/Users/dardan/Documents/lash-her/.worktrees/booking-helcim-integration`:

```bash
git status --short --branch
git log --oneline -5
```

Expected:
- Branch is `integration/booking-helcim` unless the user chose a new implementation branch.
- Working tree status is understood before editing.

- [ ] **Step 2: Re-read local guidance**

Read:

```text
AGENTS.md
frontend/AGENTS.md
frontend/src/app/AGENTS.md
frontend/src/sanity/AGENTS.md
frontend/src/components/custom/layouts/AGENTS.md
docs/lash-her-brand-kit.html
docs/superpowers/specs/2026-05-09-training-products-sanity-commerce-design.md
```

Expected:
- Implementer has local route, Sanity, CMS block, and design constraints loaded.

---

## Task 2: Update Tests First for Approved Behavior

**Files:**
- Modify/create based on approved routes:
  - `frontend/tests/training-programs.spec.ts`
  - `frontend/tests/training.spec.ts`
  - `frontend/tests/checkout.spec.ts`
  - `frontend/tests/product-catalog.spec.ts` if a new file is clearer
  - `frontend/tests/product-detail.spec.ts` if a new file is clearer

- [ ] **Step 1: Add training redesign expectations**

Write tests for the approved training surface:

- page loads without console errors,
- existing header/site shell remains present,
- redesigned details section renders Sanity-managed item titles/descriptions,
- active detail changes on click,
- progress indicator exists if auto-advance is approved,
- section image alt text is present,
- payment/booking CTA behavior matches approved scope.

Expected before implementation: tests fail for missing redesigned details content.

- [ ] **Step 2: Add product catalog expectations**

Write tests for the approved catalog route:

- route loads,
- catalog intro copy is Sanity-editable if a singleton page was approved,
- small product list renders,
- empty state renders when no public products exist,
- product cards link to the approved product detail route when detail pages are in scope,
- checkout/cart controls appear only if approved.

Expected before implementation: tests fail for missing detail links or missing Sanity-editable catalog fields.

- [ ] **Step 3: Add product detail expectations**

Write tests for the approved product detail route:

- known slug loads,
- missing slug returns not-found UI,
- title, description, price, images, and detail sections render from Sanity,
- metadata title/description are generated,
- add-to-cart/buy/inquiry CTA matches approved behavior,
- unavailable product behavior matches approved scope.

Expected before implementation: tests fail because no product detail route exists.

- [ ] **Step 4: Run focused failing tests**

Run from `frontend`:

```bash
npx playwright test tests/training-programs.spec.ts --project=chromium
npx playwright test tests/checkout.spec.ts --project=chromium
```

Add new spec files to the command if created.

Expected:
- Existing unrelated tests may pass or fail based on seed content.
- New expectations fail for missing implementation, not test syntax.

---

## Task 3: Extend Sanity Schemas for Approved Content Model

**Files:**
- Modify as approved:
  - `frontend/src/sanity/schemas/documents/training-program.ts`
  - `frontend/src/sanity/schemas/documents/product.ts`
  - `frontend/src/sanity/schemas/index.ts`
  - `frontend/src/sanity/structure/index.ts`
  - `frontend/src/sanity/sanity.config.ts` if a new singleton is approved
- Create only if approved:
  - `frontend/src/sanity/schemas/documents/product-catalog-page.ts`
  - `frontend/src/sanity/schemas/objects/shared/seo.ts`
  - `frontend/src/sanity/schemas/objects/shared/detail-item.ts`
  - `frontend/src/sanity/schemas/objects/shared/product-gallery-image.ts`

- [ ] **Step 1: Add explicit shared objects only for reusable content**

Use `defineType`, `defineField`, and `defineArrayMember`. Model semantics, not layout. Examples: `detailItem`, `seo`, `productGalleryImage`, not `leftColumnCard` or `blueProgressBlock`.

Expected:
- Shared objects are registered manually in `schemaTypes` only if created.

- [ ] **Step 2: Extend `trainingProgram`**

Add only approved fields. Candidate fields from the spec must not be added unless approved.

Expected:
- Program detail content can be edited without changing code.
- Existing documents remain readable.
- Existing required fields are not deleted.

- [ ] **Step 3: Extend `product`**

Add only approved fields for catalog/detail behavior.

Expected:
- Product cards and product detail page have sufficient editable data.
- Checkout-required fields remain authoritative: SKU, price, currency, availability.

- [ ] **Step 4: Add catalog singleton only if approved**

If approved, create `productCatalogPage` with editable title, description, hero/intro, empty-state copy, SEO, and optional featured/ordering controls.

Expected:
- Singleton is registered in `schemaTypes`, `structure`, and `singletonTypes`.

- [ ] **Step 5: Verify schema registry**

Run from `frontend`:

```bash
npm run lint
```

Expected:
- No schema/type import errors.

---

## Task 4: Update Types and GROQ Loaders

**Files:**
- `frontend/src/types/index.ts`
- `frontend/src/data/loaders.ts`
- `frontend/src/app/api/revalidate/route.ts`

- [ ] **Step 1: Add TypeScript shapes**

Add explicit interfaces for approved schema additions and keep them synchronized with GROQ projections.

Expected:
- No `as any`, `@ts-ignore`, or `@ts-expect-error`.

- [ ] **Step 2: Add or extend loaders**

Required loaders based on approved routes:

- `getProductCatalogPageData()` if a singleton is approved.
- `getProducts()` extended for approved card fields.
- `getProductBySlug(slug)` for product detail.
- `getAllProductSlugs()` for static params.
- `getTrainingProgramBySlug(slug)` extended for redesigned training fields.
- `getAllTrainingProgramSlugs()` filtered to defined slugs if needed.

Expected:
- Queries use projections only for fields required by components.
- Arrays include `_key`.
- Image projections include `asset`, `hotspot`, `crop`, and `alt` at minimum.
- SEO metadata fetches do not leak visual editing/stega artifacts if visual editing is later enabled.

- [ ] **Step 3: Update revalidation tags**

Add cache tags for any new singleton or product-related document type.

Expected:
- `TYPE_TAG_MAP` and loader tags stay aligned.
- Existing `revalidateTag(tag, { expire: 0 })` usage remains unchanged.

---

## Task 5: Build the Training Program Details Experience

**Files:**
- Modify as approved:
  - `frontend/src/app/(site)/training-programs/[slug]/page.tsx`
  - `frontend/src/app/(site)/training/page.tsx` if approved
- Create as needed:
  - `frontend/src/components/training/training-program-details.tsx`
  - `frontend/src/components/training/training-program-detail-tabs.tsx`
  - `frontend/src/components/training/training-program-summary-card.tsx`

- [ ] **Step 1: Create the interactive details component**

Translate the provided snippet into a Lash Her component:

- client boundary only around the interactive details section,
- active item state,
- progress state only if auto-advance is approved,
- click changes active item and resets progress,
- horizontal mobile item list if approved,
- keyboard-accessible buttons rather than clickable div-only cards,
- existing `SanityImage` for images.

Expected:
- Component is reusable for training program details and, if approved, product details.
- Styling uses current brand tokens/utilities.

- [ ] **Step 2: Compose the training detail page**

Use explicit sections from Sanity fields and preserve existing route metadata/static params patterns.

Expected:
- `notFound()` behavior remains for missing programs.
- Header/footer/site shell are unchanged.
- Existing `BlockRenderer` remains available if hybrid/block strategy is approved.

- [ ] **Step 3: Wire approved CTAs**

Add only approved CTA behavior: booking call, application form, checkout, deposit, or inquiry.

Expected:
- Helcim checkout is used only when approved and still validates server-side.

---

## Task 6: Build the Product Catalog Page

**Files:**
- Modify or replace as approved:
  - `frontend/src/app/(site)/products/page.tsx`
  - `frontend/src/components/commerce/product-card.tsx`
  - `frontend/src/components/commerce/cart-panel.tsx`
- Create only if approved:
  - `frontend/src/components/commerce/product-catalog.tsx`
  - `frontend/src/components/commerce/product-catalog-empty.tsx`
  - `frontend/src/components/commerce/product-catalog-header.tsx`

- [ ] **Step 1: Render catalog page content from Sanity**

If a catalog singleton is approved, load and render it. Otherwise derive page copy only from existing hard-coded fallbacks until the user approves a CMS source.

Expected:
- All approved visible catalog copy is editable in Sanity.

- [ ] **Step 2: Update product cards**

Product cards should show approved fields only and link to product detail pages if approved.

Expected:
- Small catalog layout works at mobile and desktop sizes.
- Cards remain accessible and avoid generic ecommerce clutter.

- [ ] **Step 3: Preserve checkout behavior**

If checkout remains active on catalog cards, keep existing `CartPanel`/`HelcimPayButton` server flow and adjust UI only as approved.

Expected:
- Client never controls authoritative price or availability.

---

## Task 7: Build the Product Info Page

**Files:**
- Create route based on approved path:
  - `frontend/src/app/(site)/products/[slug]/page.tsx`
- Create components as needed:
  - `frontend/src/components/commerce/product-detail.tsx`
  - `frontend/src/components/commerce/product-detail-gallery.tsx`
  - `frontend/src/components/commerce/product-detail-actions.tsx`

- [ ] **Step 1: Add dynamic route**

Use Next 16 async params style, `generateMetadata`, and `generateStaticParams` like the training detail page.

Expected:
- Missing product returns `notFound()`.
- Slugs are generated from published product documents.

- [ ] **Step 2: Render approved product fields**

Render title, description, image/gallery, price, availability, detail sections, and any approved product facts.

Expected:
- All visible product information is Sanity-editable.

- [ ] **Step 3: Wire approved product CTA**

Use approved CTA behavior: add-to-cart, buy-now, inquiry, booking, or no checkout.

Expected:
- Payment behavior uses existing Helcim APIs only through server routes.

---

## Task 8: Sanity Studio Editing and Content QA

**Files:**
- `frontend/src/sanity/structure/index.ts`
- `frontend/src/sanity/sanity.config.ts`
- Optional seed/migration files only if approved.

- [ ] **Step 1: Organize Studio sections**

Ensure editors can find:

- training page singleton,
- training programs,
- product catalog page singleton if approved,
- purchasable products.

Do not expose checkout orders in Sanity Studio. Studio sections are limited to public catalog and editorial content; checkout reconciliation belongs in private server-side PostgreSQL storage.

Expected:
- Singleton document IDs match schema type names.
- No duplicate singleton templates.

- [ ] **Step 2: Seed or migrate content only if approved**

If approved, create safe seed content instructions or scripts. Do not run production migrations casually.

Expected:
- Local testing has enough Sanity content for Playwright.

---

## Task 9: Verification

**Files:**
- No source changes unless fixing issues caused by implementation.

- [ ] **Step 1: LSP diagnostics**

Run diagnostics on every changed TypeScript/TSX file.

Expected:
- No diagnostics caused by this work.

- [ ] **Step 2: Unit tests**

Run from `frontend`:

```bash
npm run test:unit
```

Expected:
- Commerce/booking helper tests pass.

- [ ] **Step 3: Focused Playwright tests**

Run from `frontend` with approved/new tests:

```bash
npx playwright test tests/training-programs.spec.ts --project=chromium
npx playwright test tests/checkout.spec.ts --project=chromium
```

Expected:
- Training, catalog, product detail, and checkout behaviors pass with seeded/mocked content.

- [ ] **Step 4: Lint and build**

Run from `frontend`:

```bash
npm run lint
npm run build
```

Expected:
- Both exit 0, or pre-existing unrelated failures are documented with exact output.

- [ ] **Step 5: Manual QA**

Use a browser against the local dev server:

- approved training page(s),
- product catalog route,
- product detail route,
- checkout/CTA behavior if approved,
- mobile viewport,
- desktop viewport,
- Sanity Studio editing paths.

Expected:
- Header and existing hero system are not unintentionally restyled.
- Detail interactions are keyboard and pointer accessible.
- Images have alt text.
- Payment path does not expose secrets.

---

## Stop Conditions

Stop and ask the user if any of these occur:

- a locked `TBD` remains,
- requested behavior conflicts with the existing Helcim security boundary,
- Sanity production content shape is unknown and a migration would be required,
- product inventory/fulfillment rules are unclear,
- route naming conflicts with existing navigation or SEO expectations,
- implementation would require changing global header/hero styling beyond the requested pages.
- any step would store checkout orders, customer PII, checkout tokens, Helcim invoice IDs, Helcim transaction IDs, encrypted secret tokens, or reconciliation records in public Sanity or expose them in Studio.

## Expected Commit Sequence After Approval

Do not commit unless explicitly requested by the user.

Suggested sequence if commits are requested later:

1. `docs: add training and product commerce specs`
2. `test: define training and product page expectations`
3. `feat: extend sanity models for training and products`
4. `feat: add redesigned training program details`
5. `feat: add product catalog content editing`
6. `feat: add product detail pages`
7. `test: cover training and product commerce pages`
