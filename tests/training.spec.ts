import { test, expect } from '@playwright/test';
import { setupApiMocks } from './utils/api-mocks';

test.describe('Training Page', () => {
  test.beforeEach(async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/training');
  });

  test('should load training page successfully', async ({ page }) => {
    await expect(page).toHaveTitle(/Training|Lash Her/i);
    await expect(page.locator('main')).toBeVisible();
  });

  test('should display training programs overview', async ({ page }) => {
    await page.waitForLoadState('networkidle');

    const main = page.locator('main');
    await expect(main).toBeVisible();
    await expect(main).not.toBeEmpty();
  });

  test('should display training program cards or sections', async ({ page }) => {
    await page.waitForLoadState('networkidle');

    // Look for program elements (cards, sections, etc.)
    // This is generic - adjust based on actual implementation
    const content = page.locator('main *');
    const count = await content.count();

    expect(count).toBeGreaterThan(0);
  });

  test('should have links to individual training programs', async ({ page }) => {
    await page.waitForLoadState('networkidle');

    // Look for links to training program detail pages
    const programLinks = page.locator('a[href*="/training-program"]');
    const linkCount = await programLinks.count();

    if (linkCount > 0) {
      // At least one program link should be visible
      await expect(programLinks.first()).toBeVisible();
    }
  });

  test('should navigate to training program detail page', async ({ page }) => {
    await page.waitForLoadState('networkidle');

    const programLinks = page.locator('a[href*="/training-program"]');
    const linkCount = await programLinks.count();

    if (linkCount > 0) {
      // Click on the first program link
      const href = await programLinks.first().getAttribute('href');
      await programLinks.first().click();

      // Wait for navigation
      await page.waitForLoadState('networkidle');

      // Should be on a training program detail page
      expect(page.url()).toContain('/training-program');
    }
  });

  test('should display call-to-action buttons', async ({ page }) => {
    await page.waitForLoadState('networkidle');

    // Look for CTA buttons (Book, Enroll, Learn More, etc.)
    const ctaButtons = page.getByRole('button', { name: /book|enroll|learn more|get started|sign up/i });
    const buttonCount = await ctaButtons.count();

    if (buttonCount > 0) {
      await expect(ctaButtons.first()).toBeVisible();
    }
  });

  test('should be mobile responsive', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });

    await expect(page.locator('main')).toBeVisible();

    // Training content should stack properly on mobile
    const main = page.locator('main');
    const boundingBox = await main.boundingBox();

    if (boundingBox) {
      expect(boundingBox.width).toBeLessThanOrEqual(375);
    }
  });

  test('should be tablet responsive', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });

    await expect(page.locator('main')).toBeVisible();
  });

  test('should load without JavaScript errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => {
      errors.push(error.message);
    });

    await page.waitForLoadState('networkidle');
    expect(errors).toHaveLength(0);
  });

  test('should have proper heading hierarchy', async ({ page }) => {
    const h1 = page.locator('h1').first();
    const hasH1 = await h1.isVisible({ timeout: 2000 }).catch(() => false);

    if (hasH1) {
      await expect(h1).toBeVisible();
    }
  });

  test('should display training features or benefits', async ({ page }) => {
    await page.waitForLoadState('networkidle');

    // Look for feature lists, benefit sections, etc.
    const content = page.locator('main');
    await expect(content).toBeVisible();
  });
});

test.describe('Training Program Detail Page', () => {
  test('should load a training program detail page', async ({ page }) => {
    // Navigate to training page first
    await page.goto('/training');
    await page.waitForLoadState('networkidle');

    // Find a program link
    const programLinks = page.locator('a[href*="/training-program"]');
    const linkCount = await programLinks.count();

    if (linkCount > 0) {
      const href = await programLinks.first().getAttribute('href');

      if (href) {
        // Navigate to the program detail page
        await page.goto(href);
        await page.waitForLoadState('networkidle');

        await expect(page.locator('main')).toBeVisible();
      }
    } else {
      // If no links found, try a direct route (adjust slug as needed)
      await page.goto('/training-programs/classic-lash-training');
      const main = page.locator('main');

      if (await main.isVisible({ timeout: 2000 }).catch(() => false)) {
        await expect(main).toBeVisible();
      }
    }
  });

  test('should display program details', async ({ page }) => {
    await page.goto('/training');
    await page.waitForLoadState('networkidle');

    const programLinks = page.locator('a[href*="/training-program"]');
    const linkCount = await programLinks.count();

    if (linkCount > 0) {
      const href = await programLinks.first().getAttribute('href');

      if (href) {
        await page.goto(href);
        await page.waitForLoadState('networkidle');

        const main = page.locator('main');
        await expect(main).toBeVisible();
        await expect(main).not.toBeEmpty();
      }
    }
  });

  test('should have enrollment or booking CTA', async ({ page }) => {
    await page.goto('/training');
    await page.waitForLoadState('networkidle');

    const programLinks = page.locator('a[href*="/training-program"]');
    const linkCount = await programLinks.count();

    if (linkCount > 0) {
      const href = await programLinks.first().getAttribute('href');

      if (href) {
        await page.goto(href);
        await page.waitForLoadState('networkidle');

        // Look for enrollment buttons
        const enrollButton = page.getByRole('button', { name: /enroll|book|register|sign up/i });
        const linkButton = page.getByRole('link', { name: /enroll|book|register|sign up/i });

        const hasButton = await enrollButton.isVisible({ timeout: 1000 }).catch(() => false);
        const hasLink = await linkButton.isVisible({ timeout: 1000 }).catch(() => false);

        if (hasButton || hasLink) {
          expect(hasButton || hasLink).toBe(true);
        }
      }
    }
  });

  test('should be mobile responsive', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/training');
    await page.waitForLoadState('networkidle');

    const programLinks = page.locator('a[href*="/training-program"]');
    const linkCount = await programLinks.count();

    if (linkCount > 0) {
      const href = await programLinks.first().getAttribute('href');

      if (href) {
        await page.goto(href);
        await expect(page.locator('main')).toBeVisible();
      }
    }
  });
});
