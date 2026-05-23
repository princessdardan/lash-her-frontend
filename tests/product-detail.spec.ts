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

  test('should group option sections when variant option groups exist and avoid raw payment forms', async ({ page }) => {
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

    const main = page.locator('main');
    await expect(main).toBeVisible();
    await expect(page.getByRole('heading', { name: /page not found/i })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /back to catalog|back to products/i }).first()).toBeVisible();
    await expect(main.locator('h1')).toBeVisible();

    const optionHeading = page.getByRole('heading', { name: /available options|choose option|options/i }).first();
    if (await optionHeading.count() > 0) {
      await expect(optionHeading).toBeVisible();
      const optionGroups = main.locator('[role="group"][aria-labelledby], fieldset, section').filter({ has: page.getByRole('heading', { name: /option|size|style|format|bundle|deposit|payment/i }) });
      await expect(optionGroups.first()).toBeVisible();
      await expect(main.getByRole('button', { name: /add to cart|checkout|pay now/i })).toHaveCount(0);
    }

    await expect(main.getByText(/stripe|card number|credit card number|cvc|cvv|expiry|expiration date/i)).toHaveCount(0);
    await expect(main.getByLabel(/card number|credit card|cvc|cvv|expiry|expiration/i)).toHaveCount(0);
    await expect(main.locator('input[autocomplete="cc-number"], input[name*="card" i], input[id*="card" i]')).toHaveCount(0);
  });
});
