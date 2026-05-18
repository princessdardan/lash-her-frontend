# Training Program and Product Commerce Design Spec

> **Historical note (2026-05-17):** This design predates the shared private PII storage docs. Current private DB guidance supersedes any checkout-only wording and keeps new form/contact/marketing/consent records out of Sanity.

Date: 2026-05-09
Status: Draft partially clarified; training/content-model scope remains blocked on user clarification

> **Superseded checkout-storage boundary:** Checkout storage/security guidance in this spec is superseded by `docs/superpowers/plans/2026-05-10-private-checkout-storage-security-remediation.md`. Sanity remains the public catalog/editorial CMS only. Checkout orders, customer PII, checkout tokens, payment reconciliation records, Helcim invoice identifiers, Helcim transaction identifiers, and encrypted Helcim secret tokens must not be stored in a public Sanity dataset or exposed through Sanity Studio.

## Purpose

Design three Sanity-editable public surfaces in the `booking-helcim-integration` worktree:

- a redesigned training program page,
- a small product catalog page,
- a product info/detail page.

Products and training programs remain distinct content types. Both must be compatible with the existing Helcim payment boundary, but this spec does not assume what each surface sells, how inventory works, or whether checkout is active on launch until those choices are confirmed.

## Source Context

This work targets `/Users/dardan/Documents/lash-her/.worktrees/booking-helcim-integration`.

Relevant implemented surfaces already exist in that worktree:

- `frontend/src/app/(site)/training/page.tsx`
- `frontend/src/app/(site)/training-programs/[slug]/page.tsx`
- `frontend/src/app/(site)/products/page.tsx`
- `frontend/src/app/(site)/products/[slug]/page.tsx`
- `frontend/src/app/(site)/products/confirmation/page.tsx`
- `frontend/src/data/loaders.ts`
- `frontend/src/types/index.ts`
- `frontend/src/sanity/schemas/documents/training-program.ts`
- `frontend/src/sanity/schemas/documents/sellable-product.ts`
- Legacy/current-risk order schema slated for removal or unregistration by the 2026-05-10 private checkout storage remediation plan: `frontend/src/sanity/schemas/documents/checkout-order.ts`
- `frontend/src/components/commerce/product-card.tsx`
- `frontend/src/components/commerce/cart-panel.tsx`
- `frontend/src/lib/commerce/*`

Design and implementation must also respect:

- `docs/lash-her-brand-kit.html`
- `docs/superpowers/specs/2026-05-04-helcimpay-design.md`
- `docs/booking-helcim-implementation-summary.md`

## Existing Architecture Boundary

- Sanity owns editable marketing/catalog content, product/training details, imagery, SEO, display order, and visible availability text.
- Next.js server components load Sanity data through `frontend/src/data/loaders.ts`.
- Client components may handle interactions such as the referenced auto-advancing details section, cart state, or Helcim modal launch.
- Helcim owns secure payment collection and payment records.
- Checkout reconciliation records are private server-side records stored in a PostgreSQL database, not Sanity documents, not public CMS content, and not Studio-editable records.

No Helcim API token, checkout `secretToken`, price authority, inventory authority, or payment-status authority may move into client code.

## Visual Direction

Use the attached training-page image only as a broad reference for section composition: editorial nav rhythm, dark premium hero moments, product/program detail blocks, pricing/enrollment panels, and restrained form/card layout.

Do not restyle the global header, existing hero section system, or other site shell elements to resemble the attached image. New sections must fit the existing Lash Her brand-kit direction and current worktree UI, not introduce a parallel visual language.

The provided React `Features` snippet is a reference for the product/program details section interaction only:

- left-side selectable details,
- timed progress indicator,
- active item image on the right,
- mobile horizontal scrolling behavior,
- user click resets the active detail.

The implementation must translate this pattern into Lash Her semantics and existing UI tokens instead of copying the AI-mentor copy, sky-blue palette, or dark-mode-specific styling.

## Training Program Page Model

The current `trainingProgram` document is block-only:

- `title`
- `description`
- `slug`
- `blocks`

The redesigned training program page needs structured, editor-friendly fields instead of forcing every program detail into generic portable text. Candidate fields must remain blocked until confirmed:

- hero summary fields,
- program detail items for the interactive details section,
- product/program deliverables or kit inclusions,
- schedule/duration/location/level/investment facts,
- enrollment CTA settings,
- payment/deposit settings,
- booking-call link settings,
- image gallery/detail images,
- FAQ/curriculum outcomes,
- SEO metadata.

The design should preserve existing `blocks` only if the user confirms that program pages should stay block-composable. Otherwise, the implementation should migrate to explicit program-detail fields with any legacy `blocks` kept read-only/deprecated only when existing production content requires it.

## Product Catalog Model

The current `sellableProduct` schema supports a minimal checkout catalog:

- `title`
- `description`
- `slug`
- `sku`
- `kind`
- `price`
- `currency`
- `isAvailable`
- `image`

The requested product catalog page requires a richer editable catalog model only if confirmed. Candidate additions include:

- short description versus long description,
- product detail sections,
- gallery images,
- display order,
- featured flag,
- categories/collections,
- badges,
- related products,
- inventory/stock messaging,
- variant/options model,
- shipping/pickup notes,
- tax/shipping eligibility flags,
- SEO metadata.

The catalog is small, so the default plan should avoid pagination, heavy filtering, account features, and a complex inventory subsystem unless explicitly approved.

## Product Info Page Model

The product info page should be a dynamic route for one product document. The approved public route is `/products/[slug]`.

The detail page should load a single `sellableProduct` by slug, use `notFound()` when unavailable or missing, generate metadata from Sanity fields, and keep checkout actions server-validated through the existing Helcim flow.

## Sanity Content Modeling Guidance

Official Sanity and real-world ecommerce patterns support this default shape:

- Use document types for independently editable entities such as products, categories, collections, and training programs.
- Use singleton documents for page-level catalog copy, global settings, navigation, and other one-off editorial surfaces.
- Use references when content is reusable or independently filterable; use nested objects when content belongs only to one product/program.
- Query by `slug.current`, project only fields used by the component, and include `_key` for arrays.
- Enable `hotspot` on editorial/product images and query alt text consistently.
- Add a reusable SEO object only if product/training pages need per-document metadata overrides.

Reference material:

- Sanity schema basics: `https://www.sanity.io/docs/apis-and-sdks/introduction-to-schemas`.
- Sanity slug type: `https://www.sanity.io/docs/slug-type`.
- Sanity image type: `https://www.sanity.io/docs/image-type`.
- Sanity + Next.js App Router guidance: `https://www.sanity.io/docs/nextjs/introduction`.
- Sanity visual editing with App Router: `https://www.sanity.io/docs/visual-editing/visual-editing-with-next-js-app-router`.
- Sanity SEO course: `https://www.sanity.io/learn/course/seo-optimization/seo-schema-types-and-metadata`.
- Real-world Sanity ecommerce product schema example: `https://github.com/sanity-io/demo-ecommerce/blob/63371030ac892bad8089d8a07c64ff3424ea6f86/packages/sanity/src/schema/documents/product.tsx`.
- Real-world product/variant object example: `https://github.com/sanity-io/demo-ecommerce/blob/63371030ac892bad8089d8a07c64ff3424ea6f86/packages/sanity/src/schema/objects/productWithVariant.tsx`.

For Lash Her's small catalog, the first implementation should default to `sellableProduct` plus optional singleton page content, not a larger category/variant system, unless the user confirms categories, variants, independent inventory, or collection pages are needed.

## Helcim Boundary

Existing Helcim design remains authoritative:

- Server reloads authoritative Sanity product data before creating invoices.
- Client-provided totals, names, SKUs, quantities, availability, or payment status are untrusted.
- Browser receives only `checkoutToken`.
- `secretToken` stays server-side, is never stored raw, and if persisted is encrypted only in the private checkout datastore defined by the 2026-05-10 remediation plan.
- Payment success is accepted only after hash and semantic validation.

Official Helcim guidance supports this boundary:

- HelcimPay.js initialization must happen from a secure backend server, not client-side code: `https://devdocs.helcim.com/docs/initialize-helcimpayjs`.
- The browser should render the Helcim payment modal with a `checkoutToken`, while the returned `secretToken` is used for backend validation: `https://devdocs.helcim.com/docs/initialize-helcimpayjs`.
- Payments should be validated with HelcimPay.js transaction validation before the app marks a reconciliation record paid: `https://devdocs.helcim.com/docs/validate-helcimpayjs`.
- Hosted Payment Pages are a no-code alternative, but they are weaker fit for a custom Sanity-owned catalog and editorial product detail flow: `https://devdocs.helcim.com/docs/hosted-payment-pages`.
- Helcim Payment API documentation emphasizes payment transactions and card-token/card-data handling rather than acting as a storefront catalog source: `https://devdocs.helcim.com/docs/payments`.

Open Helcim decisions must be answered before implementation changes payment behavior:

- whether training programs are paid in full, deposit-only, or inquiry/book-call first,
- whether products use immediate checkout, inquiry-only, or mixed CTA behavior,
- whether tax, discounts, shipping, pickup, ACH, Fee Saver, partial payments, refunds, saved cards, or customer pre-linking are in scope,
- whether training programs should create `sellableProduct` records, reference sellable products, or use a distinct `trainingProgram` payment config.

## Content Editing Requirements

All visible public copy, section headings, product/program descriptions, images, pricing labels, CTA labels, availability display text, SEO title/description/images, and product/program detail items must be editable in Sanity Studio.

Sanity Studio editability applies only to public catalog, training, product, and editorial content. It does not include checkout orders, reconciliation records, payment metadata, Helcim invoice or transaction identifiers, checkout tokens, encrypted secret tokens, or customer PII.

Implementation should not hard-code live content except fallback empty-state copy and developer-only error copy.

## Acceptance Criteria

- Training program detail pages can render the redesigned program detail sections from Sanity-managed content.
- Product catalog page renders the small Sanity-managed catalog with editorial cards and empty state.
- Product info page renders one Sanity-managed product by slug with metadata and image handling.
- Existing header, hero component contract, site shell, footer, and global navigation are not restyled merely to match the reference image.
- Existing checkout server-side validation remains authoritative.
- Public Sanity schema additions are mirrored in TypeScript types, GROQ projections, Studio structure, cache tags, route metadata, and tests.
- Any page with missing required content uses the project’s existing `notFound()` or empty-state conventions.
- Browser tests cover catalog rendering, product detail rendering, and the training details interaction.

## Required Clarifications

Implementation must not begin for still-unanswered scope areas until these are answered. Product route questions 2 and 3 are answered by the 2026-05-09 route decision.

### Routes

1. Is the redesigned training page the listing page `/training`, the detail route `/training-programs/[slug]`, or both?
2. What route should the product catalog use? Answered: `/products`.
3. What route should product info pages use? Answered: `/products/[slug]`.
4. Should product detail URLs include unavailable/draft products for preview only, or hide unavailable products publicly?

### Training UX and Content

5. Which sections from the reference image should exist on training detail pages?
6. Should the existing training hero remain unchanged, or should the detail page hero be redesigned within the current component system?
7. What exact program facts are required: format, duration, location, level, investment, kit, certification, curriculum, prerequisites, model practice, aftercare/support?
8. Should the interactive details section auto-advance exactly like the snippet, pause on hover/focus, or only advance manually?
9. What images should be editable per detail item: one image per detail, shared gallery, or both?
10. Should training programs include application forms, booking-call CTAs, direct checkout CTAs, or multiple CTAs?

### Product UX and Content

11. What product types are in the small catalog: physical retail items, training kits, digital products, services, deposits, or a mix?
12. Should the catalog page include cart/checkout immediately, or browse-only product cards linking to product detail pages?
13. Should product detail pages include add-to-cart, buy-now, inquiry, or booking CTA behavior?
14. Do products need variants such as size, color, style, kit tier, or quantity packs?
15. Do products need categories, filters, sorting, featured products, related products, or display order?
16. Do products need inventory counts, low-stock messaging, sold-out messaging, or only a manual available/unavailable toggle?
17. Are products shipped, picked up in studio, delivered digitally, or fulfilled manually after purchase?
18. What product fields are mandatory for launch versus nice-to-have?

### Pricing and Helcim

19. Are all prices CAD-only for launch?
20. Are training program prices paid through Helcim now, later, or not at all?
21. If training uses Helcim, is payment full amount, deposit, installment, invoice request, or manual follow-up?
22. Should products and training share the existing `sellableProduct` checkout path, or should training have separate payment configuration?
23. Are taxes, discounts, shipping, pickup fees, ACH, Fee Saver, partial payments, refunds, saved payment methods, or customer records in scope?
24. Should successful product/training payment send a branded email, create internal notifications, or only show the existing confirmation page?

### Sanity Studio

25. Should product catalog page content be a singleton document, fields on global settings, or derived entirely from product documents?
26. Should training detail pages remain block-composable or use explicit fields?
27. Should `trainingProgramsPage` be wired into a route/loader or removed/deprecated later?
28. Should SEO be a reusable object added to training programs and products?
29. Should editors be able to reorder products manually?

### Implementation Constraints

30. Should this work preserve the existing checkout implementation and refactor it onto `/products`, or replace it with a new catalog/detail architecture? Partially answered for routes: the prior shop route is deleted and public product routes use `/products`.
31. Should implementation include content migrations or only schema additions for new content entry?
32. Should the first implementation include seed/example Sanity documents for local testing?
33. Should visual regression screenshots be created for desktop and mobile?
34. Are there any existing Sanity production documents that must not be disrupted?

## Explicit Non-Goals Until Approved

- Do not build a general inventory management system.
- Do not use Helcim as the product catalog or inventory source.
- Do not expose Helcim secrets or trust client-side pricing.
- Do not store checkout transaction history, customer PII, payment reconciliation records, checkout tokens, Helcim invoice/transaction IDs, or encrypted Helcim secret tokens in public Sanity or expose them through Studio.
- Do not add customer accounts.
- Do not add refunds, subscriptions, ACH-specific flows, Fee Saver, shipping calculators, or discount engines.
- Do not restyle existing global header/hero/site shell to match the attached image.
- Do not collapse products and training programs into one content type unless explicitly approved.
