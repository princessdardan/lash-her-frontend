import { test, expect } from '@playwright/test';
import { checkBrokenImages } from './utils/test-helpers';

/**
 * E2E tests for training program detail pages.
 * Verifies MIG-03: Strapi Blocks rich text converted to Portable Text renders correctly.
 * No Strapi API mocks — the site now reads from Sanity CDN directly.
 */

const FALLBACK_SLUG = 'classic-lash-training';

/**
 * Discover a training program detail URL from /training, or fall back to a known slug.
 */
async function getProgramUrl(page: import('@playwright/test').Page): Promise<string> {
  await page.goto('/training');
  await page.waitForLoadState('networkidle');

  // The Sanity-powered training page links to /training-programs/{slug}
  const programLinks = page.locator('a[href*="/training-programs/"]');
  const count = await programLinks.count();

  if (count > 0) {
    const href = await programLinks.first().getAttribute('href');
    if (href) return href;
  }

  return `/training-programs/${FALLBACK_SLUG}`;
}

test.describe('Training Program Detail Page — Rich Text Rendering (MIG-03)', () => {
  test('should load a training program detail page without JS errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => {
      errors.push(error.message);
    });

    const url = await getProgramUrl(page);
    await page.goto(url);
    await page.waitForLoadState('networkidle');

    await expect(page.locator('main')).toBeVisible();
    expect(errors).toHaveLength(0);
  });

  test('should render at least one paragraph of text inside main (Portable Text body)', async ({ page }) => {
    const url = await getProgramUrl(page);
    await page.goto(url);
    await page.waitForLoadState('networkidle');

    // Portable Text converts Strapi paragraph nodes to <p> elements
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
  });

  test('should navigate to multiple program detail pages when links exist', async ({ page }) => {
    await page.goto('/training');
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
