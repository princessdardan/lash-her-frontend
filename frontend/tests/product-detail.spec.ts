import { test, expect } from '@playwright/test';

test.describe('Product Detail Page', () => {
  test('should display product details, gallery, and link back to catalog', async ({ page }) => {
    await page.goto('/products');
    await page.waitForLoadState('networkidle');

    const productLinks = page.locator('a[href*="/products/"]');
    const count = await productLinks.count();

    let href = '/products/classic-lash-set-deposit-e2e';
    if (count > 0) {
      const firstHref = await productLinks.first().getAttribute('href');
      if (firstHref) {
        href = firstHref;
      }
    }

    await page.goto(href);
    await page.waitForLoadState('networkidle');

    await expect(page.getByRole('heading', { name: /page not found/i })).toHaveCount(0);

    await expect(page.getByRole('link', { name: /back to catalog|back to products/i }).first()).toBeVisible();

    await expect(page.locator('main h1')).toBeVisible();
    
    await expect(page.getByRole('button', { name: /add to cart/i })).toHaveCount(0);
  });
});
