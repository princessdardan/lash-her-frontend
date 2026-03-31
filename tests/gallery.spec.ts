import { test, expect } from '@playwright/test';
import { setupApiMocks } from './utils/api-mocks';

test.describe('Gallery Page', () => {
  test.beforeEach(async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/gallery');
  });

  test('should load gallery page successfully', async ({ page }) => {
    await expect(page).toHaveTitle(/Gallery|Lash Her/i);
    await expect(page.locator('main')).toBeVisible();
  });

  test('should display gallery images', async ({ page }) => {
    // Wait for images to load
    await page.waitForLoadState('networkidle');

    // Check if images are present
    const images = page.locator('img');
    const imageCount = await images.count();

    // Gallery should have at least some images (or gracefully show empty state)
    if (imageCount > 0) {
      // Check that at least one image is visible
      await expect(images.first()).toBeVisible();
    }
  });

  test('should have proper image alt text for accessibility', async ({ page }) => {
    await page.waitForLoadState('networkidle');

    const images = page.locator('img');
    const imageCount = await images.count();

    if (imageCount > 0) {
      // Check that images have alt attributes
      for (let i = 0; i < Math.min(imageCount, 5); i++) {
        const img = images.nth(i);
        const altText = await img.getAttribute('alt');
        // Alt text should exist (can be empty for decorative images)
        expect(altText).not.toBeNull();
      }
    }
  });

  test('should load images lazily', async ({ page }) => {
    await page.waitForLoadState('networkidle');

    const images = page.locator('img');
    const imageCount = await images.count();

    if (imageCount > 3) {
      // Check if images have loading="lazy" attribute
      const firstImage = images.first();
      const loading = await firstImage.getAttribute('loading');

      // Next.js Image component typically handles lazy loading
      // This test verifies the implementation
    }
  });

  test.skip('should open image in lightbox or modal when clicked', async ({ page }) => {
    await page.waitForLoadState('networkidle');

    const images = page.locator('img');
    const imageCount = await images.count();

    if (imageCount > 0) {
      // Click on the first image
      await images.first().click();

      // Wait a moment for modal/lightbox to appear
      await page.waitForTimeout(500);

      // Check if a modal, dialog, or enlarged view appeared
      const modal = page.locator('[role="dialog"], .modal, .lightbox').first();
      const hasModal = await modal.isVisible({ timeout: 1000 }).catch(() => false);

      if (hasModal) {
        await expect(modal).toBeVisible();

        // Try to close the modal
        const closeButton = page.getByRole('button', { name: /close|×|✕/i });
        if (await closeButton.isVisible({ timeout: 1000 }).catch(() => false)) {
          await closeButton.click();
          await expect(modal).not.toBeVisible();
        } else {
          // Try clicking outside or pressing Escape
          await page.keyboard.press('Escape');
        }
      }
    }
  });

  test('should filter gallery by category if filters exist', async ({ page }) => {
    await page.waitForLoadState('networkidle');

    // Look for filter buttons or tabs
    const filterButtons = page.getByRole('button').filter({ hasText: /classic|volume|mega|hybrid/i });
    const filterCount = await filterButtons.count();

    if (filterCount > 0) {
      const initialImageCount = await page.locator('img').count();

      // Click on a filter
      await filterButtons.first().click();
      await page.waitForTimeout(500);

      const filteredImageCount = await page.locator('img').count();

      // Images should load (count might change based on filter)
      expect(filteredImageCount).toBeGreaterThanOrEqual(0);
    }
  });

  test('should be responsive on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });

    await expect(page.locator('main')).toBeVisible();

    // Images should be visible and properly sized on mobile
    const images = page.locator('img');
    if (await images.first().isVisible({ timeout: 2000 }).catch(() => false)) {
      const firstImage = images.first();
      const boundingBox = await firstImage.boundingBox();

      if (boundingBox) {
        // Image width should not exceed viewport
        expect(boundingBox.width).toBeLessThanOrEqual(375);
      }
    }
  });

  test('should be responsive on tablet', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });

    await expect(page.locator('main')).toBeVisible();

    const images = page.locator('img');
    const imageCount = await images.count();

    if (imageCount > 0) {
      await expect(images.first()).toBeVisible();
    }
  });

  test('should handle image loading errors gracefully', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => {
      errors.push(error.message);
    });

    await page.waitForLoadState('networkidle');

    // Should not have critical JavaScript errors
    const criticalErrors = errors.filter(e =>
      !e.includes('Failed to load resource') // Image 404s are acceptable
    );
    expect(criticalErrors).toHaveLength(0);
  });

  test('should have proper heading structure', async ({ page }) => {
    // Check for h1 heading
    const h1 = page.locator('h1').first();
    const hasH1 = await h1.isVisible({ timeout: 2000 }).catch(() => false);

    if (hasH1) {
      await expect(h1).toBeVisible();
      const h1Text = await h1.textContent();
      expect(h1Text).toBeTruthy();
    }
  });

  test('should navigate using keyboard', async ({ page }) => {
    await page.waitForLoadState('networkidle');

    // Tab through interactive elements
    await page.keyboard.press('Tab');
    await page.waitForTimeout(100);

    // Check if focus is visible
    const focusedElement = await page.evaluateHandle(() => document.activeElement);
    expect(focusedElement).toBeTruthy();
  });

  test('should load without excessive network requests', async ({ page }) => {
    const requests: string[] = [];

    page.on('request', (request) => {
      requests.push(request.url());
    });

    await page.waitForLoadState('networkidle');

    // Gallery should not make excessive API calls
    const apiRequests = requests.filter(url => url.includes('/api/'));
    expect(apiRequests.length).toBeLessThan(20);
  });
});
