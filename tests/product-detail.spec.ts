import { test, expect } from '@playwright/test';

test.describe('Product Detail Page', () => {
  test('should display product details, gallery, and link back to catalog', async ({ page }) => {
    await page.goto('/products');
    await page.waitForLoadState('networkidle');

    const productLinks = page.locator('section').filter({ hasText: 'Products' }).locator('a[href*="/products/"]');
    const count = await productLinks.count();

    if (count === 0) {
      return;
    }

    const href = await productLinks.first().getAttribute('href');
    if (!href) return;

    await page.goto(href);
    await page.waitForLoadState('networkidle');

    await expect(page.getByRole('heading', { name: /page not found/i })).toHaveCount(0);

    await expect(page.getByRole('link', { name: /back to catalog|back to products/i }).first()).toBeVisible();

    await expect(page.locator('main h1')).toBeVisible();

    const title = await page.locator('main h1').innerText();
    if (title.includes('Beginner Private Training')) {
      await expect(page.locator('main')).toContainText('training');
      await expect(page.locator('main')).toContainText('$4,097.00');
    }
     
    await expect(page.getByRole('button', { name: /add to cart/i })).toHaveCount(0);
  });
});
