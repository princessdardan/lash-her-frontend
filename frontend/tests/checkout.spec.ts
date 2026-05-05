import { expect, type Page, test } from "@playwright/test";

const CHECKOUT_TOKEN = "checkout_test_token";
const ORDER_ID = "lh-test-order";

interface ValidationRequestBody {
  checkoutToken: string;
  data: Record<string, string | number | boolean | null>;
  hash: string;
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

async function mockShopWithProduct(page: Page): Promise<void> {
  await page.route("**/shop", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `
        <!doctype html>
        <html lang="en">
          <head>
            <title>Shop | Lash Her</title>
            <script>
              window.__markHelcimReady = function () {
                window.__helcimScriptReady = true;
              };
            </script>
            <script src="https://secure.helcim.app/helcim-pay/services/start.js" onload="window.__markHelcimReady()"></script>
          </head>
          <body>
            <main>
              <h1>Shop</h1>
              <p>Discover our curated selection of premium lash products and training materials.</p>
              <section class="card-white" aria-label="Classic Lash Set Deposit">
                <h3>Classic Lash Set Deposit</h3>
                <p>Deposit for a classic lash set appointment.</p>
                <button type="button" id="add-product">Add to Cart</button>
              </section>
              <aside aria-label="Your Cart">
                <h2>Your Cart</h2>
                <div aria-live="polite" id="cart-status">0 items in cart</div>
                <p id="empty-cart">Your cart is empty.</p>
                <ul id="cart-items"></ul>
                <label for="customerName">Name</label>
                <input id="customerName" />
                <label for="customerEmail">Email</label>
                <input id="customerEmail" type="email" />
                <div id="checkout-error" role="alert" hidden></div>
                <button type="button" id="checkout" disabled>Checkout</button>
                <button type="button" id="clear-cart" hidden>Clear Cart</button>
              </aside>
            </main>
            <script>
              const product = { productId: "product-classic", title: "Classic Lash Set Deposit" };
              let cartQuantity = 0;
              let scriptReady = false;
              let checkoutToken = null;

              const addButton = document.getElementById("add-product");
              const cartStatus = document.getElementById("cart-status");
              const emptyCart = document.getElementById("empty-cart");
              const cartItems = document.getElementById("cart-items");
              const nameInput = document.getElementById("customerName");
              const emailInput = document.getElementById("customerEmail");
              const alert = document.getElementById("checkout-error");
              const checkoutButton = document.getElementById("checkout");
              const clearButton = document.getElementById("clear-cart");

              function renderCart() {
                cartStatus.textContent = cartQuantity + " items in cart";
                emptyCart.hidden = cartQuantity > 0;
                clearButton.hidden = cartQuantity === 0;
                cartItems.innerHTML = cartQuantity > 0
                  ? "<li><strong>" + product.title + "</strong><p>Qty: " + cartQuantity + " x $50.00 CAD</p></li>"
                  : "";
                checkoutButton.disabled = !scriptReady || cartQuantity === 0 || !nameInput.value || !emailInput.value;
              }

              window.__markHelcimReady = function () {
                window.__helcimScriptReady = true;
                scriptReady = true;
                renderCart();
              };

              if (window.__helcimScriptReady) {
                window.__markHelcimReady();
              }

              addButton.addEventListener("click", function () {
                cartQuantity = 1;
                renderCart();
              });
              nameInput.addEventListener("input", renderCart);
              emailInput.addEventListener("input", renderCart);
              clearButton.addEventListener("click", function () {
                cartQuantity = 0;
                renderCart();
              });

              window.addEventListener("message", async function (event) {
                if (event.origin !== "https://secure.helcim.app") return;
                const eventData = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
                if (!checkoutToken || eventData.eventName !== "helcim-pay-js-" + checkoutToken) return;
                if (eventData.eventStatus !== "SUCCESS") return;

                const validationResponse = await fetch("/api/checkout/validate-payment", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    checkoutToken,
                    data: eventData.eventMessage.data,
                    hash: eventData.eventMessage.hash
                  })
                });

                if (!validationResponse.ok) return;
                const validation = await validationResponse.json();
                window.removeHelcimPayIframe();
                cartQuantity = 0;
                window.location.assign("/shop/confirmation?order=" + encodeURIComponent(validation.orderId));
              });

              checkoutButton.addEventListener("click", async function () {
                alert.hidden = true;
                const response = await fetch("/api/checkout", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    customer: { name: nameInput.value, email: emailInput.value },
                    items: [{ productId: product.productId, quantity: cartQuantity }]
                  })
                });

                if (!response.ok) {
                  alert.textContent = "Unable to start checkout. Please review your cart and try again.";
                  alert.hidden = false;
                  return;
                }

                const checkout = await response.json();
                checkoutToken = checkout.checkoutToken;
                window.appendHelcimPayIframe(checkout.checkoutToken, true);
              });

              renderCart();
            </script>
          </body>
        </html>
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
  test("shows the shop page", async ({ page }) => {
    await page.goto("/shop");

    await expect(page.getByRole("heading", { name: "Shop" })).toBeVisible();
    await expect(page.getByText(/discover our curated selection/i)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Your Cart" })).toBeVisible();
  });

  test("handles checkout initialization failure without clearing cart", async ({ page }) => {
    await mockHelcimScript(page, { dispatchSuccess: false });
    await mockShopWithProduct(page);

    await page.route("**/api/checkout", async (route) => {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "Unable to start checkout" }),
      });
    });

    await page.goto("/shop");

    const productTitle = await addFirstProductToCart(page);
    await fillCheckoutCustomer(page);
    await page.getByRole("button", { name: "Checkout" }).click();

    await expect(page.getByRole("alert")).toContainText(/unable to start checkout/i);
    await expect(page.locator("li", { hasText: productTitle })).toContainText(/qty:\s*1/i);
    await expect(page.getByRole("button", { name: "Clear Cart" })).toBeVisible();
  });

  test("forwards successful Helcim events to validation and routes to confirmation", async ({ page }) => {
    await mockHelcimScript(page, { dispatchSuccess: true });
    await mockShopWithProduct(page);

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
        body: JSON.stringify({ orderId: ORDER_ID }),
      });
    });

    await page.goto("/shop");

    await addFirstProductToCart(page);
    await fillCheckoutCustomer(page);
    await page.getByRole("button", { name: "Checkout" }).click();

    await expect(page).toHaveURL(`/shop/confirmation?order=${ORDER_ID}`);
    await expect(page.getByRole("heading", { name: /payment received/i })).toBeVisible();
    await expect(page.getByText(ORDER_ID)).toBeVisible();
  });
});
