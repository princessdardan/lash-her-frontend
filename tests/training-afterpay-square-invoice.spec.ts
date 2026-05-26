import { expect, test, type Page } from "@playwright/test";

const PROGRAM_SLUG = "beginner-private-training";
const CHECKOUT_URL = `/training-programs/${PROGRAM_SLUG}/checkout?mockPaymentScenario=square_invoice_unpaid`;
const CUSTOMER_NAME = "Afterpay Invoice Tester";
const CUSTOMER_EMAIL = "afterpay.invoice@example.com";
const CLIENT_PRICE = 499;
const ORDER_ID = "lh-training-square-invoice-test-order";
const INVOICE_ID = "mock-square-invoice-afterpay-001";
const SQUARE_INVOICE_URL = `/mock-square/invoices/${INVOICE_ID}`;
const CONFIRMATION_URL = `/training-programs/${PROGRAM_SLUG}/confirmation?order=${ORDER_ID}`;
const FORBIDDEN_PAYMENT_HOSTS = new Set(["api.helcim.com", "connect.squareup.com", "connect.squareupsandbox.com"]);

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

async function setupMockTrainingAfterpayFlow(page: Page): Promise<{ apiPostPaths: string[]; webhookEvents: string[] }> {
  let invoicePaid = false;
  const apiPostPaths: string[] = [];
  const webhookEvents: string[] = [];

  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const url = new URL(request.url());
    if (url.origin !== "http://localhost:3000" || !url.pathname.startsWith("/api/")) return;
    apiPostPaths.push(url.pathname);
  });

  await page.route(new RegExp(`/training-programs/${PROGRAM_SLUG}/checkout(?:$|\\?)`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html>
        <html>
          <head><title>Training Checkout | Lash Her</title></head>
          <body>
            <main>
              <h1>Enrollment Checkout</h1>
              <h2>Beginner Private Training</h2>
              <section aria-label="Payment summary">
                <p>Total <strong>$563.87 CAD</strong></p>
              </section>
              <form aria-label="Training checkout">
                <label for="name">Full Name</label>
                <input id="name" name="name" type="text" autocomplete="name" />
                <label for="email">Email Address</label>
                <input id="email" name="email" type="email" autocomplete="email" />
                <label for="terms">
                  <input id="terms" name="terms" type="checkbox" />
                  I acknowledge the terms
                </label>
              </form>
              <section aria-label="Payment options" data-testid="training-payment-options">
                <button id="helcim" type="button" disabled>Secure Payment</button>
                <div aria-label="Secondary option">
                  <button id="afterpay" type="button" aria-describedby="training-afterpay-invoice-note" disabled>Pay with Afterpay</button>
                  <p id="training-afterpay-invoice-note">Afterpay availability is determined by Square at checkout. Your enrollment will be activated once the invoice is paid.</p>
                  <p id="training-afterpay-invoice-error" role="alert" hidden></p>
                </div>
              </section>
              <script>
                const nameInput = document.getElementById('name');
                const emailInput = document.getElementById('email');
                const terms = document.getElementById('terms');
                const helcim = document.getElementById('helcim');
                const afterpay = document.getElementById('afterpay');
                function syncValidity() {
                  const valid = nameInput.value.trim().length > 0 && emailInput.value.includes('@') && terms.checked;
                  helcim.disabled = !valid;
                  afterpay.disabled = !valid;
                }
                [nameInput, emailInput].forEach((field) => field.addEventListener('input', syncValidity));
                terms.addEventListener('change', syncValidity);
                afterpay.addEventListener('click', async () => {
                  if (afterpay.disabled) return;
                  afterpay.setAttribute('aria-busy', 'true');
                  afterpay.textContent = 'Preparing invoice...';
                  const response = await fetch('/api/training-checkout/square-invoice', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-lash-payment-mock-scenario': 'square_invoice_unpaid' },
                    body: JSON.stringify({
                      programSlug: '${PROGRAM_SLUG}',
                      customerName: nameInput.value,
                      customerEmail: emailInput.value,
                      clientPrice: ${CLIENT_PRICE}
                    })
                  });
                  const data = await response.json();
                  if (!response.ok || !data.publicUrl) {
                    document.getElementById('training-afterpay-invoice-error').hidden = false;
                    document.getElementById('training-afterpay-invoice-error').textContent = data.error || 'Unable to start the invoice checkout. Please try again.';
                    afterpay.removeAttribute('aria-busy');
                    afterpay.textContent = 'Pay with Afterpay';
                    return;
                  }
                  window.location.assign(data.publicUrl);
                });
              </script>
            </main>
          </body>
        </html>`,
    });
  });

  await page.route(/\/api\/training-checkout\/square-invoice(?:\?.*)?$/, async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-lash-payment-mock-scenario"]).toBe("square_invoice_unpaid");
    expect(route.request().postDataJSON()).toEqual({
      programSlug: PROGRAM_SLUG,
      customerName: CUSTOMER_NAME,
      customerEmail: CUSTOMER_EMAIL,
      clientPrice: CLIENT_PRICE,
    });

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ publicUrl: SQUARE_INVOICE_URL, orderId: ORDER_ID }),
    });
  });

  await page.route(new RegExp(`${SQUARE_INVOICE_URL}(?:$|\\?)`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html>
        <html>
          <head><title>Square Invoice Mock</title></head>
          <body>
            <main>
              <h1>Square invoice pending</h1>
              <p>Invoice ${INVOICE_ID} is waiting for Afterpay approval.</p>
              <p role="status">Invoice pending payment</p>
              <p>Your enrollment will not be activated until this invoice is paid.</p>
              <button id="pay">Mock paid webhook and finalizer</button>
              <script>
                document.getElementById('pay').addEventListener('click', async () => {
                  const response = await fetch('/api/webhooks/square', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-lash-payment-mock-scenario': 'square_invoice_success' },
                    body: JSON.stringify({
                      type: 'invoice.payment_made',
                      data: { object: { invoice: { id: '${INVOICE_ID}', order_id: 'mock-square-order-001', status: 'PAID' } } }
                    })
                  });
                  if (!response.ok) throw new Error('Mock finalizer failed');
                  window.location.href = '${CONFIRMATION_URL}';
                });
              </script>
            </main>
          </body>
        </html>`,
    });
  });

  await page.route(/\/api\/webhooks\/square(?:\?.*)?$/, async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-lash-payment-mock-scenario"]).toBe("square_invoice_success");
    expect(route.request().postDataJSON()).toMatchObject({
      type: "invoice.payment_made",
      data: { object: { invoice: { id: INVOICE_ID, status: "PAID" } } },
    });
    webhookEvents.push("invoice.payment_made");
    invoicePaid = true;

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, finalized: true, orderId: ORDER_ID }),
    });
  });

  await page.route(new RegExp(`/training-programs/${PROGRAM_SLUG}/confirmation\\?order=${ORDER_ID}$`), async (route) => {
    if (!invoicePaid) {
      await route.fulfill({
        status: 404,
        contentType: "text/html",
        body: "<!doctype html><main><h1>Not Found</h1><p>Enrollment is not confirmed until payment is finalized.</p></main>",
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html>
        <html>
          <head><title>Enrollment Confirmed | Lash Her</title></head>
          <body>
            <main>
              <h1>Enrollment Confirmed</h1>
              <h2>Beginner Private Training</h2>
              <p>Thank you for your enrollment! Your payment has been successfully processed.</p>
              <p>Order Reference</p>
              <p>${ORDER_ID}</p>
              <a href="/training-programs/${PROGRAM_SLUG}/schedule?token=mock-training-schedule-token">Schedule Training Call</a>
            </main>
          </body>
        </html>`,
    });
  });

  return { apiPostPaths, webhookEvents };
}

test.describe("Training Afterpay Square Invoice checkout", () => {
  test("shows pending invoice first and confirms enrollment only after paid finalization", async ({ page }) => {
    const forbiddenPaymentHosts = collectForbiddenPaymentHosts(page);
    const { apiPostPaths, webhookEvents } = await setupMockTrainingAfterpayFlow(page);

    await page.goto(CHECKOUT_URL);

    await expect(page.getByRole("heading", { name: "Enrollment Checkout" })).toBeVisible();
    const paymentOptions = page.getByTestId("training-payment-options");
    await expect(paymentOptions.getByRole("button", { name: /Secure Payment/i })).toBeVisible();
    await expect(paymentOptions.getByRole("button", { name: /Pay with Afterpay/i })).toBeVisible();
    await expect(page.locator("#training-afterpay-invoice-note")).toContainText(/enrollment will be activated once the invoice is paid/i);

    await page.getByLabel("Full Name").fill(CUSTOMER_NAME);
    await page.getByLabel("Email Address").fill(CUSTOMER_EMAIL);
    await page.getByLabel(/I acknowledge the terms/i).check();

    await expect(paymentOptions.getByRole("button", { name: /Secure Payment/i })).toBeEnabled();
    await expect(paymentOptions.getByRole("button", { name: /Pay with Afterpay/i })).toBeEnabled();
    await page.getByRole("button", { name: /Pay with Afterpay/i }).click();

    await expect(page).toHaveURL(SQUARE_INVOICE_URL);
    await expect(page.getByRole("heading", { name: /square invoice pending/i })).toBeVisible();
    await expect(page.getByRole("status")).toHaveText(/invoice pending payment/i);
    await expect(page.getByText(/enrollment will not be activated until this invoice is paid/i)).toBeVisible();
    await expect(page.getByRole("heading", { name: /enrollment confirmed/i })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /schedule training call/i })).toHaveCount(0);
    expect(apiPostPaths).toEqual(["/api/training-checkout/square-invoice"]);
    expect(webhookEvents).toEqual([]);

    await page.getByRole("button", { name: /mock paid webhook and finalizer/i }).click();

    await expect(page).toHaveURL(CONFIRMATION_URL);
    await expect(page.getByRole("heading", { name: "Enrollment Confirmed" })).toBeVisible();
    await expect(page.getByText(ORDER_ID)).toBeVisible();
    await expect(page.getByRole("link", { name: "Schedule Training Call" })).toBeVisible();
    expect(apiPostPaths).toEqual(["/api/training-checkout/square-invoice", "/api/webhooks/square"]);
    expect(webhookEvents).toEqual(["invoice.payment_made"]);
    expect(forbiddenPaymentHosts).toEqual([]);
  });
});
