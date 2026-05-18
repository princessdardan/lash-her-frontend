import { test, expect } from '@playwright/test';

test.describe('Product Catalog Page', () => {
  test('should display products with manual availability and fulfillment notes', async ({ page }) => {
    await page.goto('/products');
    await page.waitForLoadState('networkidle');

    await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();
    
    const productCards = page.locator('article');
    const count = await productCards.count();
    
    if (count > 0) {
      await expect(page.getByRole('heading', { name: 'Your Cart' })).toBeHidden();
      await expect(productCards.first().getByRole('heading')).toBeVisible();
      await expect(productCards.first()).toContainText(/\$[\d,]+\.\d{2}/);
       
      const firstProductLink = productCards.first().locator('a[href*="/products/"]');
      if (await firstProductLink.count() > 0) {
        await expect(firstProductLink).toBeVisible();
      }

      const beginnerTrainingCard = productCards.filter({ hasText: 'Beginner Private Training' });
      if (await beginnerTrainingCard.count() > 0) {
        await expect(beginnerTrainingCard).toContainText('Training Program');
        await expect(beginnerTrainingCard).toContainText('$4,097.00');
        await expect(beginnerTrainingCard).toContainText('We will be in touch as soon as possible');
      }

      const addButton = productCards.first().getByRole('button', { name: /add to cart/i });
      if (await addButton.count() > 0) {
        await addButton.click();
        await expect(page.getByRole('heading', { name: 'Your Cart' })).toBeVisible();
        await expect(page.getByRole('complementary', { name: 'Shopping cart' })).toBeVisible();
      }
    }
  });

  test('should show the cart aside responsively after adding an item on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/products');
    await page.waitForLoadState('networkidle');

    const productCards = page.locator('article');
    const count = await productCards.count();

    if (count > 0) {
      await expect(page.getByRole('heading', { name: 'Your Cart' })).toBeHidden();

      const addButton = productCards.first().getByRole('button', { name: /add to cart/i });
      if (await addButton.count() > 0) {
        await addButton.click();

        const cartAside = page.getByRole('complementary', { name: 'Shopping cart' });
        await expect(cartAside).toBeVisible();

        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
        expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
      }
    }
  });
});
