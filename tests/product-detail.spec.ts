import { test, expect, type Page } from '@playwright/test';

const PRODUCT_CART_STORAGE_KEY = 'lash-her:product-cart:v1';

async function getProductDetailHrefs(page: Page): Promise<string[]> {
  await page.goto('/products');
  await page.waitForLoadState('networkidle');

  const productLinks = page.locator('section').filter({ hasText: 'Products' }).locator('a[href*="/products/"]');
  const count = await productLinks.count();
  const hrefs: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const href = await productLinks.nth(index).getAttribute('href');
    if (href && !hrefs.includes(href)) hrefs.push(href);
  }

  return hrefs;
}

async function openFirstProductDetail(page: Page): Promise<boolean> {
  const hrefs = await getProductDetailHrefs(page);
  if (hrefs.length === 0) return false;

  await page.goto(hrefs[0]);
  await page.waitForLoadState('networkidle');
  return true;
}

async function selectRequiredProductOptions(page: Page): Promise<void> {
  const main = page.locator('main');
  const optionGroups = main.locator('[role="group"]').filter({ has: page.getByRole('button') });
  const groupCount = await optionGroups.count();

  for (let index = 0; index < groupCount; index += 1) {
    const firstAvailableOption = optionGroups.nth(index).locator('button:not([disabled])').first();
    if (await firstAvailableOption.count() > 0 && await firstAvailableOption.isEnabled()) {
      await firstAvailableOption.click();
    }
  }
}

test.describe('Product Detail Page', () => {
  test('should display product details, gallery, purchase controls, and link back to catalog', async ({ page }) => {
    if (!await openFirstProductDetail(page)) {
      test.skip(true, 'No product detail page was available to open');
      return;
    }

    await expect(page.getByRole('heading', { name: /page not found/i })).toHaveCount(0);

    await expect(page.getByRole('link', { name: /back to catalog|back to products/i }).first()).toBeVisible();

    await expect(page.locator('main h1')).toBeVisible();

    const title = await page.locator('main h1').innerText();
    if (title.includes('Beginner Private Training')) {
      await expect(page.locator('main')).toContainText('training');
      await expect(page.locator('main')).toContainText('$4,097.00');
    }
     
    await expect(page.getByText(/detail pages are editorial only|purchases remain inside the catalog cart flow/i)).toHaveCount(0);

    const main = page.locator('main');
    const addToCart = main.getByRole('button', { name: /add to cart/i });
    if (await addToCart.count() > 0) {
      await expect(main.getByLabel(/quantity/i)).toBeVisible();
      await expect(addToCart.first()).toBeVisible();
      await expect(main.getByRole('button', { name: /buy now/i })).toBeVisible();
    }
  });

  test('should group option sections and avoid raw payment forms', async ({ page }) => {
    if (!await openFirstProductDetail(page)) {
      test.skip(true, 'No product detail page was available to open');
      return;
    }

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
      await expect(main.getByRole('button', { name: /add to cart/i })).toBeVisible();
      await expect(main.getByRole('button', { name: /buy now/i })).toBeVisible();
    }

    await expect(main.getByText(/stripe|card number|credit card number|cvc|cvv|expiry|expiration date/i)).toHaveCount(0);
    await expect(main.getByLabel(/card number|credit card|cvc|cvv|expiry|expiration/i)).toHaveCount(0);
    await expect(main.locator('input[autocomplete="cc-number"], input[name*="card" i], input[id*="card" i]')).toHaveCount(0);
  });

  test('should require a variant selection before PDP add to cart and buy now', async ({ page }) => {
    const hrefs = await getProductDetailHrefs(page);

    for (const href of hrefs.slice(0, 8)) {
      await page.goto(href);
      await page.waitForLoadState('networkidle');

      const main = page.locator('main');
      const addToCart = main.getByRole('button', { name: /add to cart/i });
      const buyNow = main.getByRole('button', { name: /buy now/i });

      if (await addToCart.count() === 0 || await buyNow.count() === 0) {
        test.skip(true, 'No product detail purchase controls were available to validate');
        return;
      }
      if (!await addToCart.first().isDisabled()) continue;

      await expect(buyNow.first()).toBeDisabled();
      await expect(main.getByText(/choose an available product option/i)).toBeVisible();

      await selectRequiredProductOptions(page);

      await expect(addToCart.first()).toBeEnabled();
      await expect(buyNow.first()).toBeEnabled();
      return;
    }
  });

  test('should add a PDP selection to cart and persist it across reload', async ({ page }) => {
    if (!await openFirstProductDetail(page)) {
      test.skip(true, 'No product detail page was available to open');
      return;
    }

    const main = page.locator('main');
    const addToCart = main.getByRole('button', { name: /add to cart/i }).first();

    if (await addToCart.count() === 0) {
      test.skip(true, 'No add to cart button was available on the product detail page');
      return;
    }
    if (await addToCart.isDisabled()) {
      await selectRequiredProductOptions(page);
    }

    await expect(addToCart).toBeEnabled();
    await addToCart.click();

    await expect(page.getByRole('complementary', { name: 'Shopping cart' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /review selection/i })).toBeVisible();
    await expect.poll(async () => page.evaluate((key) => window.localStorage.getItem(key) ?? '', PRODUCT_CART_STORAGE_KEY)).toContain('productId');

    await page.reload();
    await page.waitForLoadState('networkidle');

    await expect.poll(async () => page.evaluate((key) => window.localStorage.getItem(key) ?? '', PRODUCT_CART_STORAGE_KEY)).toContain('productId');
    const cartButton = page.getByRole('button', { name: /open cart with/i }).first();
    await expect(cartButton).toBeVisible();
    await cartButton.click();
    await expect(page.getByRole('complementary', { name: 'Shopping cart' })).toBeVisible();
  });

  test('should send only the Buy Now selection in the checkout request', async ({ page }) => {
    const hrefs = await getProductDetailHrefs(page);
    if (hrefs.length === 0) {
      test.skip(true, 'No product detail pages were available to open');
      return;
    }

    await page.route('https://secure.helcim.app/helcim-pay/services/start.js', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: 'window.appendHelcimPayIframe = window.appendHelcimPayIframe || function () {}; window.removeHelcimPayIframe = window.removeHelcimPayIframe || function () {};',
      });
    });

    let checkoutPayload: unknown;
    await page.route('**/api/checkout', async (route) => {
      checkoutPayload = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ checkoutToken: 'mock-checkout-token' }),
      });
    });

    await page.addInitScript((key) => {
      window.localStorage.setItem(key, JSON.stringify([{ productId: 'cart-only-product', quantity: 1 }]));
    }, PRODUCT_CART_STORAGE_KEY);

    await page.goto(hrefs[0]);
    await page.waitForLoadState('networkidle');

    const main = page.locator('main');
    const buyNow = main.getByRole('button', { name: /buy now/i }).first();
    if (await buyNow.count() === 0) {
      test.skip(true, 'No buy now button was available on the product detail page');
      return;
    }
    if (await buyNow.isDisabled()) await selectRequiredProductOptions(page);

    await expect(buyNow).toBeEnabled();
    await buyNow.click();

    const cartAside = page.getByRole('complementary', { name: 'Shopping cart' });
    await expect(cartAside).toContainText(/buy now/i);
    await cartAside.getByLabel(/^Name$/i).fill('Checkout Tester');
    await cartAside.getByLabel(/^Email$/i).fill('checkout-tester@example.com');

    const checkout = cartAside.getByRole('button', { name: /checkout/i });
    await expect(checkout).toBeEnabled();
    await checkout.click();

    expect(checkoutPayload).toBeDefined();
    const payload = checkoutPayload as { items?: Array<{ productId: string; quantity: number }> };
    expect(payload.items).toHaveLength(1);
    expect(payload.items?.[0]?.productId).not.toBe('cart-only-product');

    const storedCart = await page.evaluate((key) => {
      const rawCart = window.localStorage.getItem(key);
      return rawCart ? JSON.parse(rawCart) as Array<{ productId: string; quantity: number }> : [];
    }, PRODUCT_CART_STORAGE_KEY);
    expect(storedCart).toContainEqual({ productId: 'cart-only-product', quantity: 1 });
  });

  test('should show saved cart after closing Buy Now instead of sticky Buy Now payload', async ({ page }) => {
    const hrefs = await getProductDetailHrefs(page);
    if (hrefs.length === 0) {
      test.skip(true, 'No product detail pages were available to open');
      return;
    }

    await page.goto(hrefs[0]);
    await page.waitForLoadState('networkidle');

    const main = page.locator('main');
    const addToCart = main.getByRole('button', { name: /add to cart/i }).first();
    if (await addToCart.count() === 0) {
      test.skip(true, 'No add to cart button was available on the product detail page');
      return;
    }
    if (await addToCart.isDisabled()) await selectRequiredProductOptions(page);

    await addToCart.click();
    await expect(page.getByRole('complementary', { name: 'Shopping cart' })).toContainText(/your cart/i);
    await page.getByRole('button', { name: /^close$/i }).click();

    if (hrefs.length > 1) {
      await page.goto(hrefs[1]);
      await page.waitForLoadState('networkidle');
    }

    const secondMain = page.locator('main');
    const buyNow = secondMain.getByRole('button', { name: /buy now/i }).first();
    if (await buyNow.count() === 0) {
      test.skip(true, 'No buy now button was available on the second product detail page');
      return;
    }
    if (await buyNow.isDisabled()) await selectRequiredProductOptions(page);

    await buyNow.click();
    await expect(page.getByRole('complementary', { name: 'Shopping cart' })).toContainText(/buy now/i);
    await page.getByRole('button', { name: /^close$/i }).click();

    await page.getByRole('button', { name: /open cart with/i }).first().click();
    const cartAside = page.getByRole('complementary', { name: 'Shopping cart' });
    await expect(cartAside).toBeVisible();
    await expect(cartAside).toContainText(/your cart/i);
    await expect(cartAside).not.toContainText(/^Buy Now$/);
    await expect(cartAside).not.toContainText(/catalog item/i);
  });
});
