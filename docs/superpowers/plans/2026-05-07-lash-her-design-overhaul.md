# Lash Her Brand Kit Design Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` for implementation and `superpowers:executing-plans` for task tracking. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Model constraint:** Do not use Claude models for any implementation, review, or design-subagent work on this plan. Use non-Claude agents/models only.

**Goal:** Redesign the Lash Her frontend into a white-background, editorial quiet-luxury experience using `docs/lash-her-brand-kit.html` as the visual source of truth. Brand colors must be accents, not page-wide defaults: Royal Mulberry `#663976`, Midnight Espresso `#1C1318`, Antique Champagne `#D4B483`, Black Cherry `#3D0B16`, and Dusty Silk `#E8E2E9`.

**Design Direction:** Sleek editorial luxury with bold, restrained accents. The redesign should not be a simple restyle: core layout components should become more spacious, asymmetrical, typographic, and conversion-focused while avoiding generic beauty-site pinks, red/pink gradients, glitter, crowded badges, and loud CTA language.

**Architecture:** The implementation replaces legacy pink/red visual semantics with brand-kit tokens in Tailwind v4 CSS-first theming, updates Next font loading to the brand fonts, centralizes reusable section/card/button/form patterns, and redesigns the CMS-driven block system, navigation, footer, gallery, forms, and page states around white surfaces with selective Dusty Silk panels and Midnight Espresso editorial moments.

**Tech Stack:** Next.js 16 App Router, React 18, TypeScript strict, Tailwind CSS v4 via `globals.css`, Radix UI primitives, class-variance-authority, Motion, Sanity CMS blocks, Playwright E2E.

---

## Brand source of truth

Use `docs/lash-her-brand-kit.html` for all design choices.

### Locked palette

| Role | Name | Hex | Usage |
|---|---|---:|---|
| Page base | White | `#FFFFFF` | Default page and body background. Required. |
| Primary accent | Royal Mulberry | `#663976` | Primary buttons, active nav, focus rings, selected states, icons. |
| Primary text / dark editorial | Midnight Espresso | `#1C1318` | Main text, dark hero panels, footer, overlays. |
| Luxury highlight | Antique Champagne | `#D4B483` | Thin dividers, badges, luxury labels, CTA highlights. Never long text on white. |
| Conversion accent | Black Cherry | `#3D0B16` | Hover states, special CTAs, training emphasis. Use sparingly. |
| Soft surface | Dusty Silk | `#E8E2E9` | Cards, forms, booking/contact panels, calm negative space. |

### Locked typography

- `Cormorant Garamond`: display headlines, H1/H2, service titles, large quotes.
- `Cormorant SC`: eyebrow labels, category tags, nav accents, badges.
- `Inter`: body copy, buttons, forms, captions, pricing, instructions.

### Locked layout rules

- Default background must be white.
- Use 24px as the base spacing unit for cards and section interiors.
- Use 56–96px vertical spacing between major desktop sections and 28–44px on mobile.
- Use 18–28px radii for cards and panels.
- Prefer thin borders and typographic hierarchy over heavy shadows.
- Reserve dark sections for hero moments, footer, premium CTA panels, and contrast breaks.

---

## Existing project findings

- Tailwind is CSS-first in `frontend/src/app/globals.css`; there is no `tailwind.config.*`.
- The current visual system uses legacy pink/red/gold tokens: `brand-pink`, `brand-red`, `brand-more-pink`, `brand-hot-pink`, `brand-dark-red`, `brand-gold`, and `brand-cream`.
- Current fonts are loaded in `frontend/src/app/layout.tsx`: Montserrat, Cardo, Luxurious Script, and Playfair Display. These conflict with the brand kit.
- Repeated visual classes are spread across CMS blocks and forms: `bg-brand-pink`, `text-brand-red`, `border-brand-red`, `.section-container-pink`, `.btn-primary-red`, `.btn-hero`, and `.hero-heading*`.
- Several global effects violate the new direction and should be removed or replaced: `.text-lift*`, `.mask-gradient` where it creates harsh gallery treatment, thick red borders, and heavy text-shadow CTA styles.
- The active redesign surface includes CMS blocks in `frontend/src/components/custom/layouts`, UI primitives in `frontend/src/components/ui`, forms in `frontend/src/components/custom/collection`, routes in `frontend/src/app/(site)`, and global theme/layout files.

---

## First-release scope locked by this plan

- Redesign only the existing frontend app in `frontend`.
- Keep Sanity schema fields, data loaders, server actions, and form submission behavior functionally unchanged unless a visual component requires a presentational prop or class change.
- Keep the CMS block registry contract in `block-renderer.tsx` intact.
- Keep the site background white by default at `body` and major page wrapper levels.
- Use brand colors as accents and controlled editorial moments, not broad all-page fills.
- Replace legacy pink/red token usage in visible UI.
- Preserve accessibility: visible focus states, keyboard navigation, form labels/errors, alt text behavior, and responsive layouts.
- Do not add ecommerce, booking, CMS schema, or copywriting scope unless explicitly required for visual completion.

If any of these locked choices are not acceptable, stop before Task 1 and revise this plan.

---

## File structure

### Primary modify targets

- `frontend/src/app/globals.css` — brand tokens, typography utilities, reusable section/card/form/button classes, remove legacy effects.
- `frontend/src/app/layout.tsx` — replace font loading with Cormorant Garamond, Cormorant SC, and Inter.
- `frontend/src/app/(site)/layout.tsx` — verify skip link and page shell align with white-background system.
- `frontend/src/app/(site)/loading.tsx` — restyle loading state.
- `frontend/src/app/(site)/not-found.tsx` — restyle error/empty state.
- `frontend/src/app/(site)/global-errors.tsx` — restyle global error state.

### Shared UI primitives

- `frontend/src/components/ui/button.tsx` — add brand-kit variants and sizes.
- `frontend/src/components/ui/input.tsx` — Dusty Silk/white field styling and Royal Mulberry focus.
- `frontend/src/components/ui/textarea.tsx` — match input styling.
- `frontend/src/components/ui/select.tsx` — match field styling.
- `frontend/src/components/ui/label.tsx` — Inter labels with smallcaps option where appropriate.
- `frontend/src/components/ui/field.tsx` — calm error/help text styles.
- `frontend/src/components/ui/separator.tsx` — Antique Champagne divider style.
- `frontend/src/components/ui/sheet.tsx` — mobile menu surface and overlay styling.
- `frontend/src/components/ui/navigation-menu.tsx` — editorial desktop dropdown styling.
- `frontend/src/components/ui/mobile-navigation.tsx` — mobile menu hierarchy and CTA treatment.
- `frontend/src/components/ui/logo.tsx` — wordmark/monogram styling using the brand typography direction.
- `frontend/src/components/ui/portable-text-renderer.tsx` — editorial rich-text rhythm and marker/link colors.

### Layout and CMS block components

- `frontend/src/components/custom/layouts/header.tsx` — desktop header content and CTA treatment.
- `frontend/src/components/custom/layouts/header-wrapper.tsx` — white/translucent header behavior and scroll states.
- `frontend/src/components/custom/layouts/fallback-header.tsx` — fallback header styling.
- `frontend/src/components/custom/layouts/footer.tsx` — Midnight Espresso footer.
- `frontend/src/components/custom/layouts/block-animation-wrapper.tsx` — soften scroll animation.
- `frontend/src/components/custom/layouts/block-renderer.tsx` — keep registry, update skeleton fallback if needed.
- `frontend/src/components/custom/layouts/hero-section.tsx` — editorial hero redesign.
- `frontend/src/components/custom/layouts/features-section.tsx` — services/features card redesign.
- `frontend/src/components/custom/layouts/cta-features-section.tsx` — training/service CTA card redesign.
- `frontend/src/components/custom/layouts/image-with-text.tsx` — asymmetrical image/copy sections.
- `frontend/src/components/custom/layouts/info-section.tsx` — rich editorial information sections.
- `frontend/src/components/custom/layouts/gallery.tsx` — editorial gallery treatment.
- `frontend/src/components/custom/layouts/schedule.tsx` — refined schedule panel.
- `frontend/src/components/custom/layouts/contact-info.tsx` — dark contact card option and refined details.
- `frontend/src/components/custom/cta-feature.tsx` — align standalone CTA feature card.

### Form and contact experiences

- `frontend/src/components/custom/collection/general-inquiry.tsx` — general inquiry visual redesign.
- `frontend/src/components/custom/collection/contact-components.tsx` — training/contact form visual redesign.
- `frontend/src/components/custom/contact-content.tsx` — ensure contact layout composition supports new two-column treatment.

### Test and QA targets

- `frontend/tests` — update visual selectors only if required by class/text changes; do not weaken behavioral coverage.
- `frontend/playwright.config.ts` — no planned change.

---

## Task 1: Replace global brand tokens and fonts

**Files:**
- Modify: `frontend/src/app/globals.css`
- Modify: `frontend/src/app/layout.tsx`

- [ ] **Step 1: Replace font loading**

  In `frontend/src/app/layout.tsx`, remove Montserrat, Cardo, Luxurious Script, and Playfair Display imports/usages. Load these Google fonts from `next/font/google`:

  - `Cormorant_Garamond` with variable `--font-cormorant-garamond`, weights `400`, `500`, `600`, styles `normal` and `italic`.
  - `Cormorant_SC` with variable `--font-cormorant-sc`, weights `400`, `500`, `600`.
  - `Inter` with variable `--font-inter`, weights `300`, `400`, `500`, `600`, `700`.

  Apply all three variables to the `<body>` class.

- [ ] **Step 2: Replace Tailwind theme mappings**

  In `globals.css`, update `@theme inline` to expose brand-kit tokens and semantic tokens. Required utilities should include:

  - `--color-lh-white`
  - `--color-lh-primary`
  - `--color-lh-shadow`
  - `--color-lh-light`
  - `--color-lh-accent`
  - `--color-lh-neutral`
  - `--color-lh-muted`
  - `--color-lh-line`
  - `--color-background`
  - `--color-foreground`
  - `--font-display`
  - `--font-smallcaps`
  - `--font-body`

- [ ] **Step 3: Define root design tokens**

  Set `:root` values from the brand kit:

  ```css
  --lh-white: #FFFFFF;
  --lh-primary: #663976;
  --lh-shadow: #1C1318;
  --lh-light: #D4B483;
  --lh-accent: #3D0B16;
  --lh-neutral: #E8E2E9;
  --lh-neutral-2: #F5F1F5;
  --lh-muted: #746A72;
  --lh-line: rgba(28, 19, 24, 0.14);
  --lh-primary-soft: rgba(102, 57, 118, 0.12);
  --lh-light-soft: rgba(212, 180, 131, 0.22);
  --lh-accent-soft: rgba(61, 11, 22, 0.12);
  --background: #FFFFFF;
  --foreground: #1C1318;
  --radius: 18px;
  ```

- [ ] **Step 4: Remove legacy visual tokens**

  Remove or stop exporting legacy pink/red/chrome tokens that no longer map to brand meaning: `--brand-hot-pink`, `--brand-pink`, `--brand-more-pink`, `--brand-red`, `--brand-dark-red`, `--chrome-*`, and script-font variables. Do not keep misleading semantic names that point to new colors.

- [ ] **Step 5: Reset base styling**

  Ensure `body` is `bg-background text-foreground font-body`, with white background as the default. Update global focus-visible styling to Royal Mulberry.

- [ ] **Step 6: Verify global token compile**

  Run from `frontend`:

  ```bash
  npm run lint
  ```

  Expected: no lint errors from font imports, class names, or CSS syntax.

---

## Task 2: Replace global component utility classes

**Files:**
- Modify: `frontend/src/app/globals.css`

- [ ] **Step 1: Remove old decorative effects**

  Delete `.text-lift`, `.text-lift-subtle`, `.text-lift-red`, `.text-lift-subtle-red`, `.text-lift-dynamic`, `.text-lift-subtle-dynamic`, `.text-lift-brand`, and the old `.btn-hero` text-shadow treatment.

- [ ] **Step 2: Add editorial section utilities**

  Replace `.section-container-pink` and `.section-container-cream` with semantic utilities:

  - `.section-shell` for white sections with 56–96px desktop spacing.
  - `.section-shell-soft` for Dusty Silk panels.
  - `.section-shell-dark` for Midnight Espresso sections.
  - `.content-container` with a max width close to the brand kit `1180px`.

- [ ] **Step 3: Add typography utilities**

  Replace `.section-heading-red`, `.hero-heading`, and `.hero-heading-home` with:

  - `.eyebrow-label`: Cormorant SC, uppercase, wide tracking, Royal Mulberry or Antique Champagne depending on surface.
  - `.display-heading`: Cormorant Garamond italic 500, oversized editorial scale.
  - `.section-heading`: Cormorant Garamond 500 H2 scale.
  - `.body-lead`: Inter 16–18px, readable line-height.

- [ ] **Step 4: Add card and panel utilities**

  Replace `.card-white`, `.card-feature`, `.section-richtext`, and repeated border-red card styles with:

  - `.editorial-card`: white surface, thin `lh-line` border, 18–28px radius, minimal shadow.
  - `.soft-panel`: Dusty Silk surface with white inner fields/cards.
  - `.dark-panel`: Midnight Espresso surface with Dusty Silk text and Antique Champagne details.
  - `.accent-rule`: thin Antique Champagne divider.

- [ ] **Step 5: Add form utilities**

  Replace `.form-input`, `.form-textarea`, `.contact-label`, `.schedule-day`, and `.schedule-time` with brand-kit-aligned classes using Dusty Silk/white fields and Royal Mulberry focus states.

- [ ] **Step 6: Search for removed utility usage**

  Run from repo root:

  ```bash
  rg --line-number "text-lift|section-container-pink|section-heading-red|hero-heading|btn-hero|btn-primary-red|brand-pink|brand-red|brand-more-pink|brand-hot-pink|brand-dark-red" frontend/src
  ```

  Expected: no remaining production UI usages, except in deleted-code diffs or intentional compatibility comments if absolutely necessary.

---

## Task 3: Redesign shared UI primitives

**Files:**
- Modify: `frontend/src/components/ui/button.tsx`
- Modify: `frontend/src/components/ui/input.tsx`
- Modify: `frontend/src/components/ui/textarea.tsx`
- Modify: `frontend/src/components/ui/select.tsx`
- Modify: `frontend/src/components/ui/label.tsx`
- Modify: `frontend/src/components/ui/field.tsx`
- Modify: `frontend/src/components/ui/separator.tsx`
- Modify: `frontend/src/components/ui/sheet.tsx`
- Modify: `frontend/src/components/ui/portable-text-renderer.tsx`

- [ ] **Step 1: Add brand button variants**

  Update `buttonVariants` to support the brand-kit roles:

  - `primary`: Royal Mulberry fill, white text.
  - `dark`: Midnight Espresso fill, Dusty Silk text.
  - `luxury`: Antique Champagne fill, Midnight Espresso text.
  - `accent`: Black Cherry fill, Dusty Silk or white text.
  - `ghost`: transparent, Black Cherry or Royal Mulberry border/text.
  - `link`: understated text link with Royal Mulberry hover.

  Use pill radii for high-priority CTAs and keep transition motion subtle.

- [ ] **Step 2: Redesign form primitives**

  Update inputs, textareas, selects, labels, field errors, and helper text so forms use calm white/Dusty Silk surfaces, Royal Mulberry focus rings, clear error contrast, and Inter body/UI type.

- [ ] **Step 3: Redesign separator**

  Make separators thin and editorial, using `lh-line` by default and Antique Champagne where a luxury accent is requested.

- [ ] **Step 4: Redesign sheet/mobile menu primitives**

  Update sheet surfaces, overlay, close button, and spacing for an editorial mobile navigation panel.

- [ ] **Step 5: Redesign portable text**

  Update rich text headings, links, list markers, blockquote, and paragraph spacing to use Cormorant/Inter and brand accents without champagne-on-white low contrast.

- [ ] **Step 6: Verify primitive types**

  Run diagnostics on changed files and lint:

  ```bash
  npm run lint
  ```

  Expected: no TypeScript or lint errors.

---

## Task 4: Redesign header, navigation, logo, and footer

**Files:**
- Modify: `frontend/src/components/ui/logo.tsx`
- Modify: `frontend/src/components/ui/navigation-menu.tsx`
- Modify: `frontend/src/components/ui/mobile-navigation.tsx`
- Modify: `frontend/src/components/custom/layouts/header.tsx`
- Modify: `frontend/src/components/custom/layouts/header-wrapper.tsx`
- Modify: `frontend/src/components/custom/layouts/fallback-header.tsx`
- Modify: `frontend/src/components/custom/layouts/footer.tsx`
- Modify: `frontend/src/app/main-menu.tsx`

- [ ] **Step 1: Redesign logo treatment**

  Keep the existing SVG available if needed, but style the visible identity to behave like the brand-kit lockup: “Lash Her” as an elegant serif signature and “by Nataliea” as a smaller wide-tracked smallcaps detail. Ensure a screen-reader label remains present.

- [ ] **Step 2: Redesign header shell**

  Use a white or translucent-white header after scroll, Midnight Espresso text, subtle `lh-line` border, and no black/pink hard switch. Keep scroll-hide behavior if it remains smooth and useful.

- [ ] **Step 3: Redesign desktop navigation**

  Keep navigation short and breathable. “Book Now” should be the only filled nav button. Use Royal Mulberry for active states and small Antique Champagne details only where contrast is safe.

- [ ] **Step 4: Redesign dropdown menus**

  Use white popovers, thin borders, editorial spacing, and clear hover/focus states. Avoid pink hover panels.

- [ ] **Step 5: Redesign mobile navigation**

  Use a white/Dusty Silk sheet with clear link hierarchy, subtle dividers, and a single filled CTA.

- [ ] **Step 6: Redesign footer**

  Use Midnight Espresso as the footer surface, Dusty Silk text, Antique Champagne dividers/details, and calm link hover states. Preserve social links and credits.

- [ ] **Step 7: Verify navigation accessibility**

  Keyboard-test menu triggers, dropdown links, mobile sheet open/close, focus states, and skip link visibility.

---

## Task 5: Redesign CMS layout blocks

**Files:**
- Modify: `frontend/src/components/custom/layouts/block-animation-wrapper.tsx`
- Modify: `frontend/src/components/custom/layouts/block-renderer.tsx`
- Modify: `frontend/src/components/custom/layouts/hero-section.tsx`
- Modify: `frontend/src/components/custom/layouts/features-section.tsx`
- Modify: `frontend/src/components/custom/layouts/cta-features-section.tsx`
- Modify: `frontend/src/components/custom/layouts/image-with-text.tsx`
- Modify: `frontend/src/components/custom/layouts/info-section.tsx`
- Modify: `frontend/src/components/custom/layouts/gallery.tsx`
- Modify: `frontend/src/components/custom/layouts/schedule.tsx`
- Modify: `frontend/src/components/custom/layouts/contact-info.tsx`
- Modify: `frontend/src/components/custom/cta-feature.tsx`

- [ ] **Step 1: Soften block animation**

  Keep scroll entrance animation but make it understated: short fade with slight upward translation, no bouncy or aggressive motion. Respect reduced-motion behavior if present or add it if missing.

- [ ] **Step 2: Update block skeleton**

  Update `BlockSkeleton` from gray utility styling to a white/Dusty Silk shimmer or static placeholder that fits the new system.

- [ ] **Step 3: Redesign hero section**

  Create two hero treatments:

  - Homepage: editorial full-height hero with photography, Midnight Espresso/Black Cherry overlay, oversized Cormorant Garamond italic headline, Antique Champagne or Royal Mulberry CTA accents, and generous whitespace.
  - Internal pages: shorter editorial banner with dark overlay, crisp title hierarchy, and restrained CTA grouping.

- [ ] **Step 4: Redesign features section**

  Replace centered pink sections with white editorial sections, thin Champagne rules, generous card spacing, Cormorant card titles, and Royal Mulberry icon/category accents.

- [ ] **Step 5: Redesign CTA features section**

  Make service/training cards feel premium: tall cards, structured metadata, smallcaps labels, most-popular badge in Antique Champagne or Royal Mulberry, one clear CTA per card, Black Cherry hover only for special emphasis.

- [ ] **Step 6: Redesign image-with-text**

  Use asymmetrical layouts, large photography crops, image overlaps or offset panels where appropriate, white background, and Dusty Silk copy cards.

- [ ] **Step 7: Redesign info section**

  Use editorial rich text with improved measure, heading scale, and readable Inter body copy. Avoid boxed content unless the content needs a panel.

- [ ] **Step 8: Redesign gallery**

  Replace the current pink carousel-heavy treatment with an editorial gallery direction. Preferred first release: large-crop responsive grid or masonry-like composition with quiet captions and optional category labels. If preserving the existing carousel component is necessary, restyle it to remove harsh masks and pink/red pagination.

- [ ] **Step 9: Redesign schedule and contact info**

  Use a refined two-panel system: schedule on white/Dusty Silk, contact info as a dark Midnight Espresso card with Antique Champagne dividers and clear accessible links.

- [ ] **Step 10: Verify CMS block rendering**

  Ensure no block registry keys change, unknown blocks still fail safely, and all blocks render with existing Sanity data shapes.

---

## Task 6: Redesign contact and training forms

**Files:**
- Modify: `frontend/src/components/custom/collection/general-inquiry.tsx`
- Modify: `frontend/src/components/custom/collection/contact-components.tsx`
- Modify: `frontend/src/components/custom/contact-content.tsx`

- [ ] **Step 1: Redesign general inquiry layout**

  Use a white page section, a Dusty Silk or white form panel, editorial heading area, and a calm Royal Mulberry submit CTA. Preserve existing validation, server action calls, touched-field behavior, and status messages.

- [ ] **Step 2: Redesign training contact form**

  Match the general form system while allowing training-specific emphasis through Royal Mulberry hierarchy and limited Black Cherry accents.

- [ ] **Step 3: Redesign status and error messages**

  Keep messages clear and accessible. Style success with a calm positive treatment and errors with strong contrast, but do not introduce loud red/pink panels.

- [ ] **Step 4: Preserve form accessibility**

  Keep `aria-invalid`, `aria-describedby`, labels, live regions, required fields, and keyboard submission behavior intact.

- [ ] **Step 5: Verify form behavior**

  Run relevant Playwright tests or manually test both forms in local dev if tests do not cover them.

---

## Task 7: Redesign page states and route shells

**Files:**
- Modify: `frontend/src/app/(site)/layout.tsx`
- Modify: `frontend/src/app/(site)/loading.tsx`
- Modify: `frontend/src/app/(site)/not-found.tsx`
- Modify: `frontend/src/app/(site)/global-errors.tsx`
- Review: `frontend/src/app/(site)/page.tsx`
- Review: `frontend/src/app/(site)/contact/page.tsx`
- Review: `frontend/src/app/(site)/gallery/page.tsx`
- Review: `frontend/src/app/(site)/training/page.tsx`
- Review: `frontend/src/app/(site)/training-programs/[slug]/page.tsx`

- [ ] **Step 1: Verify route shell background**

  Ensure route layouts and page wrappers do not force legacy pink, cream, black, or red backgrounds. The default visible page background must be white.

- [ ] **Step 2: Restyle loading state**

  Use white background, Royal Mulberry or Midnight Espresso loader, and restrained copy.

- [ ] **Step 3: Restyle not-found state**

  Use editorial typography, calm recovery CTA, and brand-kit accents.

- [ ] **Step 4: Restyle global error state**

  Use accessible error messaging with Black Cherry as a limited accent, not a full loud red treatment.

- [ ] **Step 5: Verify page composition**

  Visit home, contact, gallery, training, and a training-program detail page to confirm sections flow with consistent spacing and no legacy backgrounds.

---

## Task 8: Remove legacy styling usage across the frontend

**Files:**
- Modify as needed across `frontend/src/**/*.tsx` and `frontend/src/app/globals.css`

- [ ] **Step 1: Search legacy tokens and classes**

  Run from repo root:

  ```bash
  rg --line-number "brand-(red|pink|more-pink|hot-pink|dark-red|cream|gold|grey)|chrome-|text-lift|section-container-pink|btn-primary-red|btn-hero|hero-heading" frontend/src
  ```

- [ ] **Step 2: Replace remaining visual usages**

  Replace each remaining legacy visual usage with semantic brand-kit utilities. Do not map old names to new colors as a shortcut.

- [ ] **Step 3: Search hardcoded colors**

  Run from repo root:

  ```bash
  rg --line-number --glob '*.{tsx,ts,css}' "#[0-9A-Fa-f]{3,8}|oklch\(" frontend/src
  ```

  Expected: raw color values should be isolated to `globals.css` token declarations unless there is a clear browser/API reason.

- [ ] **Step 4: Contrast review**

  Manually check all Antique Champagne text usages. Champagne must not be used as long body text on white.

---

## Task 9: Responsive, interaction, and browser QA

**Files:**
- No planned source target; fix issues in affected components.

- [ ] **Step 1: Run lint**

  From `frontend`:

  ```bash
  npm run lint
  ```

  Expected: exit 0.

- [ ] **Step 2: Run build**

  From `frontend`:

  ```bash
  npm run build
  ```

  Expected: exit 0.

- [ ] **Step 3: Run Playwright suite**

  From `frontend`:

  ```bash
  npm test
  ```

  Expected: exit 0 or only pre-existing failures documented with evidence.

- [ ] **Step 4: Manual responsive QA**

  Test at minimum:

  - 390px mobile width.
  - 768px tablet width.
  - 1024px desktop width.
  - 1440px large desktop width.

  Verify no horizontal overflow, clipped hero copy, broken nav, or unusable form layouts.

- [ ] **Step 5: Manual interaction QA**

  Verify hover/focus states, mobile sheet, dropdown navigation, form validation states, gallery controls, CTA links, and reduced-motion behavior.

- [ ] **Step 6: Visual acceptance review**

  Confirm final UI matches the brand-kit direction:

  - White is the dominant background.
  - Brand colors are accents.
  - Typography uses Cormorant Garamond, Cormorant SC, and Inter.
  - Layouts feel spacious, sleek, editorial, and premium.
  - No generic beauty-site pinks, neon/glitter, heavy 3D text, or crowded badges remain.

---

## Acceptance criteria

- The body and route-level page background are white by default.
- Legacy pink/red visual classes are removed from production UI.
- Brand-kit colors are implemented as semantic Tailwind v4 tokens in `globals.css`.
- Fonts match the brand kit and are loaded through `next/font/google`.
- Header, footer, navigation, CMS blocks, gallery, contact panels, and forms are redesigned, not merely recolored.
- CTAs are calm and polished, with “Book Now” or equivalent primary actions visually clear but not loud.
- Forms retain existing validation and submission behavior.
- Sanity block rendering contract remains stable.
- Lint, build, and relevant Playwright tests pass, or pre-existing failures are documented with command output.
- Manual QA confirms responsive layouts and keyboard accessibility.

---

## Risks and guardrails

- **Risk: misleading old token names.** Do not remap `brand-pink` or `brand-red` to new colors. Replace usages with new semantic classes.
- **Risk: low contrast.** Antique Champagne is a highlight, divider, or badge color. Avoid long champagne text on white.
- **Risk: over-darkening.** The user explicitly requires white background. Dark sections should be rare editorial moments.
- **Risk: over-styling.** Remove heavy text shadows, 3D effects, glitter-like treatments, and dense badges.
- **Risk: breaking CMS pages.** Do not change Sanity `_type` registry keys or required data shapes while restyling.
- **Risk: weakening tests.** Do not delete failing tests to pass; update only selectors made obsolete by intentional markup/class changes.

---

## Recommended implementation order

1. Task 1: global tokens and fonts.
2. Task 2: global utility cleanup.
3. Task 3: shared UI primitives.
4. Task 4: header/navigation/footer.
5. Task 5: CMS blocks.
6. Task 6: forms.
7. Task 7: page states.
8. Task 8: legacy cleanup.
9. Task 9: full QA.

Do not start component redesign before Task 1 is complete; the semantic token layer is the foundation for the rest of the work.
