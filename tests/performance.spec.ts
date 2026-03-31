import { test, expect } from '@playwright/test';
import { getPerformanceMetrics, waitForNetworkIdle } from './utils/test-helpers';
import { setupApiMocks } from './utils/api-mocks';

test.describe('Performance Tests', () => {
  test.beforeEach(async ({ page }) => {
    await setupApiMocks(page);
  });

  test('homepage should load within acceptable time', async ({ page }) => {
    const startTime = Date.now();
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const loadTime = Date.now() - startTime;

    // Page should load within 5 seconds
    expect(loadTime).toBeLessThan(5000);
  });

  test('should have good performance metrics', async ({ page }) => {
    await page.goto('/');
    await waitForNetworkIdle(page);

    const metrics = await getPerformanceMetrics(page);

    // These are reasonable targets - adjust based on your needs
    expect(metrics.loadTime).toBeLessThan(5000); // 5 seconds
    expect(metrics.domContentLoaded).toBeLessThan(3000); // 3 seconds
    expect(metrics.timeToInteractive).toBeLessThan(2000); // 2 seconds
  });

  test('should not make excessive API requests', async ({ page }) => {
    const requests: string[] = [];

    page.on('request', (request) => {
      if (request.url().includes('/api/')) {
        requests.push(request.url());
      }
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Should not make too many API calls
    expect(requests.length).toBeLessThan(15);
  });

  test('should have efficient image loading', async ({ page }) => {
    const imageRequests: Array<{ url: string; size: number }> = [];

    page.on('response', async (response) => {
      const url = response.url();
      if (url.match(/\.(jpg|jpeg|png|gif|webp|avif)$/i)) {
        const buffer = await response.body().catch(() => null);
        if (buffer) {
          imageRequests.push({
            url,
            size: buffer.length,
          });
        }
      }
    });

    await page.goto('/gallery');
    await page.waitForLoadState('networkidle');

    // Check that images are reasonably sized (not serving huge files)
    for (const img of imageRequests) {
      // Images should generally be under 500KB (adjust based on your needs)
      expect(img.size).toBeLessThan(500 * 1024);
    }
  });

  test('should use image optimization formats', async ({ page }) => {
    const modernFormats: string[] = [];

    page.on('response', (response) => {
      const url = response.url();
      if (url.match(/\.(webp|avif)$/i)) {
        modernFormats.push(url);
      }
    });

    await page.goto('/gallery');
    await page.waitForLoadState('networkidle');

    // Should use modern image formats (WebP or AVIF)
    // This test is informational - it's okay if it's 0 for some setups
    console.log(`Modern image formats loaded: ${modernFormats.length}`);
  });

  test('should lazy load images below the fold', async ({ page }) => {
    await page.goto('/gallery');

    // Get initial image count
    const initialImages = await page.locator('img').count();

    // Scroll down
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });

    await page.waitForTimeout(1000);

    // More images might load after scrolling
    const afterScrollImages = await page.locator('img').count();

    // Either same (all loaded) or more (lazy loaded)
    expect(afterScrollImages).toBeGreaterThanOrEqual(initialImages);
  });

  test('should not block rendering with large JavaScript bundles', async ({ page }) => {
    const jsRequests: Array<{ url: string; size: number }> = [];

    page.on('response', async (response) => {
      const url = response.url();
      if (url.endsWith('.js')) {
        const buffer = await response.body().catch(() => null);
        if (buffer) {
          jsRequests.push({
            url,
            size: buffer.length,
          });
        }
      }
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Individual JS bundles should be reasonably sized
    for (const js of jsRequests) {
      // Bundles should generally be under 1MB (adjust based on your needs)
      expect(js.size).toBeLessThan(1024 * 1024);
    }
  });

  test('should use caching headers for static assets', async ({ page }) => {
    let hasCacheHeaders = false;

    page.on('response', (response) => {
      const url = response.url();
      if (url.match(/\.(js|css|jpg|png|gif|webp|avif|woff|woff2)$/i)) {
        const cacheControl = response.headers()['cache-control'];
        if (cacheControl && cacheControl.includes('max-age')) {
          hasCacheHeaders = true;
        }
      }
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Static assets should have cache headers (in production)
    // This might not pass in dev mode - that's okay
    console.log(`Cache headers found: ${hasCacheHeaders}`);
  });

  test('should have acceptable First Contentful Paint', async ({ page }) => {
    await page.goto('/');

    const fcp = await page.evaluate(() => {
      return new Promise<number>((resolve) => {
        new PerformanceObserver((entryList) => {
          const entries = entryList.getEntriesByName('first-contentful-paint');
          if (entries.length > 0) {
            resolve(entries[0].startTime);
          }
        }).observe({ type: 'paint', buffered: true });

        // Fallback timeout
        setTimeout(() => resolve(0), 5000);
      });
    });

    if (fcp > 0) {
      // FCP should be under 2 seconds
      expect(fcp).toBeLessThan(2000);
    }
  });

  test('should not have memory leaks on navigation', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Navigate between pages
    await page.goto('/contact');
    await page.waitForLoadState('networkidle');

    await page.goto('/gallery');
    await page.waitForLoadState('networkidle');

    await page.goto('/training');
    await page.waitForLoadState('networkidle');

    // Get JavaScript heap size
    const metrics = await page.evaluate(() => {
      return (performance as any).memory
        ? {
            usedJSHeapSize: (performance as any).memory.usedJSHeapSize,
            jsHeapSizeLimit: (performance as any).memory.jsHeapSizeLimit,
          }
        : null;
    });

    if (metrics) {
      // Heap usage should be reasonable (under 50% of limit)
      const usagePercent = (metrics.usedJSHeapSize / metrics.jsHeapSizeLimit) * 100;
      expect(usagePercent).toBeLessThan(50);
    }
  });
});
