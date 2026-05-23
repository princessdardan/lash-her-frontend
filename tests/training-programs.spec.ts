import { test, expect } from '@playwright/test';
import { checkBrokenImages, checkNoHorizontalScroll } from './utils/test-helpers';

/**
 * E2E tests for training program detail pages.
 * Verifies MIG-03: migrated rich text renders through Sanity Portable Text.
 * This spec does not use legacy endpoint fixtures; the site reads from Sanity.
 */

const FALLBACK_SLUG = 'lash-designing-1-1-training';
const UNSAFE_PAYMENT_COPY = /stripe|card number|credit card number|cvc|cvv|expiry|expiration date/i;

/**
 * Discover a training program detail URL from /training-programs, or fall back to a known slug.
 */
async function getProgramUrl(page: import('@playwright/test').Page): Promise<string> {
  await page.goto('/training-programs');
  await page.waitForLoadState('networkidle');

  // The Sanity-powered training programs page links to /training-programs/{slug}
  const programLinks = page.locator('a[href*="/training-programs/"]');
  const count = await programLinks.count();

  if (count > 0) {
    const href = await programLinks.first().getAttribute('href');
    if (href) return href;
  }

  return `/training-programs/${FALLBACK_SLUG}`;
}

test.describe('Training Program Detail Page — Rich Text Rendering (MIG-03)', () => {
  test('should load a training program detail page without JS errors and not be a 404', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => {
      errors.push(error.message);
    });

    const url = await getProgramUrl(page);
    await page.goto(url);
    await page.waitForLoadState('networkidle');

    await expect(page.locator('main')).toBeVisible();
    await expect(page.getByRole('heading', { name: /page not found/i })).toHaveCount(0);
    expect(errors).toHaveLength(0);
  });

  test('should render structured detail fields if present', async ({ page }) => {
    const url = await getProgramUrl(page);
    await page.goto(url);
    await page.waitForLoadState('networkidle');

    const main = page.locator('main');
    await expect(main).toBeVisible();

    const hasStructuredDetails = await page.locator('[data-structured-details="true"]').count() > 0;

    if (hasStructuredDetails) {
      const detailHero = page.locator('[data-training-detail-hero="true"]');
      await expect(detailHero).toBeVisible();

      const heroHeading = detailHero.locator('h1');
      await expect(heroHeading).toBeVisible();
      await expect(detailHero.getByText(/training program/i)).toBeVisible();

      const heroBody = detailHero.locator('p').filter({ hasNotText: /training program/i });
      if (await heroBody.count() > 0) {
        await expect(heroBody.first()).toBeVisible();
        await expect(heroBody.first()).not.toBeEmpty();
      }

      const factList = page.locator('ul.fact-list');
      if (await factList.count() > 0) {
        await expect(factList).toBeVisible();
      }

      const cta = page.locator('a.primary-cta');
      if (await cta.count() > 0) {
        await expect(cta).toBeVisible();
      }

      const tabs = page.locator('button[role="tab"]');
      if (await tabs.count() > 1) {
        const firstTab = tabs.nth(0);
        const secondTab = tabs.nth(1);

        await expect(firstTab).toHaveAttribute('aria-selected', 'true');
        await expect(secondTab).toHaveAttribute('aria-selected', 'false');

        await secondTab.click();

        await expect(firstTab).toHaveAttribute('aria-selected', 'false');
        await expect(secondTab).toHaveAttribute('aria-selected', 'true');
      }
    }
  });

  test('should keep badges or fallback detail content visible without breaking legacy detail pages', async ({ page }) => {
    const url = await getProgramUrl(page);
    await page.goto(url);
    await page.waitForLoadState('networkidle');

    const main = page.locator('main');
    await expect(main).toBeVisible();
    await expect(page.getByRole('heading', { name: /page not found/i })).toHaveCount(0);

    const structuredDetails = page.locator('[data-structured-details="true"]');
    if (await structuredDetails.count() > 0) {
      const detailHero = structuredDetails.locator('[data-training-detail-hero="true"]');
      await expect(detailHero).toBeVisible();
      await expect(detailHero.locator('h1')).toBeVisible();

      const detailBadges = structuredDetails.getByText(/training program|lesson \d+|duration|level|investment|format|enrollment/i);
      await expect(detailBadges.first()).toBeVisible();
      return;
    }

    await expect(main.locator('h1, h2, h3').first()).toBeVisible();
    await expect(main.locator('p').first()).toBeVisible();
  });

  test('should never render raw card fields or Stripe copy in training detail enrollment surfaces', async ({ page }) => {
    const url = await getProgramUrl(page);
    await page.goto(url);
    await page.waitForLoadState('networkidle');

    const main = page.locator('main');
    await expect(main).toBeVisible();
    await expect(page.getByRole('heading', { name: /page not found/i })).toHaveCount(0);

    await expect(main.getByText(UNSAFE_PAYMENT_COPY)).toHaveCount(0);
    await expect(main.getByLabel(/card number|credit card|cvc|cvv|expiry|expiration/i)).toHaveCount(0);
    await expect(main.locator('input[autocomplete="cc-number"], input[name*="card" i], input[id*="card" i]')).toHaveCount(0);
  });

  test('should show a timed active detail card and image panel when detail items exist', async ({ page }) => {
    const url = await getProgramUrl(page);
    await page.goto(url);
    await page.waitForLoadState('networkidle');

    const tabs = page.locator('button[role="tab"]');
    const tabCount = await tabs.count();

    if (tabCount === 0) {
      test.skip();
      return;
    }

    const firstTab = tabs.first();
    await expect(firstTab).toHaveAttribute('aria-selected', 'true');
    await expect(firstTab).toHaveAttribute('data-training-detail-card', 'active');
    await expect(firstTab.locator('[data-training-detail-progress="true"]')).toBeVisible();
    await expect(page.locator('[data-training-detail-image="true"]')).toBeVisible();
  });

  test('should keep the training contact form below all other training content', async ({ page }) => {
    const url = await getProgramUrl(page);
    await page.goto(url);
    await page.waitForLoadState('networkidle');

    const contactBlocks = page.locator('[data-training-contact-blocks="true"]');
    const structuredDetails = page.locator('[data-structured-details="true"]');

    if (await contactBlocks.count() === 0 || await structuredDetails.count() === 0) {
      test.skip();
      return;
    }

    const contactTop = await contactBlocks.first().evaluate((element) => element.getBoundingClientRect().top + window.scrollY);
    const detailTop = await structuredDetails.first().evaluate((element) => element.getBoundingClientRect().top + window.scrollY);

    expect(contactTop).toBeGreaterThan(detailTop);
  });

  test('should render at least one paragraph of text inside main (Portable Text body)', async ({ page }) => {
    const url = await getProgramUrl(page);
    await page.goto(url);
    await page.waitForLoadState('networkidle');

    // Portable Text renders migrated paragraph content as <p> elements.
    const paragraphs = page.locator('main p');
    await expect(paragraphs.first()).toBeVisible();
    const text = await paragraphs.first().textContent();
    expect(text?.trim().length).toBeGreaterThan(0);
  });

  test('should render at least one heading inside main (Portable Text heading nodes)', async ({ page }) => {
    const url = await getProgramUrl(page);
    await page.goto(url);
    await page.waitForLoadState('networkidle');

    // Portable Text renders heading nodes as h2 or h3 per Phase 1 schema definition
    const headings = page.locator('main h2, main h3');
    const count = await headings.count();
    expect(count).toBeGreaterThan(0);

    const text = await headings.first().textContent();
    expect(text?.trim().length).toBeGreaterThan(0);
  });

  test('should have non-empty main with meaningful text content', async ({ page }) => {
    const url = await getProgramUrl(page);
    await page.goto(url);
    await page.waitForLoadState('networkidle');

    const main = page.locator('main');
    await expect(main).toBeVisible();
    await expect(main).not.toBeEmpty();

    // Ensure main contains real text (not just empty containers)
    const bodyText = await main.textContent();
    expect(bodyText?.trim().length).toBeGreaterThan(50);
  });

  test('should load images without broken sources', async ({ page }) => {
    const url = await getProgramUrl(page);
    await page.goto(url);
    await page.waitForLoadState('networkidle');

    // Wait for images to settle
    await page.waitForTimeout(500);

    const brokenCount = await checkBrokenImages(page);
    expect(brokenCount).toBe(0);

    // All img elements must have a non-empty src
    const images = page.locator('main img');
    const imgCount = await images.count();
    for (let i = 0; i < imgCount; i++) {
      const src = await images.nth(i).getAttribute('src');
      expect(src).toBeTruthy();
    }
  });

  test('should have page title referencing the program name', async ({ page }) => {
    const url = await getProgramUrl(page);
    await page.goto(url);
    await page.waitForLoadState('networkidle');

    // Metadata title is set in generateMetadata: "{title} | Lash Her"
    await expect(page).toHaveTitle(/Lash Her/i);
  });

  test('should be mobile responsive', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    const url = await getProgramUrl(page);
    await page.goto(url);
    await page.waitForLoadState('networkidle');

    const main = page.locator('main');
    await expect(main).toBeVisible();

    const boundingBox = await main.boundingBox();
    if (boundingBox) {
      expect(boundingBox.width).toBeLessThanOrEqual(375);
    }
    await checkNoHorizontalScroll(page);
  });

  test('should navigate to multiple program detail pages when links exist', async ({ page }) => {
    await page.goto('/training-programs');
    await page.waitForLoadState('networkidle');

    const programLinks = page.locator('a[href*="/training-programs/"]');
    const count = await programLinks.count();

    if (count < 2) {
      // Only one or zero links — skip multi-navigation check
      test.skip();
      return;
    }

    // Visit the second program to confirm routing works for multiple slugs
    const href = await programLinks.nth(1).getAttribute('href');
    if (!href) return;

    await page.goto(href);
    await page.waitForLoadState('networkidle');

    await expect(page.locator('main')).toBeVisible();
    const main = page.locator('main');
    const bodyText = await main.textContent();
    expect(bodyText?.trim().length).toBeGreaterThan(0);
  });
});
