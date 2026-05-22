import { expect, type Page, test } from "@playwright/test";

const CHECKOUT_TOKEN = "checkout_test_token";
const ORDER_ID = "lh-test-order";

interface ValidationRequestBody {
  checkoutToken: string;
  data: Record<string, string | number | boolean | null>;
  hash: string;
}


async function mockProductsPage(page: Page): Promise<void> {
  // The local CMS dataset can have no active products, so this shell keeps checkout
  // coverage focused on Helcim and validation route contracts rather than CMS content.
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
                <label>Name <input id="name" /></label>
                <label>Email <input id="email" /></label>
                <button id="checkout">Checkout</button>
                <button>Clear Cart</button>
                <p id="error" role="alert"></p>
              </aside>
              <script src="https://secure.helcim.app/helcim-pay/services/start.js"></script>
              <script>
                let checkoutToken = '';
                document.getElementById('add').addEventListener('click', () => {
                  document.getElementById('cart').hidden = false;
                });
                document.getElementById('checkout').addEventListener('click', async () => {
                  const response = await fetch('/api/checkout', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      customer: {
                        name: document.getElementById('name').value,
                        email: document.getElementById('email').value
                      },
                      cart: [{ productId: 'lash-cleanser', quantity: 1 }]
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
                  const message = data.eventMessage;
                  const response = await fetch('/api/checkout/validate-payment', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ checkoutToken, data: message.data, hash: message.hash })
                  });
                  const result = await response.json();
                  window.location.href = result.redirectUrl || ('/products/confirmation?order=' + result.orderId);
                });
              </script>
            </main>
          </body>
        </html>`,
    });
  });
}

async function mockHelcimScript(page: Page, options: { dispatchSuccess: boolean }): Promise<void> {
  await page.route("https://secure.helcim.app/helcim-pay/services/start.js", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: `
        window.appendHelcimPayIframe = function (checkoutToken, allowExit) {
          window.__helcimAppendCall = { checkoutToken: checkoutToken, allowExit: allowExit };
          if (${String(options.dispatchSuccess)}) {
            window.setTimeout(function () {
              window.dispatchEvent(new MessageEvent("message", {
                origin: "https://secure.helcim.app",
                data: JSON.stringify({
                  eventName: "helcim-pay-js-" + checkoutToken,
                  eventStatus: "SUCCESS",
                  eventMessage: {
                    data: {
                      transactionId: "txn_123",
                      amount: 50,
                      approved: true
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
    await mockHelcimScript(page, { dispatchSuccess: false });

    await page.route("**/api/checkout", async (route) => {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "Unable to start checkout" }),
      });
    });

    await page.goto("/products");

    const productTitle = await addFirstProductToCart(page);
    await fillCheckoutCustomer(page);
    await expect(page.getByRole("button", { name: "Checkout" })).toBeEnabled();
    await page.getByRole("button", { name: "Checkout" }).click();

    await expect(page.getByText(/unable to start checkout/i)).toBeVisible();
    await expect(page.locator("li", { hasText: productTitle })).toContainText(/qty:\s*1/i);
    await expect(page.getByRole("button", { name: "Clear Cart" })).toBeVisible();
  });

  test("forwards successful Helcim events to validation and routes to confirmation", async ({ page }) => {
    await mockProductsPage(page);
    await mockHelcimScript(page, { dispatchSuccess: true });

    await page.route("**/api/checkout", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ checkoutToken: CHECKOUT_TOKEN }),
      });
    });

    await page.route("**/api/checkout/validate-payment", async (route) => {
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
    await fillCheckoutCustomer(page);
    await expect(page.getByRole("button", { name: "Checkout" })).toBeEnabled();
    await page.getByRole("button", { name: "Checkout" }).click();

    await expect(page).toHaveURL(`/products/confirmation?order=${ORDER_ID}`);
    await expect(page.getByRole("heading", { name: /payment received/i })).toBeVisible();
    await expect(page.getByText(ORDER_ID)).toBeVisible();
  });
});
