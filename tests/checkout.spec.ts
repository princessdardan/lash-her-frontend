import { expect, type Page, test } from "@playwright/test";

const CHECKOUT_TOKEN = "checkout_test_token";
const ORDER_ID = "lh-test-order";
const FORBIDDEN_PAYMENT_HOSTS = new Set(["api.helcim.com", "connect.squareup.com", "connect.squareupsandbox.com"]);

interface ValidationRequestBody {
  checkoutToken: string;
  data: Record<string, string | number | boolean | null>;
  hash: string;
}


async function mockProductsPage(page: Page): Promise<void> {
  await page.route(/\/products(?:$|\?)/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html>
        <html>
          <body>
            <main>
              <h1>Products</h1>
              <p>Discover our curated selection</p>
              <section class="card-white">
                <h3>Lash Cleanser</h3>
                <button id="add">Add to Cart</button>
              </section>
              <aside id="cart" hidden>
                <h2>Your Cart</h2>
                <ul><li>Lash Cleanser <span>qty: 1</span></li></ul>
                <button id="checkout">Checkout</button>
                <button>Clear Cart</button>
                <p id="error" role="alert"></p>
              </aside>
              <script>
                document.getElementById('add').addEventListener('click', () => {
                  document.getElementById('cart').hidden = false;
                });
                document.getElementById('checkout').addEventListener('click', () => {
                  window.location.href = '/checkout';
                });
              </script>
            </main>
          </body>
        </html>`,
    });
  });

  await page.route(/\/checkout(?:$|\?)/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html>
        <html>
          <body>
            <main>
              <h1>Review Your Order</h1>
              <ul><li>Lash Cleanser <span>qty: 1</span></li></ul>
              <label>Name <input id="name" /></label>
              <label>Email <input id="email" /></label>
              <label>Address <input id="line1" /></label>
              <label>City <input id="city" /></label>
              <label>Province / State <input id="province" /></label>
              <label>Postal code <input id="postalCode" /></label>
              <label>Country <input id="country" value="Canada" /></label>
              <button id="checkout">Checkout</button>
              <p id="error" role="alert"></p>
              <script src="https://secure.helcim.app/helcim-pay/services/start.js"></script>
              <script>
                let checkoutToken = '';
                document.getElementById('checkout').addEventListener('click', async () => {
                  const response = await fetch('/api/checkout?mockPaymentScenario=success', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-lash-payment-mock-scenario': 'success' },
                    body: JSON.stringify({
                      customer: {
                        name: document.getElementById('name').value,
                        email: document.getElementById('email').value
                      },
                      items: [{ productId: 'lash-cleanser', quantity: 1 }],
                      shippingAddress: {
                        line1: document.getElementById('line1').value,
                        city: document.getElementById('city').value,
                        province: document.getElementById('province').value,
                        postalCode: document.getElementById('postalCode').value,
                        country: document.getElementById('country').value
                      }
                    })
                  });
                  if (!response.ok) {
                    const data = await response.json();
                    document.getElementById('error').textContent = data.error;
                    return;
                  }
                  const data = await response.json();
                  checkoutToken = data.checkoutToken;
                  window.appendHelcimPayIframe(checkoutToken, true);
                });
                window.addEventListener('message', async (event) => {
                  if (event.origin !== 'https://secure.helcim.app') return;
                  const data = JSON.parse(event.data);
                  if (data.eventStatus !== 'SUCCESS') {
                    window.removeHelcimPayIframe();
                    document.getElementById('error').textContent = 'Payment was not completed. Please try again or use another payment method.';
                    return;
                  }
                  const message = data.eventMessage;
                  const response = await fetch('/api/checkout/validate-payment', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ checkoutToken, data: message.data, hash: message.hash })
                  });
                  const result = await response.json();
                  if (!response.ok) {
                    document.getElementById('error').textContent = result.error || 'Payment could not be verified';
                    return;
                  }
                  window.location.href = result.redirectUrl || ('/products/confirmation?order=' + result.orderId);
                });
              </script>
            </main>
          </body>
        </html>`,
    });
  });
}

async function mockHelcimScript(page: Page, options: { scenario: "success" | "decline" | "none" }): Promise<void> {
  await page.route("https://secure.helcim.app/helcim-pay/services/start.js", async (route) => {
    const approved = options.scenario === "success";
    const transactionId = approved ? "txn_123" : "txn_declined_123";
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: `
        window.appendHelcimPayIframe = function (checkoutToken, allowExit) {
          window.__helcimAppendCall = { checkoutToken: checkoutToken, allowExit: allowExit };
          if (${String(options.scenario !== "none")}) {
            window.setTimeout(function () {
              window.dispatchEvent(new MessageEvent("message", {
                origin: "https://secure.helcim.app",
                data: JSON.stringify({
                  eventName: "helcim-pay-js-" + checkoutToken,
                  eventStatus: "${approved ? "SUCCESS" : "DECLINED"}",
                  eventMessage: {
                    data: {
                      transactionId: "${transactionId}",
                      amount: 50,
                      approved: ${String(approved)}
                    },
                    hash: "hash_123"
                  }
                })
              }));
            }, 50);
          }
        };
        window.removeHelcimPayIframe = function () {
          window.__helcimIframeRemoved = true;
        };
      `,
    });
  });
}

function collectForbiddenPaymentHosts(page: Page): string[] {
  const hosts: string[] = [];

  page.on("request", (request) => {
    const host = new URL(request.url()).host;

    if (FORBIDDEN_PAYMENT_HOSTS.has(host)) {
      hosts.push(host);
    }
  });

  return hosts;
}

async function addFirstProductToCart(page: Page): Promise<string> {
  const addButton = page.getByRole("button", { name: /add to cart/i }).first();
  await expect(addButton).toBeVisible();

  const productCard = addButton.locator("xpath=ancestor::*[contains(@class, 'card-white')][1]");
  const productTitle = await productCard.locator("h3").innerText();

  await addButton.click();

  return productTitle;
}

async function fillCheckoutCustomer(page: Page): Promise<void> {
  await page.getByLabel("Name").fill("Nataliea Test");
  await page.getByLabel("Email").fill("test@example.com");
  await page.getByLabel("Address").fill("646 Oakwood Avenue");
  await page.getByLabel("City").fill("Toronto");
  await page.getByLabel("Province / State").fill("Ontario");
  await page.getByLabel("Postal code").fill("M6E 2Y4");
  await page.getByLabel("Country").fill("Canada");
}

function isValidationRequestBody(value: unknown): value is ValidationRequestBody {
  if (!value || typeof value !== "object") return false;

  const record = value as Record<string, unknown>;
  return (
    record.checkoutToken === CHECKOUT_TOKEN &&
    typeof record.hash === "string" &&
    !!record.data &&
    typeof record.data === "object"
  );
}

test.describe("Helcim checkout", () => {
  test("uses a mocked product shell to expose cart controls for checkout API coverage", async ({ page }) => {
    await mockProductsPage(page);

    await page.goto("/products");

    await expect(page.getByRole("heading", { name: "Products" })).toBeVisible();
    await expect(page.getByText(/discover our curated selection/i)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Your Cart" })).toBeHidden();
    await expect(page.getByRole("button", { name: /add to cart/i }).first()).toBeVisible();
  });

  test("handles checkout initialization failure without clearing cart", async ({ page }) => {
    await mockProductsPage(page);
    await mockHelcimScript(page, { scenario: "none" });

    await page.route(/\/api\/checkout(?:\?.*)?$/, async (route) => {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "Unable to start checkout" }),
      });
    });

    await page.goto("/products");

    const productTitle = await addFirstProductToCart(page);
    await page.getByRole("button", { name: "Checkout" }).click();
    await expect(page).toHaveURL("/checkout");
    await fillCheckoutCustomer(page);
    await expect(page.getByRole("button", { name: "Checkout" })).toBeEnabled();
    await page.getByRole("button", { name: "Checkout" }).click();

    await expect(page.getByText(/unable to start checkout/i)).toBeVisible();
    await expect(page.locator("li", { hasText: productTitle })).toContainText(/qty:\s*1/i);
    await expect(page.getByRole("button", { name: "Checkout" })).toBeEnabled();
  });

  test("forwards successful Helcim events to validation and routes to confirmation", async ({ page }) => {
    await mockProductsPage(page);
    await mockHelcimScript(page, { scenario: "success" });
    const apiPostPaths: string[] = [];
    const forbiddenPaymentHosts = collectForbiddenPaymentHosts(page);

    page.on("request", (request) => {
      if (request.method() !== "POST") return;
      const url = new URL(request.url());
      if (url.origin !== "http://localhost:3000" || !url.pathname.startsWith("/api/")) return;
      apiPostPaths.push(url.pathname);
    });

    await page.route(/\/api\/checkout(?:\?.*)?$/, async (route) => {
      const requestBody: unknown = route.request().postDataJSON();
      expect(requestBody).toEqual({
        customer: { name: "Nataliea Test", email: "test@example.com" },
        items: [{ productId: "lash-cleanser", quantity: 1 }],
        shippingAddress: {
          line1: "646 Oakwood Avenue",
          city: "Toronto",
          province: "Ontario",
          postalCode: "M6E 2Y4",
          country: "Canada",
        },
      });
      expect(new URL(route.request().url()).searchParams.get("mockPaymentScenario")).toBe("success");
      expect(route.request().headers()["x-lash-payment-mock-scenario"]).toBe("success");

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ checkoutToken: CHECKOUT_TOKEN }),
      });
    });

    await page.route(/\/api\/checkout\/validate-payment(?:\?.*)?$/, async (route) => {
      const requestBody: unknown = route.request().postDataJSON();
      expect(isValidationRequestBody(requestBody)).toBe(true);

      if (!isValidationRequestBody(requestBody)) {
        await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Invalid request" }) });
        return;
      }

      expect(requestBody.data.transactionId).toBe("txn_123");
      expect(requestBody.hash).toBe("hash_123");

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ orderId: ORDER_ID, redirectUrl: `/products/confirmation?order=${ORDER_ID}` }),
      });
    });

    await page.goto("/products");

    await addFirstProductToCart(page);
    await page.getByRole("button", { name: "Checkout" }).click();
    await expect(page).toHaveURL("/checkout");
    await fillCheckoutCustomer(page);
    await expect(page.getByRole("button", { name: "Checkout" })).toBeEnabled();
    await page.getByRole("button", { name: "Checkout" }).click();

    await expect(page).toHaveURL(`/products/confirmation?order=${ORDER_ID}`);
    await expect(page.getByRole("heading", { name: /payment received/i })).toBeVisible();
    await expect(page.locator("#main-content").getByText(ORDER_ID)).toBeVisible();
    expect(apiPostPaths).toEqual(["/api/checkout", "/api/checkout/validate-payment"]);
    expect(apiPostPaths).not.toContain("/api/training-checkout");
    expect(apiPostPaths.some((path) => /^\/api\/(payment|payments|stripe)\b/.test(path))).toBe(false);
    expect(forbiddenPaymentHosts).toEqual([]);
  });

  test("keeps cart visible when Helcim reports a declined payment", async ({ page }) => {
    await mockProductsPage(page);
    await mockHelcimScript(page, { scenario: "decline" });
    const apiPostPaths: string[] = [];
    const forbiddenPaymentHosts = collectForbiddenPaymentHosts(page);

    page.on("request", (request) => {
      if (request.method() !== "POST") return;
      const url = new URL(request.url());
      if (url.origin !== "http://localhost:3000" || !url.pathname.startsWith("/api/")) return;
      apiPostPaths.push(url.pathname);
    });

    await page.route(/\/api\/checkout(?:\?.*)?$/, async (route) => {
      expect(new URL(route.request().url()).searchParams.get("mockPaymentScenario")).toBe("success");

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ checkoutToken: CHECKOUT_TOKEN }),
      });
    });

    await page.route(/\/api\/checkout\/validate-payment(?:\?.*)?$/, async (route) => {
      throw new Error(`Declined Helcim status should not call validation: ${route.request().url()}`);
    });

    await page.goto("/products");

    const productTitle = await addFirstProductToCart(page);
    await page.getByRole("button", { name: "Checkout" }).click();
    await expect(page).toHaveURL("/checkout");
    await fillCheckoutCustomer(page);
    await page.getByRole("button", { name: "Checkout" }).click();

    await expect(page.getByRole("alert")).toContainText(/payment was not completed/i);
    await expect(page).toHaveURL(/\/checkout$/);
    await expect(page.locator("li", { hasText: productTitle })).toContainText(/qty:\s*1/i);
    await expect(page.getByRole("button", { name: "Checkout" })).toBeEnabled();
    expect(apiPostPaths).toEqual(["/api/checkout"]);
    expect(await page.evaluate(() => window.__helcimIframeRemoved)).toBe(true);
    expect(forbiddenPaymentHosts).toEqual([]);
  });
});
