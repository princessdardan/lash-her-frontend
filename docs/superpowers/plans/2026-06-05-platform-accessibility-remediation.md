# Accessibility Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate critical accessibility barriers by replacing auto-rotating content, ensuring all images have meaningful alt text, creating reusable accessible async state components, and establishing continuous automated and manual validation.

**Architecture:** The plan introduces accessible async state wrappers and reduced-motion hooks, deprecates the auto-rotating hero carousel in favor of a static server-rendered hero, then adds an AI-assisted Sanity alt-text plugin and batch processing for legacy images. Automated axe-core E2E tests in CI are paired with scheduled manual audits and user testing.

**Tech Stack:** React, Sanity plugin API, Playwright, `@axe-core/playwright`, Google Cloud Vision API, WCAG 2.1.

---

**Source:** docs/platform-comprehensive-after-action-review.md  
**Master Spec:** docs/superpowers/specs/2026-06-05-platform-remediation-master-design.md

## Implementation Metadata

| Field                                      | Value                                                                                                                      |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| **Category**                               | Accessibility                                                                                                              |
| **Source AAR Issues**                      | 4.1–4.4                                                                                                                    |
| **Estimated Duration**                     | 2 weeks (Phase 3 + Phase 4)                                                                                                |
| **Required Sub-Skill for Agentic Workers** | React accessibility patterns, Sanity plugin development, Playwright E2E testing, screen reader basics, WCAG 2.1 guidelines |

---

## Files to Create

| File                                             | Purpose                                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `src/components/ui/async-state.tsx`              | Reusable accessible async state wrapper                                                                       |
| `src/components/ui/visually-hidden.tsx`          | Visually hidden text for screen readers                                                                       |
| `src/hooks/use-reduced-motion.ts`                | Detects `prefers-reduced-motion`                                                                              |
| `src/components/custom/layouts/static-hero.tsx`  | Static hero block (server component)                                                                          |
| `src/sanity/plugins/auto-alt/index.ts`           | Sanity plugin for auto alt generation                                                                         |
| `src/sanity/plugins/auto-alt/auto-alt-action.ts` | Document action to trigger alt generation                                                                     |
| `src/app/api/sanity/auto-alt/route.ts`           | Server-only protected API route that calls Vision; Studio plugin calls this route and never holds credentials |
| `tests/a11y.spec.ts`                             | axe-core Playwright spec for key pages                                                                        |
| `tests/fixtures/axe-fixture.ts`                  | Custom Playwright fixture with axe builder                                                                    |
| `docs/accessibility/audit-template.md`           | Template for quarterly manual audits                                                                          |
| `docs/accessibility/user-testing-template.md`    | Template for semi-annual user testing                                                                         |

## Files to Modify

| File                                                    | Change                                                                        |
| ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `src/sanity/schemas/objects/layout/hero-section.ts`     | Add `staticHero` variant; deprecate carousel                                  |
| `src/sanity/schemas/documents/product.ts`               | Require `alt` on image fields                                                 |
| `src/sanity/schemas/documents/service.ts`               | Require `alt` on image fields                                                 |
| `src/components/ui/sanity-image.tsx`                    | Add fallback alt chain                                                        |
| `src/components/booking/booking-flow.tsx`               | Use `AsyncState` wrapper                                                      |
| `src/components/custom/layouts/hero-carousel.tsx`       | Add reduced motion support; prepare for deprecation                           |
| `src/components/custom/contact-popup/contact-popup.tsx` | Add reduced motion support                                                    |
| `src/app/api/webhooks/sanity-asset-upload/route.ts`     | Server-side webhook to trigger alt generation (alternative: manual alt audit) |
| `package.json`                                          | Add `@axe-core/playwright` dev dependency                                     |
| `.github/workflows/ci.yml`                              | Add accessibility test job                                                    |

---

## Ordered Tasks

### Phase 1: AsyncState and Reduced Motion (Week 1)

#### Task 1.1: Create AsyncState component

- [ ] Create `src/components/ui/async-state.tsx`:
  - Props: `status`, `loadingText`, `errorText`, `children`
  - `ref` with `tabIndex={-1}` for focus management
  - `aria-live="polite"`, `aria-busy={status === 'loading'}`, `role="status"`
  - On error: `useEffect` focuses the ref
  - Render loading text, error text, or children based on status
- [ ] Create `src/components/ui/visually-hidden.tsx`:
  - CSS-only visually hidden span (clip, absolute, 1px)
- [ ] Verify with unit test: focus moves to error; aria attributes correct

#### Task 1.2: Apply AsyncState to booking flow

- [ ] Modify `src/components/booking/booking-flow.tsx`:
  - Wrap availability loading with `AsyncState`
  - Wrap hold creation with `AsyncState`
  - Wrap error states with `AsyncState`
- [ ] Verify: screen reader announces loading and errors

#### Task 1.3: Create reduced motion hook

- [ ] Create `src/hooks/use-reduced-motion.ts`:
  - `useState(false)` + `useEffect`
  - `matchMedia('(prefers-reduced-motion: reduce)')`
  - Cleanup listener on unmount
- [ ] Verify: returns `true` when macOS "Reduce Motion" is enabled

#### Task 1.4: Apply reduced motion to carousel and popup

- [ ] Modify `src/components/custom/layouts/hero-carousel.tsx`:
  - Use `useReducedMotion()`
  - If reduced motion: disable auto-rotation, show static first slide
  - Transitions are instant
- [ ] Modify `src/components/custom/contact-popup/contact-popup.tsx`:
  - Use `useReducedMotion()`
  - If reduced motion: popup appears instantly (no fade/slide)
- [ ] Verify: animations disabled when reduced motion is on

---

### Phase 2: Static Hero (Week 1)

#### Task 2.1: Create static hero component

- [ ] Create `src/components/custom/layouts/static-hero.tsx`:
  - Server component (no `"use client"`)
  - Accepts `image`, `title`, `cta` props
  - Uses `SanityImage` with priority loading
  - Single editorially chosen image (no rotation)
- [ ] Verify: renders correctly with valid CMS data

#### Task 2.2: Add static hero to schema

- [ ] Modify `src/sanity/schemas/objects/layout/hero-section.ts`:
  - Add `staticHero` object type with `image`, `title`, `ctaUrl`, `ctaLabel`
  - Mark `heroCarousel` as deprecated in description
- [ ] Deploy schema: `npx sanity schema deploy`
- [ ] Verify: Studio shows both options; static hero is recommended

#### Task 2.3: Update homepage content

- [ ] In Sanity Studio, replace homepage hero carousel with static hero
- [ ] Verify: homepage shows static hero; no auto-rotation

---

### Phase 3: Alt Text Generation (Week 2)

#### Task 3.1: Set up Google Cloud Vision API

- [ ] Create Google Cloud project or use existing
- [ ] Enable Cloud Vision API
- [ ] Create service account with `roles/vision.viewer`
- [ ] Store service account credentials only in server-side Vercel environment variables; never expose them to Sanity Studio or browser bundles
- [ ] Verify: API key works with test image

#### Task 3.2: Create alt generation service

- [ ] Create `src/lib/cms/auto-alt.ts`:
  - `generateAlt(imageUrl)` calls Vision API `images:annotate`
  - Extracts label annotations; builds description string
  - Returns `{ alt: string, confidence: number }`
- [ ] Verify: test with sample Sanity image URL

#### Task 3.3: Create Sanity plugin

- [ ] Create `src/app/api/sanity/auto-alt/route.ts`:
  - Validates an admin-only secret or authenticated Studio session
  - Accepts `{ imageUrl }`
  - Calls `generateAlt(imageUrl)` on the server
  - Returns `{ alt, confidence }`
- [ ] Create `src/sanity/plugins/auto-alt/index.ts`:
  - `definePlugin` with document action for `sanity.imageAsset`
  - Action button: "Generate alt text"
  - On click: fetch image URL, POST it to `/api/sanity/auto-alt`, update asset metadata with the returned alt text
- [ ] Create `src/sanity/plugins/auto-alt/auto-alt-action.ts`:
  - Document action implementation
- [ ] Register plugin in `sanity.config.ts`
- [ ] Verify: plugin appears in Studio for image assets and no Vision credentials appear in client-side JavaScript bundles

#### Task 3.4: Batch process existing images

- [ ] Create script `scripts/batch-generate-alt.ts`:
  - Queries all Sanity image assets without alt
  - Calls `generateAlt` for each
  - Updates asset metadata with generated alt
  - Logs progress and errors
- [ ] Run script against staging dataset first
- [ ] Review generated alt text for quality
- [ ] Run against production dataset
- [ ] Verify: all images have alt text in Studio

#### Task 3.5: Update schema to require alt

- [ ] Modify `src/sanity/schemas/documents/product.ts`:
  - Add `validation: (Rule) => Rule.required()` to image `alt` fields
- [ ] Modify `src/sanity/schemas/documents/service.ts`:
  - Same as product
- [ ] Modify `src/sanity/schemas/objects/layout/hero-section.ts`:
  - Same for hero image alt
- [ ] Deploy schema
- [ ] Verify: Studio blocks publish if alt is missing

---

### Phase 4: axe CI and Manual Audit (Week 2)

#### Task 4.1: Install axe-core Playwright

- [ ] `npm install -D @axe-core/playwright`
- [ ] Create `tests/fixtures/axe-fixture.ts`:
  - Custom fixture extending base Playwright test
  - Provides `axe` builder instance
- [ ] Verify: fixture loads without errors

#### Task 4.2: Create accessibility E2E spec

- [ ] Create `tests/a11y.spec.ts`:
  - Test pages: `/`, `/services`, `/training-programs`, `/contact`
  - For each page: `AxeBuilder({ page }).analyze()`
  - Assert `violations.length === 0`
- [ ] Verify: tests pass with zero violations

#### Task 4.3: Add accessibility job to CI

- [ ] Modify `.github/workflows/ci.yml`:
  - Add `a11y` job running `npx playwright test tests/a11y.spec.ts`
  - Install Playwright browsers: `npx playwright install chromium`
  - Job fails on violations
- [ ] Verify: CI passes with zero violations

#### Task 4.4: Schedule manual audit

- [ ] Create `docs/accessibility/audit-template.md`:
  - WCAG 2.1 checklist (perceivable, operable, understandable, robust)
  - Keyboard navigation test steps
  - Screen reader test steps (NVDA, VoiceOver)
  - Color contrast check
- [ ] Schedule first audit for 3 months after axe CI is stable
- [ ] Identify external auditor or train internal QA

#### Task 4.5: Plan user testing

- [ ] Create `docs/accessibility/user-testing-template.md`:
  - Recruitment criteria (3–5 users with disabilities)
  - Task list (book service, buy product, contact form)
  - Observation checklist
  - Feedback form
- [ ] Budget: ~$500–$1000 per round for participant compensation
- [ ] Schedule first round for 6 months after launch of static hero and AsyncState

---

## Verification Commands

```bash
# Build
npm run build

# Lint
npm run lint

# Unit tests
npm run test:unit

# E2E tests
npm test

# Accessibility tests specifically
npx playwright test tests/a11y.spec.ts

# Sanity schema deploy
npx sanity schema deploy

# Manual reduced motion check
# Enable "Reduce Motion" in OS settings
# Verify: no auto-rotation, instant transitions
```

---

## Rollout Gates

| Gate | Criteria                                                 | Owner              |
| ---- | -------------------------------------------------------- | ------------------ |
| G1   | AsyncState wraps all async flows in booking and checkout | Frontend dev       |
| G2   | Reduced motion disables all non-essential animations     | Frontend dev       |
| G3   | Static hero renders on homepage; carousel deprecated     | Content / frontend |
| G4   | All new image uploads have auto-generated alt            | Backend / CMS      |
| G5   | Schema requires alt; legacy images batch-processed       | CMS                |
| G6   | axe CI passes with zero violations on key pages          | QA                 |
| G7   | Manual audit scheduled; user testing budget approved     | Product / QA       |

---

## Notes and Cautions

1. **Alt Text Quality**: AI-generated alt text is a starting point, not a final product. Editors must review and refine. Do not rely solely on auto-generation for critical images.
2. **Schema Required Validation**: Making `alt` required may break existing drafts. Notify content team before deploying schema changes. Provide a grace period for updating legacy content.
3. **Reduced Motion Scope**: `prefers-reduced-motion` should disable motion that could cause vestibular issues (parallax, auto-rotation, zoom). Micro-interactions (button hover states) may remain if subtle.
4. **axe-core Limitations**: axe catches ~30% of accessibility issues. It will not find keyboard trap, focus order problems, or screen reader pronunciation issues. Manual testing is essential.
5. **User Testing Recruitment**: Recruit users with diverse disabilities (visual, motor, cognitive). Avoid testing only with screen reader users — keyboard-only and voice control users have different needs.
6. **Sanity Plugin Permissions**: The auto-alt plugin needs access to update asset metadata. Ensure the Studio user role has `edit` permissions on `sanity.imageAsset`.
7. **Schema Deploy Guard**: Production schema deploy requires `SANITY_SCHEMA_DEPLOY_TARGET=production`. Always deploy to staging first and verify Studio behavior before production.
