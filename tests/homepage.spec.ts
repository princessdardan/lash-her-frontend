import { test, expect } from '@playwright/test';
import { setupApiMocks } from './utils/api-mocks';

test.describe('Homepage', () => {
  test.beforeEach(async ({ page }) => {
    await setupApiMocks(page);
  });

  test('should load homepage sections', async ({ page }) => {
    await page.goto('/');

    // Check for main sections
    await expect(page.locator('main')).toBeVisible();

    // Verify page has loaded content
    const mainContent = page.locator('main');
    await expect(mainContent).not.toBeEmpty();
  });

  test('should have proper meta tags', async ({ page }) => {
    await page.goto('/');

    // Check for title
    await expect(page).toHaveTitle(/Lash Her/i);
  });

  test('should be responsive on mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 }); // iPhone SE
    await page.goto('/');

    // Verify main content is visible on mobile
    await expect(page.locator('main')).toBeVisible();
  });

  test('should be responsive on tablet viewport', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 }); // iPad
    await page.goto('/');

    // Verify main content is visible on tablet
    await expect(page.locator('main')).toBeVisible();
  });

  test('should load all sections without errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => {
      errors.push(error.message);
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Check that no JavaScript errors occurred
    expect(errors).toHaveLength(0);
  });

  test('should have accessible navigation', async ({ page }) => {
    await page.goto('/');

    // Check for navigation/header
    const nav = page.locator('nav, header').first();
    await expect(nav).toBeVisible();
  });
});
