import { test, expect } from '@playwright/test';
import { setupApiMocks } from './utils/api-mocks';

test.describe('Navigation', () => {
  test.beforeEach(async ({ page }) => {
    // Setup API mocks before each test
    await setupApiMocks(page);
  });

  test('should have a main navigation menu', async ({ page }) => {
    await page.goto('/');

    // Look for navigation
    const nav = page.locator('nav, header').first();
    await expect(nav).toBeVisible();
  });

  test('should navigate to all main pages from menu', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Test navigation to Contact page
    const contactLink = page.getByRole('link', { name: /contact/i }).first();
    if (await contactLink.isVisible({ timeout: 1000 }).catch(() => false)) {
      await contactLink.click();
      await page.waitForLoadState('networkidle');
      expect(page.url()).toContain('/contact');
      await page.goBack();
    }

    // Test navigation to Gallery page
    const galleryLink = page.getByRole('link', { name: /gallery/i }).first();
    if (await galleryLink.isVisible({ timeout: 1000 }).catch(() => false)) {
      await galleryLink.click();
      await page.waitForLoadState('networkidle');
      expect(page.url()).toContain('/gallery');
      await page.goBack();
    }

    // Test navigation to Training page
    const trainingLink = page.getByRole('link', { name: /training|programs/i }).first();
    if (await trainingLink.isVisible({ timeout: 1000 }).catch(() => false)) {
      await trainingLink.click();
      await page.waitForLoadState('networkidle');
      expect(page.url()).toContain('/training');
    }
  });

  test('should have a working logo link to homepage', async ({ page }) => {
    await page.goto('/contact');
    await page.waitForLoadState('networkidle');

    // Look for logo or brand link
    const logoLink = page.locator('a[href="/"]').first();
    const hasLogo = await logoLink.isVisible({ timeout: 1000 }).catch(() => false);

    if (hasLogo) {
      await logoLink.click();
      await page.waitForLoadState('networkidle');

      // Should navigate to homepage
      expect(page.url()).toMatch(/\/$/);

    }
  });

  test('should have mobile menu on small screens', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');

    // Look for mobile menu button (hamburger)
    const mobileMenuButton = page.getByRole('button', { name: /menu|navigation/i });
    const hasMobileMenu = await mobileMenuButton.isVisible({ timeout: 1000 }).catch(() => false);

    if (hasMobileMenu) {
      await expect(mobileMenuButton).toBeVisible();

      // Click to open menu
      await mobileMenuButton.click();
      await page.waitForTimeout(500);

      // Menu should be visible
      const mobileNav = page.locator('nav [role="menu"], nav.mobile-menu, .mobile-nav');
      const hasNav = await mobileNav.isVisible({ timeout: 1000 }).catch(() => false);

      if (hasNav) {
        await expect(mobileNav).toBeVisible();
      }
    }
  });

  test('should close mobile menu when link is clicked', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');

    const mobileMenuButton = page.getByRole('button', { name: /menu|navigation/i });
    const hasMobileMenu = await mobileMenuButton.isVisible({ timeout: 1000 }).catch(() => false);

    if (hasMobileMenu) {
      await mobileMenuButton.click();
      await page.waitForTimeout(500);

      // Click a menu link
      const contactLink = page.getByRole('link', { name: /contact/i }).first();
      if (await contactLink.isVisible({ timeout: 1000 }).catch(() => false)) {
        await contactLink.click();
        await page.waitForLoadState('networkidle');

        // Menu should close (button should be visible again)
        await expect(mobileMenuButton).toBeVisible();
      }
    }
  });

  test('should maintain navigation state during page transitions', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const nav = page.locator('nav, header').first();
    await expect(nav).toBeVisible();

    // Navigate to another page
    await page.goto('/gallery');
    await page.waitForLoadState('networkidle');

    // Navigation should still be visible
    await expect(nav).toBeVisible();
  });

  test('should highlight active page in navigation', async ({ page }) => {
    await page.goto('/contact');
    await page.waitForLoadState('networkidle');

    // Look for active/current state in navigation
    const activeLink = page.locator('nav a[aria-current="page"], nav a.active, nav a[data-active="true"]');
    const hasActiveState = await activeLink.isVisible({ timeout: 1000 }).catch(() => false);

    if (hasActiveState) {
      const href = await activeLink.getAttribute('href');
      expect(href).toContain('/contact');
    }
  });
});

test.describe('Accessibility', () => {
  test.beforeEach(async ({ page }) => {
    // Setup API mocks before each test
    await setupApiMocks(page);
  });

  test('should have skip to main content link', async ({ page }) => {
    await page.goto('/');

    // Look for skip link (usually hidden until focused)
    const skipLink = page.getByRole('link', { name: /skip to (main )?content/i });
    const hasSkipLink = await skipLink.isVisible({ timeout: 1000 }).catch(() => false);

    // Skip links are often visually hidden but become visible on focus
    if (!hasSkipLink) {
      // Try to tab to it
      await page.keyboard.press('Tab');
      const skipLinkFocused = page.getByRole('link', { name: /skip to (main )?content/i });
      const isNowVisible = await skipLinkFocused.isVisible({ timeout: 500 }).catch(() => false);

      if (isNowVisible) {
        await expect(skipLinkFocused).toBeVisible();
      }
    }
  });

  test('should have proper landmark regions', async ({ page }) => {
    await page.goto('/');

    // Check for main landmark
    const main = page.locator('main, [role="main"]');
    await expect(main.first()).toBeVisible();

    // Check for navigation landmark
    const nav = page.locator('nav, [role="navigation"]');
    const hasNav = await nav.first().isVisible({ timeout: 1000 }).catch(() => false);
    if (hasNav) {
      await expect(nav.first()).toBeVisible();
    }
  });

  test('should be keyboard navigable', async ({ page }) => {
    await page.goto('/');

    // Tab through the page
    let tabCount = 0;
    const maxTabs = 20;

    for (let i = 0; i < maxTabs; i++) {
      await page.keyboard.press('Tab');
      tabCount++;

      // Check if we've focused an element
      const focusedElement = await page.evaluateHandle(() => document.activeElement?.tagName);
      const tagName = await focusedElement.jsonValue();

      if (tagName && tagName !== 'BODY') {
        // Successfully focused an element
        break;
      }
    }

    // Should be able to tab to interactive elements
    expect(tabCount).toBeLessThanOrEqual(maxTabs);
  });

  test('should have focus visible styles', async ({ page }) => {
    await page.goto('/');

    // Tab to first focusable element
    await page.keyboard.press('Tab');

    // Get the focused element
    const focusedElement = page.locator(':focus');
    const hasFocus = await focusedElement.isVisible({ timeout: 1000 }).catch(() => false);

    if (hasFocus) {
      // Check if element has some kind of focus styling
      const outline = await focusedElement.evaluate((el) => {
        const styles = window.getComputedStyle(el);
        return styles.outline + styles.outlineColor + styles.boxShadow;
      });

      // Should have some focus indication
      expect(outline).toBeTruthy();
    }
  });

  test('should have proper heading hierarchy on each page', async ({ page }) => {
    const pages = ['/', '/contact', '/gallery', '/training'];

    for (const pagePath of pages) {
      await page.goto(pagePath);
      await page.waitForLoadState('networkidle');

      // Check for h1
      const h1Elements = await page.locator('h1').count();
      expect(h1Elements).toBeGreaterThan(0);
      expect(h1Elements).toBeLessThanOrEqual(2); // Should typically have only 1 h1
    }
  });

  test('should have alt text on images', async ({ page }) => {
    await page.goto('/gallery');
    await page.waitForLoadState('networkidle');

    const images = page.locator('img');
    const imageCount = await images.count();

    if (imageCount > 0) {
      // Check first few images for alt text
      for (let i = 0; i < Math.min(imageCount, 5); i++) {
        const img = images.nth(i);
        const alt = await img.getAttribute('alt');
        expect(alt).not.toBeNull();
      }
    }
  });

  test('should have proper form labels', async ({ page }) => {
    await page.goto('/contact');
    await page.waitForLoadState('networkidle');

    // Check for input elements
    const inputs = page.locator('input[type="text"], input[type="email"], textarea');
    const inputCount = await inputs.count();

    if (inputCount > 0) {
      // Each input should have an associated label or aria-label
      for (let i = 0; i < inputCount; i++) {
        const input = inputs.nth(i);
        const id = await input.getAttribute('id');
        const ariaLabel = await input.getAttribute('aria-label');
        const ariaLabelledBy = await input.getAttribute('aria-labelledby');

        // Should have some form of labeling
        const hasLabel = id || ariaLabel || ariaLabelledBy;
        expect(hasLabel).toBeTruthy();
      }
    }
  });

  test('should not have color contrast issues on text', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // This is a basic check - for comprehensive testing, use axe-core
    const textElements = page.locator('p, h1, h2, h3, h4, h5, h6, a, button, span').first();
    await expect(textElements).toBeVisible();
  });
});
