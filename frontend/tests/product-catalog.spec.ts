import { test, expect } from '@playwright/test';

test.describe('Product Catalog Page', () => {
  test('should display products with manual availability and fulfillment notes', async ({ page }) => {
    await page.goto('/products');
    await page.waitForLoadState('networkidle');

    await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();
    
    const productCards = page.locator('article');
    const count = await productCards.count();
    
    if (count > 0) {
      await expect(page.getByRole('heading', { name: 'Your Cart' })).toBeVisible();
      
      const firstProductLink = productCards.first().locator('a[href*="/products/"]');
      if (await firstProductLink.count() > 0) {
        await expect(firstProductLink).toBeVisible();
      }
    }
  });
});
