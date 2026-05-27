import { test, expect } from '@playwright/test';

test.describe('Product Catalog Page', () => {
  test('should display products with manual availability and fulfillment notes', async ({ page }) => {
    await page.goto('/products');
    await page.waitForLoadState('networkidle');

    await expect(page.getByRole('heading', { name: 'Catalog' })).toBeVisible();
    await expect(page.getByRole('complementary', { name: /catalog filters/i })).toBeVisible();
    await expect(page.getByLabel(/sort by/i)).toBeVisible();
    await expect(page.getByText(/showing\s+\d+\s+products/i)).toBeVisible();
    
    const productCards = page.locator('section').filter({ hasText: 'Products' }).locator('article');
    const count = await productCards.count();
    
    if (count > 0) {
      await expect(page.getByRole('heading', { name: 'Your Cart' })).toBeHidden();
      await expect(productCards.first().getByRole('heading')).toBeVisible();
      await expect(productCards.first()).toContainText(/\$[\d,]+\.\d{2}/);
        
      await expect(productCards.first().getByRole('link').first()).toBeVisible();
      await expect(productCards.first().getByRole('button', { name: /buy now|add (to cart|option)|sold out|unavailable/i }).first()).toBeVisible();

      const addButton = productCards.first().getByRole('button', { name: /add to cart/i });
      if (await addButton.count() > 0) {
        await addButton.click();
        await expect(page.getByRole('heading', { name: 'Your Cart' })).toBeVisible();
        await expect(page.getByRole('dialog', { name: /your cart/i })).toBeVisible();
      }
    }

    const trainingCards = page.locator('section').filter({ hasText: 'Training Programs' }).locator('article');
    if (await trainingCards.count() > 0) {
      const beginnerTrainingCard = trainingCards.filter({ hasText: 'Beginner Private Training' });
      if (await beginnerTrainingCard.count() > 0) {
        await expect(beginnerTrainingCard).toContainText('Training');
        await expect(beginnerTrainingCard).toContainText('$4,097.00');
      }
    }
  });

  test('should expose checkout controls responsively on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/products');
    await page.waitForLoadState('networkidle');

    const productCards = page.locator('section').filter({ hasText: 'Products' }).locator('article');
    const count = await productCards.count();

    if (count > 0) {
      await expect(productCards.first().getByRole('button', { name: /buy now|add to cart/i }).first()).toBeVisible();

      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
    }
  });

  test('should expose accessible catalog filter, sort, result count, and product card controls', async ({ page }) => {
    await page.goto('/products');
    await page.waitForLoadState('networkidle');

    await expect(page.getByRole('heading', { name: 'Catalog' })).toBeVisible();
    await expect(page.getByRole('complementary', { name: /catalog filters/i })).toBeVisible();
    await expect(page.getByLabel(/sort by/i)).toBeVisible();
    await expect(page.getByText(/showing\s+\d+\s+products/i)).toBeVisible();

    const productCards = page.locator('section').filter({ hasText: 'Products' }).locator('article');
    const count = await productCards.count();

    if (count === 0) {
      return;
    }

    const firstCard = productCards.first();
    await expect(firstCard.getByRole('heading')).toBeVisible();
    await expect(firstCard.getByRole('link').first()).toBeVisible();
    await expect(firstCard.getByRole('button', { name: /buy now|add (to cart|option)|sold out|unavailable/i }).first()).toBeVisible();
  });
});
