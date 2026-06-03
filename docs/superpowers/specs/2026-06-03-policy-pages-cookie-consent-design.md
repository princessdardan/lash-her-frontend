# Policy Pages And Cookie Consent Design

## Purpose

Add a reusable public route for legal and policy pages, and add a sitewide cookie consent experience that supports explicit analytics opt-in for Canadian and equivalent privacy/compliance expectations.

Lash Her by Nataliea is a Canadian company. The website already uses functional storage/cookies for core user experience, and analytics/tracking cookies are a planned addition. The implementation must distinguish required functional storage from optional analytics/tracking storage.

## Current Context

The app is a Next.js 16 App Router project. Public routes live under `src/app/(site)`. The public site shell is `src/app/(site)/layout.tsx`; the root layout is `src/app/layout.tsx`.

Sanity stores public/editorial content only. Private form/contact, marketing, consent, checkout, payment, booking hold, and training enrollment data belongs in PostgreSQL. Policy and legal copy is public/editorial content, so it is appropriate for Sanity.

All Sanity reads must go through `src/data/loaders.ts`. Cache tags in that file must stay aligned with `TYPE_TAG_MAP` in `src/app/api/revalidate/route.ts`.

The site already has:

- Sanity document schemas under `src/sanity/schemas/documents`.
- Shared CMS types in `src/types/index.ts`.
- Portable Text rendering through `src/components/ui/portable-text-renderer.tsx`.
- Footer navigation managed by Sanity global settings.
- Vercel Analytics currently rendered unconditionally from `src/app/layout.tsx`.
- Vercel Speed Insights also rendered from `src/app/layout.tsx`.
- Functional localStorage/cookie usage for cart, contact popup dismissal, booking OAuth state, and checkout/booking flows.

## Goals

- Create a generic policy/legal page route for privacy policy, booking policy, return policy, refund policy, cookie policy, FAQ, terms, and future policy pages.
- Make policy/legal page copy editable in Sanity Studio.
- Keep consent enforcement and analytics gating owned by application code, not CMS content.
- Require explicit visitor opt-in before Vercel Analytics or future analytics/tracking scripts load.
- Keep required functional cookies/storage available because they support site functionality.
- Avoid adding legal copy that could be mistaken for reviewed compliance language.
- Preserve existing visual language: quiet luxury, editorial restraint, existing tokens and layout patterns.

## Non-Goals

- No legal advice or publish-ready policy language.
- No geolocation-based consent behavior in this pass.
- No consent record persistence in PostgreSQL for anonymous cookie choices.
- No granular marketing-provider integration beyond gating Vercel Analytics and creating a clear future gate for analytics scripts.
- No changes to payment, booking, checkout, or private operational storage behavior.

## Decisions

### Policy Pages

Use a Sanity-managed `policyPage` collection document.

This is preferred over separate singleton documents because the site needs a generic and extensible route for many page types: privacy policy, cookie policy, booking policy, return policy, refund policy, FAQ, terms, and similar future pages.

Each `policyPage` has:

- `title`: public page title.
- `slug`: public slug under `/policies/[slug]`.
- `pageType`: semantic classification such as privacy, cookie, booking, return, refund, faq, terms, or general.
- `summary`: optional short intro and metadata fallback.
- `body`: Portable Text legal/editorial content.
- `seo`: optional metadata overrides and `noIndex` flag.

### Route Shape

Use `/policies/[slug]`.

Examples:

- `/policies/privacy-policy`
- `/policies/cookie-policy`
- `/policies/booking-policy`
- `/policies/return-policy`
- `/policies/refund-policy`
- `/policies/faq`

This keeps legal/editorial pages grouped and avoids collisions with existing top-level commerce, booking, training, and contact routes.

### FAQ

Model FAQ as `policyPage` with `pageType: "faq"` and Portable Text body for the initial release.

If structured FAQ rich results become necessary later, add an optional `faqItems` array and emit FAQ JSON-LD only when `pageType` is `faq`. That should be a separate enhancement so this pass remains focused.

### Cookie Consent

Use a code-owned consent banner rendered in the public site layout. The banner shows when the visitor has not made a consent choice.

Initial categories:

- Required: always active. Covers functional cookies/storage needed for cart, booking OAuth state, contact popup dismissal, checkout/session behavior, and other site functionality.
- Analytics: off until accepted. Covers Vercel Analytics and future analytics/tracking scripts.

Visitor choices:

- Accept analytics.
- Reject analytics.
- Manage choices, which expands a small explanation panel.

Consent state is stored client-side in localStorage with a versioned value. Client-only storage is enough for anonymous analytics opt-in gating. It avoids introducing private consent data unless the site later needs auditable consent records for identified users.

### Analytics Gate

Move Vercel Analytics behind a client consent gate. It must not render from the root layout before consent.

Keep Vercel Speed Insights unchanged unless implementation confirms it sets analytics/tracking cookies requiring the same opt-in. The user request specifically targets analytics tracking cookies.

### Starter Content

Do not seed policy or FAQ copy. The feature ships structure, rendering, and consent controls only. Editors or legal counsel add reviewed content in Sanity Studio.

## Architecture

Create the policy page document schema under `src/sanity/schemas/documents/policy-page.ts` and register it in `src/sanity/schemas/index.ts`.

Add typed frontend shape in `src/types/index.ts`.

Add policy page queries in `src/data/loaders.ts`:

- `getPolicyPageBySlug(slug, options)` for route rendering and metadata.
- `getAllPolicyPageSlugs()` for `generateStaticParams`.

Use cache tag `policyPage` for both loaders and add `policyPage: "policyPage"` to `TYPE_TAG_MAP` in `src/app/api/revalidate/route.ts`.

Create a reusable `PolicyPageContent` component that receives a `TPolicyPage` and renders the page shell, title, summary, last-updated date, and Portable Text body.

Create `src/app/(site)/policies/[slug]/page.tsx` with:

- `revalidate = 1800`.
- `generateStaticParams()` via `loaders.getAllPolicyPageSlugs()`.
- `generateMetadata()` via `loaders.getPolicyPageBySlug(slug, { stega: false })`.
- `notFound()` for missing documents.

Create a small consent helper in `src/lib/cookie-consent.ts` for parsing, serializing, and creating versioned consent choices. This keeps banner and analytics gate behavior consistent and testable.

Create `CookieConsentBanner` as a client component under `src/components/legal/cookie-consent-banner.tsx`.

Create `ConsentedAnalytics` as a client component under `src/components/analytics/consented-analytics.tsx`.

Render the banner and analytics gate from `src/app/(site)/layout.tsx`. Remove unconditional Vercel Analytics rendering from `src/app/layout.tsx`.

## Data Flow

Policy page request flow:

1. Visitor requests `/policies/privacy-policy`.
2. Route receives `slug` from params.
3. Route calls `loaders.getPolicyPageBySlug(slug)`.
4. Loader queries Sanity for `_type == "policyPage" && slug.current == $slug`.
5. Missing document calls `notFound()`.
6. Existing document renders through `PolicyPageContent` and `PortableTextRenderer`.

Consent flow:

1. Public site layout renders `CookieConsentBanner` and `ConsentedAnalytics`.
2. Banner reads localStorage key `lh_cookie_consent` on mount.
3. If no valid versioned choice exists, banner appears.
4. Accept analytics stores `{ required: true, analytics: true, version: 1, decidedAt }`.
5. Reject analytics stores `{ required: true, analytics: false, version: 1, decidedAt }`.
6. Save dispatches `lh-cookie-consent-updated`.
7. `ConsentedAnalytics` listens for that event and `storage` events.
8. `ConsentedAnalytics` renders `<Analytics />` only when analytics consent is true.

## Error Handling

- Missing policy documents return the site 404 through `notFound()`.
- Metadata fetching returns empty metadata for missing policy documents.
- Invalid or unknown consent localStorage values are treated as undecided, so the banner appears again.
- Consent helper rejects malformed JSON, wrong versions, missing `required: true`, and non-boolean analytics values.
- The banner must tolerate `localStorage` access errors by showing the banner and allowing buttons to attempt saving again.

## Accessibility And UX

- Banner is fixed near the bottom of the viewport and should not fully block mobile browsing.
- Banner uses a clear accessible label and keyboard-accessible buttons.
- Manage choices expands explanatory text for required and analytics categories.
- Policy page layout uses semantic `<article>`, clear heading structure, and readable line lengths.
- Links in policy body continue to use the existing Portable Text link renderer.

## Testing

Unit tests:

- Consent parsing returns null for missing values.
- Consent parsing returns null for invalid JSON.
- Consent parsing accepts valid analytics consent.
- Consent choice creation always sets required true and version 1.

Browser tests:

- Cookie banner appears when no consent is stored.
- Reject analytics hides the banner and persists rejection.
- Reload after rejection does not show the banner.
- Accept analytics hides the banner and persists analytics consent.
- Manage choices reveals category explanation text.
- Policy route behavior handles missing pages without crashing.

Verification commands:

```bash
npm run lint
npx tsx --test src/components/legal/cookie-consent.test.ts
npx playwright test tests/cookie-consent.spec.ts tests/policy-pages.spec.ts --project=chromium
```

Optionally run `npm run build` if local Sanity environment variables are configured for the current environment.

## Open Questions Resolved

- Policy/legal pages are Sanity-managed.
- Consent behavior is code-managed.
- Analytics loads only after explicit opt-in.
- No starter legal copy is included.
