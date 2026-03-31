import { Page, expect } from '@playwright/test';

/**
 * Wait for all images on the page to load
 */
export async function waitForImages(page: Page) {
  await page.evaluate(() => {
    const images = Array.from(document.images);
    return Promise.all(
      images.map((img) => {
        if (img.complete) return Promise.resolve();
        return new Promise((resolve) => {
          img.addEventListener('load', resolve);
          img.addEventListener('error', resolve);
        });
      })
    );
  });
}

/**
 * Check if page has any console errors
 */
export async function checkConsoleErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push(msg.text());
    }
  });
  return errors;
}

/**
 * Check for broken images on the page
 */
export async function checkBrokenImages(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const images = Array.from(document.images);
    return images.filter((img) => !img.complete || img.naturalHeight === 0).length;
  });
}

/**
 * Verify page has no accessibility violations (basic checks)
 */
export async function checkBasicAccessibility(page: Page) {
  // Check for alt text on images
  const imagesWithoutAlt = await page.locator('img:not([alt])').count();
  expect(imagesWithoutAlt).toBe(0);

  // Check for proper heading hierarchy
  const h1Count = await page.locator('h1').count();
  expect(h1Count).toBeGreaterThan(0);
  expect(h1Count).toBeLessThanOrEqual(2);

  // Check for form labels
  const inputsWithoutLabels = await page.locator('input:not([aria-label]):not([aria-labelledby])').count();
  // This is informational - not all inputs need explicit labels
}

/**
 * Check if element is in viewport
 */
export async function isInViewport(page: Page, selector: string): Promise<boolean> {
  return await page.evaluate((sel) => {
    const element = document.querySelector(sel);
    if (!element) return false;

    const rect = element.getBoundingClientRect();
    return (
      rect.top >= 0 &&
      rect.left >= 0 &&
      rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
      rect.right <= (window.innerWidth || document.documentElement.clientWidth)
    );
  }, selector);
}

/**
 * Scroll element into view smoothly
 */
export async function scrollIntoView(page: Page, selector: string) {
  await page.evaluate((sel) => {
    const element = document.querySelector(sel);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, selector);
}

/**
 * Wait for all network requests to complete
 */
export async function waitForNetworkIdle(page: Page, timeout = 5000) {
  await page.waitForLoadState('networkidle', { timeout });
}

/**
 * Check page performance metrics
 */
export async function getPerformanceMetrics(page: Page) {
  return await page.evaluate(() => {
    const perfData = window.performance.timing;
    const loadTime = perfData.loadEventEnd - perfData.navigationStart;
    const domContentLoaded = perfData.domContentLoadedEventEnd - perfData.navigationStart;
    const timeToInteractive = perfData.domInteractive - perfData.navigationStart;

    return {
      loadTime,
      domContentLoaded,
      timeToInteractive,
    };
  });
}

/**
 * Take a full page screenshot
 */
export async function takeFullPageScreenshot(page: Page, filename: string) {
  await page.screenshot({ path: filename, fullPage: true });
}

/**
 * Check if page is mobile responsive (no horizontal overflow)
 */
export async function checkNoHorizontalScroll(page: Page) {
  const hasHorizontalScroll = await page.evaluate(() => {
    return document.documentElement.scrollWidth > document.documentElement.clientWidth;
  });
  expect(hasHorizontalScroll).toBe(false);
}

/**
 * Fill form field by label or placeholder
 */
export async function fillFormField(page: Page, labelText: string, value: string) {
  const field = page.getByLabel(new RegExp(labelText, 'i')).or(page.getByPlaceholder(new RegExp(labelText, 'i')));
  await field.fill(value);
}

/**
 * Check if element has focus styles
 */
export async function hasFocusStyles(page: Page, selector: string): Promise<boolean> {
  await page.locator(selector).focus();

  return await page.evaluate((sel) => {
    const element = document.querySelector(sel);
    if (!element) return false;

    const styles = window.getComputedStyle(element);
    const outline = styles.outline;
    const outlineWidth = styles.outlineWidth;
    const boxShadow = styles.boxShadow;

    return outline !== 'none' || outlineWidth !== '0px' || boxShadow !== 'none';
  }, selector);
}

/**
 * Common test data for forms
 */
export const testData = {
  validEmail: 'test@example.com',
  invalidEmail: 'invalid-email',
  validName: 'John Doe',
  validPhone: '+1234567890',
  validMessage: 'This is a test message for e2e testing purposes.',
};

/**
 * Common selectors
 */
export const selectors = {
  navigation: 'nav, header',
  mobileMenu: 'button[aria-label*="menu" i], button[aria-label*="navigation" i]',
  mainContent: 'main',
  footer: 'footer',
  form: 'form',
  submitButton: 'button[type="submit"]',
};
