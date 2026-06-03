# Policy Pages And Cookie Consent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Sanity-managed policy/legal pages and a sitewide explicit opt-in cookie consent gate for analytics.

**Architecture:** Public policy copy is modeled as a Sanity `policyPage` collection rendered at `/policies/[slug]` through centralized loaders. Cookie consent behavior remains code-owned: a public-layout client banner stores a versioned choice and a separate analytics gate renders Vercel Analytics only after analytics consent.

**Tech Stack:** Next.js 16 App Router, React 18, Sanity schema/GROQ, Portable Text, Vercel Analytics, Tailwind v4 tokens, Node test runner through `tsx`, Playwright.

---

## Scope

This plan implements `docs/superpowers/specs/2026-06-03-policy-pages-cookie-consent-design.md`.

Included:

- Sanity `policyPage` document collection.
- Generic `/policies/[slug]` route.
- Policy page renderer using existing Portable Text support.
- Centralized policy page loaders in `src/data/loaders.ts`.
- Cache tag alignment for Sanity revalidation.
- Client-side cookie consent helper and banner.
- Consent-gated Vercel Analytics rendering.
- Unit and focused Playwright coverage.

Excluded:

- Legal/policy starter copy.
- Geolocation-specific consent behavior.
- Server-side anonymous consent records.
- FAQ structured data enhancement.
- Changes to checkout, booking, cart, contact popup, or private DB behavior.

## File Structure

Create or modify these files:

- Create `src/sanity/schemas/documents/policy-page.ts`: Sanity collection schema for editable legal/policy pages.
- Modify `src/sanity/schemas/index.ts`: register the `policyPage` schema.
- Modify `src/types/index.ts`: add `TPolicyPageType` and `TPolicyPage`.
- Modify `src/data/loaders.ts`: add policy page GROQ projection and loader functions.
- Modify `src/app/api/revalidate/route.ts`: add the `policyPage` cache tag mapping.
- Create `src/components/legal/policy-page-content.tsx`: semantic policy page renderer.
- Create `src/app/(site)/policies/[slug]/page.tsx`: generic public route.
- Create `src/lib/cookie-consent.ts`: versioned consent parsing/serialization helpers.
- Create `src/components/legal/cookie-consent-banner.tsx`: public client consent banner.
- Create `src/components/analytics/consented-analytics.tsx`: client analytics consent gate.
- Modify `src/app/layout.tsx`: remove unconditional Vercel Analytics render.
- Modify `src/app/(site)/layout.tsx`: render consent banner and consented analytics for public site.
- Create `src/lib/cookie-consent.test.ts`: unit tests for consent helpers.
- Create `tests/cookie-consent.spec.ts`: Playwright coverage for consent UI persistence.
- Create `tests/policy-pages.spec.ts`: focused route safety coverage for policy pages.

---

## Task 1: Add Policy Page Schema And Types

**Files:**
- Create: `src/sanity/schemas/documents/policy-page.ts`
- Modify: `src/sanity/schemas/index.ts`
- Modify: `src/types/index.ts`
- Modify: `src/app/api/revalidate/route.ts`

- [ ] **Step 1: Create the Sanity document schema**

Create `src/sanity/schemas/documents/policy-page.ts` with:

```ts
import { DocumentTextIcon } from "@sanity/icons";
import { defineArrayMember, defineField, defineType } from "sanity";

const policyPageTypes = [
  { title: "Privacy Policy", value: "privacy" },
  { title: "Cookie Policy", value: "cookie" },
  { title: "Booking Policy", value: "booking" },
  { title: "Return Policy", value: "return" },
  { title: "Refund Policy", value: "refund" },
  { title: "FAQ", value: "faq" },
  { title: "Terms", value: "terms" },
  { title: "General", value: "general" },
];

export const policyPage = defineType({
  name: "policyPage",
  title: "Policy Page",
  type: "document",
  icon: DocumentTextIcon,
  groups: [
    { name: "content", title: "Content" },
    { name: "seo", title: "SEO" },
  ],
  fields: [
    defineField({
      name: "title",
      title: "Title",
      type: "string",
      group: "content",
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: "slug",
      title: "Slug",
      type: "slug",
      group: "content",
      options: { source: "title" },
      validation: (rule) =>
        rule.required().custom((slug) => {
          const value = slug?.current;
          if (!value) return "Slug is required.";
          return /^[a-z0-9-]+$/.test(value)
            ? true
            : "Use lowercase letters, numbers, and hyphens only.";
        }),
    }),
    defineField({
      name: "pageType",
      title: "Page Type",
      type: "string",
      group: "content",
      options: {
        list: policyPageTypes,
        layout: "radio",
      },
      initialValue: "general",
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: "summary",
      title: "Summary",
      type: "text",
      rows: 3,
      group: "content",
      description: "Short intro and metadata fallback.",
    }),
    defineField({
      name: "body",
      title: "Body",
      type: "array",
      group: "content",
      of: [
        defineArrayMember({
          type: "block",
          marks: {
            annotations: [
              {
                name: "link",
                title: "Link",
                type: "object",
                fields: [
                  defineField({
                    name: "href",
                    title: "URL",
                    type: "string",
                  }),
                  defineField({
                    name: "blank",
                    title: "Open in new tab",
                    type: "boolean",
                    initialValue: false,
                  }),
                ],
              },
            ],
          },
        }),
      ],
      validation: (rule) => rule.required().min(1),
    }),
    defineField({
      name: "seo",
      title: "SEO",
      type: "object",
      group: "seo",
      fields: [
        defineField({
          name: "title",
          title: "SEO Title",
          type: "string",
        }),
        defineField({
          name: "description",
          title: "SEO Description",
          type: "text",
          rows: 3,
        }),
        defineField({
          name: "noIndex",
          title: "Hide from search engines",
          type: "boolean",
          initialValue: false,
        }),
      ],
    }),
  ],
  preview: {
    select: {
      title: "title",
      subtitle: "slug.current",
    },
  },
});
```

- [ ] **Step 2: Register the schema**

Modify `src/sanity/schemas/index.ts`.

Add the import near collection documents:

```ts
import { policyPage } from "./documents/policy-page";
```

Add `policyPage` to `schemaTypes` after existing collection documents:

```ts
  policyPage,
```

- [ ] **Step 3: Add policy page TypeScript types**

Modify `src/types/index.ts` near page/document types:

```ts
export type TPolicyPageType =
  | "privacy"
  | "cookie"
  | "booking"
  | "return"
  | "refund"
  | "faq"
  | "terms"
  | "general";

export interface TPolicyPage {
  _id: string;
  _updatedAt?: string;
  title: string;
  slug: string;
  pageType: TPolicyPageType;
  summary?: string;
  body: TPortableTextBlock[];
  seo?: {
    title?: string;
    description?: string;
    noIndex?: boolean;
  };
}
```

- [ ] **Step 4: Add Sanity revalidation tag mapping**

Modify `src/app/api/revalidate/route.ts` and add this entry to `TYPE_TAG_MAP`:

```ts
  policyPage: "policyPage",
```

- [ ] **Step 5: Run lint**

Run:

```bash
npm run lint
```

Expected: `npm run lint` exits 0 or reports only pre-existing unrelated failures.

---

## Task 2: Add Policy Page Loaders

**Files:**
- Modify: `src/data/loaders.ts`

- [ ] **Step 1: Import the policy page type**

Modify the type import from `@/types` in `src/data/loaders.ts` to include:

```ts
  TPolicyPage,
```

- [ ] **Step 2: Add the policy page projection**

Add near other projection constants:

```ts
const POLICY_PAGE_PROJECTION = groq`{
  _id,
  _updatedAt,
  title,
  "slug": slug.current,
  pageType,
  summary,
  body[]{ ..., _key },
  "seo": {
    "title": coalesce(seo.title, title),
    "description": coalesce(seo.description, summary, ""),
    "noIndex": seo.noIndex == true
  }
}`;
```

- [ ] **Step 3: Add the single policy page loader**

Add near other page loaders:

```ts
async function getPolicyPageBySlug(
  slug: string,
  options: SanityFetchOptions = {},
): Promise<TPolicyPage | null> {
  const query = groq`*[_type == "policyPage" && slug.current == $slug][0]${POLICY_PAGE_PROJECTION}`;
  return sanityFetch<TPolicyPage | null>(query, { slug }, ["policyPage"], options);
}
```

- [ ] **Step 4: Add the policy page slugs loader**

Add near other static-param loaders:

```ts
async function getAllPolicyPageSlugs(): Promise<Array<{ slug: string }>> {
  const query = groq`*[_type == "policyPage" && defined(slug.current)]{ "slug": slug.current }`;
  return sanityFetch<Array<{ slug: string }>>(query, {}, ["policyPage"], {
    mode: "published",
    stega: false,
  });
}
```

- [ ] **Step 5: Export both loader functions**

Add these functions to the exported `loaders` object:

```ts
  getPolicyPageBySlug,
  getAllPolicyPageSlugs,
```

- [ ] **Step 6: Run lint**

Run:

```bash
npm run lint
```

Expected: `npm run lint` exits 0 or reports only pre-existing unrelated failures.

---

## Task 3: Add Generic Policy Route And Renderer

**Files:**
- Create: `src/components/legal/policy-page-content.tsx`
- Create: `src/app/(site)/policies/[slug]/page.tsx`

- [ ] **Step 1: Create the policy page renderer**

Create `src/components/legal/policy-page-content.tsx` with:

```tsx
import { PortableTextRenderer } from "@/components/ui/portable-text-renderer";
import type { TPolicyPage, TPolicyPageType } from "@/types";

const PAGE_TYPE_LABELS: Record<TPolicyPageType, string> = {
  privacy: "Privacy",
  cookie: "Cookie Policy",
  booking: "Booking Policy",
  return: "Return Policy",
  refund: "Refund Policy",
  faq: "FAQ",
  terms: "Terms",
  general: "Policy",
};

interface PolicyPageContentProps {
  page: TPolicyPage;
}

export function PolicyPageContent({ page }: PolicyPageContentProps) {
  const updatedAt = page._updatedAt
    ? new Intl.DateTimeFormat("en-CA", {
        year: "numeric",
        month: "long",
        day: "numeric",
      }).format(new Date(page._updatedAt))
    : null;

  return (
    <section className="bg-lh-neutral-2 py-16 text-lh-shadow md:py-24">
      <article className="content-container max-w-4xl">
        <div className="rounded-[28px] border border-lh-line bg-lh-white px-6 py-10 shadow-[0_24px_70px_rgba(28,19,24,0.08)] md:px-12 md:py-14">
          <p className="eyebrow-label mb-4">{PAGE_TYPE_LABELS[page.pageType]}</p>
          <h1 className="section-heading mb-6">{page.title}</h1>
          {page.summary ? (
            <p className="mb-8 max-w-3xl font-body text-lg font-bold leading-8 text-lh-shadow/75">
              {page.summary}
            </p>
          ) : null}
          {updatedAt ? (
            <p className="mb-10 border-y border-lh-line py-3 font-body text-sm font-bold text-lh-muted">
              Last updated {updatedAt}
            </p>
          ) : null}
          <div className="prose prose-lg max-w-none prose-headings:font-heading prose-headings:font-normal prose-headings:text-lh-shadow prose-p:font-body prose-p:font-bold prose-p:leading-8 prose-p:text-lh-shadow/80 prose-a:text-lh-primary prose-a:underline prose-a:underline-offset-4">
            <PortableTextRenderer content={page.body} />
          </div>
        </div>
      </article>
    </section>
  );
}
```

- [ ] **Step 2: Create the dynamic policy route**

Create `src/app/(site)/policies/[slug]/page.tsx` with:

```tsx
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PolicyPageContent } from "@/components/legal/policy-page-content";
import { loaders } from "@/data/loaders";

export const revalidate = 1800;

type PolicyPageProps = {
  params: Promise<{ slug: string }>;
};

export async function generateStaticParams() {
  return loaders.getAllPolicyPageSlugs();
}

export async function generateMetadata({ params }: PolicyPageProps): Promise<Metadata> {
  const { slug } = await params;
  const page = await loaders.getPolicyPageBySlug(slug, { stega: false });

  if (!page) return {};

  const title = page.seo?.title || page.title;
  const description = page.seo?.description || page.summary || "";

  return {
    title,
    description,
    robots: page.seo?.noIndex ? "noindex" : undefined,
    openGraph: { title, description },
    twitter: { title, description },
  };
}

export default async function PolicyPage({ params }: PolicyPageProps) {
  const { slug } = await params;
  const page = await loaders.getPolicyPageBySlug(slug);

  if (!page) notFound();

  return <PolicyPageContent page={page} />;
}
```

- [ ] **Step 3: Run lint**

Run:

```bash
npm run lint
```

Expected: `npm run lint` exits 0 or reports only pre-existing unrelated failures.

---

## Task 4: Add Consent Helper With Unit Tests

**Files:**
- Create: `src/lib/cookie-consent.ts`
- Create: `src/lib/cookie-consent.test.ts`

- [ ] **Step 1: Write the failing unit tests**

Create `src/lib/cookie-consent.test.ts` with:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  COOKIE_CONSENT_STORAGE_KEY,
  createCookieConsentChoice,
  parseCookieConsent,
  serializeCookieConsent,
} from "./cookie-consent";

test("cookie consent storage key is stable", () => {
  assert.equal(COOKIE_CONSENT_STORAGE_KEY, "lh_cookie_consent");
});

test("parseCookieConsent returns null for missing values", () => {
  assert.equal(parseCookieConsent(null), null);
  assert.equal(parseCookieConsent(""), null);
});

test("parseCookieConsent returns null for invalid JSON", () => {
  assert.equal(parseCookieConsent("not-json"), null);
});

test("parseCookieConsent rejects wrong shape", () => {
  assert.equal(parseCookieConsent(JSON.stringify({ analytics: true, version: 1 })), null);
  assert.equal(parseCookieConsent(JSON.stringify({ required: true, analytics: "yes", version: 1 })), null);
  assert.equal(parseCookieConsent(JSON.stringify({ required: true, analytics: true, version: 2 })), null);
});

test("parseCookieConsent accepts valid analytics consent", () => {
  const choice = parseCookieConsent(JSON.stringify({
    required: true,
    analytics: true,
    decidedAt: "2026-06-03T12:00:00.000Z",
    version: 1,
  }));

  assert.deepEqual(choice, {
    required: true,
    analytics: true,
    decidedAt: "2026-06-03T12:00:00.000Z",
    version: 1,
  });
});

test("createCookieConsentChoice records required true and selected analytics", () => {
  const now = new Date("2026-06-03T12:00:00.000Z");
  assert.deepEqual(createCookieConsentChoice(false, now), {
    required: true,
    analytics: false,
    decidedAt: "2026-06-03T12:00:00.000Z",
    version: 1,
  });
});

test("serializeCookieConsent serializes valid consent", () => {
  const choice = createCookieConsentChoice(true, new Date("2026-06-03T12:00:00.000Z"));
  assert.equal(serializeCookieConsent(choice), JSON.stringify(choice));
});
```

- [ ] **Step 2: Run the unit test to verify it fails**

Run:

```bash
npx tsx --test src/lib/cookie-consent.test.ts
```

Expected: FAIL because `src/lib/cookie-consent.ts` does not exist.

- [ ] **Step 3: Implement the consent helper**

Create `src/lib/cookie-consent.ts` with:

```ts
export const COOKIE_CONSENT_STORAGE_KEY = "lh_cookie_consent";

export type CookieConsentChoice = {
  required: true;
  analytics: boolean;
  decidedAt: string;
  version: 1;
};

export function createCookieConsentChoice(
  analytics: boolean,
  now = new Date(),
): CookieConsentChoice {
  return {
    required: true,
    analytics,
    decidedAt: now.toISOString(),
    version: 1,
  };
}

export function serializeCookieConsent(choice: CookieConsentChoice): string {
  return JSON.stringify(choice);
}

export function parseCookieConsent(value: string | null): CookieConsentChoice | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value) as Partial<CookieConsentChoice> | null;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.required !== true) return null;
    if (typeof parsed.analytics !== "boolean") return null;
    if (typeof parsed.decidedAt !== "string" || !parsed.decidedAt) return null;
    if (parsed.version !== 1) return null;

    return {
      required: true,
      analytics: parsed.analytics,
      decidedAt: parsed.decidedAt,
      version: 1,
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the focused unit test**

Run:

```bash
npx tsx --test src/lib/cookie-consent.test.ts
```

Expected: PASS.

---

## Task 5: Add Cookie Consent Banner

**Files:**
- Create: `src/components/legal/cookie-consent-banner.tsx`
- Modify: `src/app/(site)/layout.tsx`

- [ ] **Step 1: Create the banner client component**

Create `src/components/legal/cookie-consent-banner.tsx` with:

```tsx
"use client";

import * as React from "react";
import {
  COOKIE_CONSENT_STORAGE_KEY,
  createCookieConsentChoice,
  parseCookieConsent,
  serializeCookieConsent,
} from "@/lib/cookie-consent";

const CONSENT_UPDATED_EVENT = "lh-cookie-consent-updated";

export function CookieConsentBanner() {
  const [isReady, setIsReady] = React.useState(false);
  const [isVisible, setIsVisible] = React.useState(false);
  const [showDetails, setShowDetails] = React.useState(false);

  React.useEffect(() => {
    const existing = readStoredConsent();
    setIsVisible(existing === null);
    setIsReady(true);
  }, []);

  function saveChoice(analytics: boolean) {
    const choice = createCookieConsentChoice(analytics);
    try {
      window.localStorage.setItem(COOKIE_CONSENT_STORAGE_KEY, serializeCookieConsent(choice));
    } catch {
      return;
    }

    window.dispatchEvent(new Event(CONSENT_UPDATED_EVENT));
    setIsVisible(false);
  }

  if (!isReady || !isVisible) return null;

  return (
    <section
      aria-label="Cookie consent"
      className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-4xl rounded-[24px] border border-lh-line bg-lh-white p-5 text-lh-shadow shadow-[0_24px_70px_rgba(28,19,24,0.18)] md:p-6"
      role="region"
    >
      <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-start">
        <div>
          <p className="eyebrow-label mb-2">Privacy Preferences</p>
          <h2 className="font-heading text-2xl font-normal tracking-[-0.01em] text-lh-shadow">
            We use required cookies and optional analytics.
          </h2>
          <p className="mt-3 font-body text-sm font-bold leading-6 text-lh-shadow/75">
            Required storage keeps the site working for carts, bookings, checkout, and preferences. Analytics helps us understand site performance and will only load if you accept analytics cookies.
          </p>
          {showDetails ? (
            <div className="mt-4 grid gap-3 rounded-2xl bg-lh-neutral-2 p-4 font-body text-sm font-bold leading-6 text-lh-shadow/75 md:grid-cols-2">
              <div>
                <h3 className="text-lh-shadow">Required</h3>
                <p>Always on. Supports functional site behavior such as cart, booking, checkout, and saved preferences.</p>
              </div>
              <div>
                <h3 className="text-lh-shadow">Analytics</h3>
                <p>Optional. Helps measure visits and improve the website. Analytics is off unless you accept it.</p>
              </div>
            </div>
          ) : null}
        </div>
        <div className="flex flex-col gap-3 sm:flex-row md:min-w-56 md:flex-col">
          <button
            className="rounded-full bg-lh-primary px-5 py-3 font-body text-xs font-bold uppercase tracking-[0.14em] text-lh-white transition-colors hover:bg-lh-accent"
            type="button"
            onClick={() => saveChoice(true)}
          >
            Accept analytics
          </button>
          <button
            className="rounded-full border border-lh-primary px-5 py-3 font-body text-xs font-bold uppercase tracking-[0.14em] text-lh-primary transition-colors hover:bg-lh-primary-soft"
            type="button"
            onClick={() => saveChoice(false)}
          >
            Reject analytics
          </button>
          <button
            className="font-body text-xs font-bold uppercase tracking-[0.14em] text-lh-muted underline underline-offset-4 transition-colors hover:text-lh-shadow"
            type="button"
            aria-expanded={showDetails}
            onClick={() => setShowDetails((current) => !current)}
          >
            Manage choices
          </button>
        </div>
      </div>
    </section>
  );
}

function readStoredConsent() {
  try {
    return parseCookieConsent(window.localStorage.getItem(COOKIE_CONSENT_STORAGE_KEY));
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Render the banner in the public site layout**

Modify `src/app/(site)/layout.tsx`.

Add import:

```ts
import { CookieConsentBanner } from "@/components/legal/cookie-consent-banner";
```

Render near the existing public shell utilities:

```tsx
        <CookieConsentBanner />
```

The resulting bottom of the provider should include:

```tsx
        <Footer data={globalData?.footer} />
        <ContactPopup settings={globalData?.contactPopup} />
        <CartSheet />
        <CookieConsentBanner />
```

- [ ] **Step 3: Run lint**

Run:

```bash
npm run lint
```

Expected: `npm run lint` exits 0 or reports only pre-existing unrelated failures.

---

## Task 6: Gate Vercel Analytics Behind Consent

**Files:**
- Create: `src/components/analytics/consented-analytics.tsx`
- Modify: `src/app/layout.tsx`
- Modify: `src/app/(site)/layout.tsx`

- [ ] **Step 1: Create consented analytics client component**

Create `src/components/analytics/consented-analytics.tsx` with:

```tsx
"use client";

import * as React from "react";
import { Analytics } from "@vercel/analytics/next";
import { COOKIE_CONSENT_STORAGE_KEY, parseCookieConsent } from "@/lib/cookie-consent";

const CONSENT_UPDATED_EVENT = "lh-cookie-consent-updated";

export function ConsentedAnalytics() {
  const [hasAnalyticsConsent, setHasAnalyticsConsent] = React.useState(false);

  React.useEffect(() => {
    function syncConsent() {
      try {
        const choice = parseCookieConsent(window.localStorage.getItem(COOKIE_CONSENT_STORAGE_KEY));
        setHasAnalyticsConsent(choice?.analytics === true);
      } catch {
        setHasAnalyticsConsent(false);
      }
    }

    function handleStorage(event: StorageEvent) {
      if (event.key === COOKIE_CONSENT_STORAGE_KEY) {
        syncConsent();
      }
    }

    syncConsent();
    window.addEventListener(CONSENT_UPDATED_EVENT, syncConsent);
    window.addEventListener("storage", handleStorage);

    return () => {
      window.removeEventListener(CONSENT_UPDATED_EVENT, syncConsent);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  return hasAnalyticsConsent ? <Analytics /> : null;
}
```

- [ ] **Step 2: Remove unconditional analytics from root layout**

Modify `src/app/layout.tsx`.

Remove:

```ts
import { Analytics } from "@vercel/analytics/next";
```

Remove:

```tsx
          <Analytics />
```

Keep:

```tsx
          <SpeedInsights />
```

- [ ] **Step 3: Render consented analytics in the public site layout**

Modify `src/app/(site)/layout.tsx`.

Add import:

```ts
import { ConsentedAnalytics } from "@/components/analytics/consented-analytics";
```

Render near the cookie banner:

```tsx
        <ConsentedAnalytics />
```

The resulting bottom of the provider should include:

```tsx
        <Footer data={globalData?.footer} />
        <ContactPopup settings={globalData?.contactPopup} />
        <CartSheet />
        <CookieConsentBanner />
        <ConsentedAnalytics />
```

- [ ] **Step 4: Run lint**

Run:

```bash
npm run lint
```

Expected: `npm run lint` exits 0 or reports only pre-existing unrelated failures.

---

## Task 7: Add Focused Browser Tests

**Files:**
- Create: `tests/cookie-consent.spec.ts`
- Create: `tests/policy-pages.spec.ts`

- [ ] **Step 1: Add cookie consent Playwright tests**

Create `tests/cookie-consent.spec.ts` with:

```ts
import { expect, test } from "@playwright/test";

const storageKey = "lh_cookie_consent";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate((key) => window.localStorage.removeItem(key), storageKey);
  await page.reload();
});

test("cookie banner appears when no consent is stored", async ({ page }) => {
  await expect(page.getByRole("region", { name: "Cookie consent" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept analytics" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reject analytics" })).toBeVisible();
});

test("reject analytics hides banner and persists rejection", async ({ page }) => {
  await page.getByRole("button", { name: "Reject analytics" }).click();
  await expect(page.getByRole("region", { name: "Cookie consent" })).toBeHidden();

  const stored = await page.evaluate((key) => window.localStorage.getItem(key), storageKey);
  expect(JSON.parse(stored || "{}")).toMatchObject({ required: true, analytics: false, version: 1 });

  await page.reload();
  await expect(page.getByRole("region", { name: "Cookie consent" })).toBeHidden();
});

test("accept analytics hides banner and persists analytics consent", async ({ page }) => {
  await page.getByRole("button", { name: "Accept analytics" }).click();
  await expect(page.getByRole("region", { name: "Cookie consent" })).toBeHidden();

  const stored = await page.evaluate((key) => window.localStorage.getItem(key), storageKey);
  expect(JSON.parse(stored || "{}")).toMatchObject({ required: true, analytics: true, version: 1 });
});

test("manage choices reveals category explanations", async ({ page }) => {
  await page.getByRole("button", { name: "Manage choices" }).click();
  await expect(page.getByText("Required", { exact: true })).toBeVisible();
  await expect(page.getByText("Analytics", { exact: true })).toBeVisible();
  await expect(page.getByText("Always on. Supports functional site behavior")).toBeVisible();
});
```

- [ ] **Step 2: Add policy route safety test**

Create `tests/policy-pages.spec.ts` with:

```ts
import { expect, test } from "@playwright/test";

test("unknown policy page returns a not found response", async ({ page }) => {
  const response = await page.goto("/policies/this-policy-does-not-exist");
  expect(response?.status()).toBe(404);
});
```

- [ ] **Step 3: Run focused browser tests**

Run:

```bash
npx playwright test tests/cookie-consent.spec.ts tests/policy-pages.spec.ts --project=chromium
```

Expected: tests pass. If the dev server fails because required local environment variables are missing, document the missing variable and run `npm run lint` plus the focused unit test instead.

---

## Task 8: Final Verification

**Files:**
- Verify all files changed by Tasks 1-7.

- [ ] **Step 1: Run lint**

Run:

```bash
npm run lint
```

Expected: exits 0 or only reports documented pre-existing unrelated failures.

- [ ] **Step 2: Run consent unit tests**

Run:

```bash
npx tsx --test src/lib/cookie-consent.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run focused Playwright tests**

Run:

```bash
npx playwright test tests/cookie-consent.spec.ts tests/policy-pages.spec.ts --project=chromium
```

Expected: PASS, unless local environment configuration prevents the app from starting. If blocked by environment configuration, record the exact error and the commands that did pass.

- [ ] **Step 4: Optional production build**

Run only when local Sanity environment variables match the current environment rules:

```bash
npm run build
```

Expected: production build completes successfully. If `scripts/validate-sanity-env.mjs` blocks the build because local variables are intentionally unset or mismatched, record that as an environment blocker rather than changing dataset rules.

---

## Self-Review

Spec coverage:

- Sanity-managed policy pages are covered by Tasks 1-3.
- Generic `/policies/[slug]` route is covered by Task 3.
- No starter legal copy is included in any task.
- Code-managed consent behavior is covered by Tasks 4-6.
- Explicit analytics opt-in is covered by Task 6.
- Required functional storage remains always available because no task gates existing functional cookies/localStorage.
- Cache tag alignment is covered by Tasks 1-2.
- Tests and verification are covered by Tasks 4, 7, and 8.

Placeholder scan:

- The plan contains no implementation placeholders. Future enhancements are explicitly excluded from this implementation scope.

Type consistency:

- `TPolicyPage`, `TPolicyPageType`, `CookieConsentChoice`, `COOKIE_CONSENT_STORAGE_KEY`, `parseCookieConsent`, `serializeCookieConsent`, and `createCookieConsentChoice` are named consistently across tasks.
