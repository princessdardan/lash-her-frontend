import { createHmac } from "node:crypto";

import { expect, test, type Page, type Route } from "@playwright/test";

import { createTrainingSquareInvoicePostHandler } from "../src/app/api/training-checkout/square-invoice/route";
import { createSquareWebhookPostHandler } from "../src/app/api/webhooks/square/route";
import type { CheckoutOrderRow } from "../src/lib/commerce/order-store";
import type { SquareInvoiceDetails, SquareInvoiceOrderDetails } from "../src/lib/commerce/square-invoice-client";
import { createTrainingSquareInvoiceFinalizer } from "../src/lib/commerce/training-square-invoice-finalizer";

const PROGRAM_SLUG = "beginner-private-training";
const CHECKOUT_URL = `/training-programs/${PROGRAM_SLUG}/checkout?mockPaymentScenario=square_invoice_unpaid`;
const CUSTOMER_NAME = "Afterpay Invoice Tester";
const CUSTOMER_EMAIL = "afterpay.invoice@example.com";
const CLIENT_PRICE = 499;
const TOTAL_CENTS = 56387;
const ORDER_ID = "lh-training-square-invoice-test-order";
const CORRELATION_ID = "training-square-invoice-correlation";
const INVOICE_ID = "mock-square-invoice-afterpay-001";
const SQUARE_ORDER_ID = "mock-square-order-001";
const SQUARE_PAYMENT_ID = "mock-square-payment-001";
const SCHEDULING_TOKEN = "mock-training-schedule-token";
const SQUARE_INVOICE_PATH = `/mock-square/invoices/${INVOICE_ID}`;
const SQUARE_INVOICE_URL = `http://localhost:3000${SQUARE_INVOICE_PATH}`;
const CONFIRMATION_PATH = `/training-programs/${PROGRAM_SLUG}/confirmation?order=${ORDER_ID}`;
const CONFIRMATION_URL = `http://localhost:3000${CONFIRMATION_PATH}`;
const WEBHOOK_URL = "http://localhost:3000/api/webhooks/square";
const WEBHOOK_SIGNATURE_KEY = "mock-square-webhook-signature-key";
const FORBIDDEN_PAYMENT_HOSTS = new Set(["api.helcim.com", "connect.squareup.com", "connect.squareupsandbox.com"]);

type EnrollmentRecord = Awaited<ReturnType<Parameters<typeof createTrainingSquareInvoiceFinalizer>[0]["getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId"]>>;
type SchedulingTokenRecord = Awaited<ReturnType<Parameters<typeof createTrainingSquareInvoiceFinalizer>[0]["getOrIssueTrainingSchedulingTokenForPaidOrder"]>>;

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
  let squareInvoice = createSquareInvoiceDetails("PUBLISHED");
  let squareOrder = createSquareOrderDetails();
  let pendingOrder: CheckoutOrderRow | null = null;
  let enrollment: EnrollmentRecord = null;
  const apiPostPaths: string[] = [];
  const webhookEvents: string[] = [];
  const processedWebhookEvents = new Set<string>();

  const finalizer = createTrainingSquareInvoiceFinalizer({
    async createTrainingEnrollment(input) {
      expect(input.checkoutOrderId).toBe("checkout-order-db-id");
      expect(input.checkoutEmail).toBe(CUSTOMER_EMAIL);
      enrollment = createEnrollmentRecord(requirePendingOrder());

      return {
        checkoutEmail: CUSTOMER_EMAIL,
        checkoutOrderId: "checkout-order-db-id",
        createdAt: new Date("2026-05-25T12:00:00.000Z"),
        id: "training-enrollment-id",
        productSnapshot: input.productSnapshot,
        programSnapshot: input.programSnapshot,
        purchaseKind: "full",
        scheduledAt: null,
        schedulingStatus: "pending",
        schedulingTokenHash: null,
        staffAlertedAt: null,
        studentPaymentEmailSentAt: null,
        tokenExpiresAt: null,
        tokenUsedAt: null,
        trainingEmailClaimedUntil: null,
        trainingEmailLastError: null,
        updatedAt: new Date("2026-05-25T12:00:00.000Z"),
      };
    },
    async findOrderBySquareInvoiceId(invoiceId) {
      return pendingOrder?.providerCheckoutId === invoiceId ? pendingOrder : null;
    },
    async getInvoice(invoiceId) {
      expect(invoiceId).toBe(INVOICE_ID);
      return squareInvoice;
    },
    async getOrder(orderId) {
      expect(orderId).toBe(SQUARE_ORDER_ID);
      return squareOrder;
    },
    async getOrIssueTrainingSchedulingTokenForPaidOrder(orderId) {
      expect(orderId).toBe(ORDER_ID);

      if (enrollment === null) {
        return null;
      }

      return {
        ...enrollment,
        schedulingToken: SCHEDULING_TOKEN,
      } satisfies SchedulingTokenRecord;
    },
    async getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId(orderId) {
      expect(orderId).toBe(ORDER_ID);
      return enrollment;
    },
    async markSquareInvoiceFinalizationFailed(orderId, error, retryable) {
      expect(orderId).toBe(ORDER_ID);
      pendingOrder = {
        ...requirePendingOrder(),
        providerMetadata: {
          ...getProviderMetadata(requirePendingOrder()),
          finalizationError: error,
          finalizationRetryable: retryable,
          finalizationStatus: "failed",
        },
        providerStatus: "finalization_failed",
      };
    },
    async markSquareInvoicePaid(orderId, paymentId) {
      expect(orderId).toBe(ORDER_ID);
      expect(paymentId).toBe(SQUARE_PAYMENT_ID);
      invoicePaid = true;
      pendingOrder = {
        ...requirePendingOrder(),
        paidAt: new Date("2026-05-25T12:01:00.000Z"),
        providerMetadata: {
          ...getProviderMetadata(requirePendingOrder()),
          finalizationStatus: "paid",
        },
        providerPaymentId: paymentId,
        providerStatus: "paid",
        status: "paid",
      };
    },
    async markTrainingEnrollmentStaffAlerted(input) {
      expect(input.enrollmentId).toBe("training-enrollment-id");
      if (enrollment !== null) {
        enrollment = {
          ...enrollment,
          staffAlertedAt: new Date("2026-05-25T12:02:00.000Z"),
        };
      }
      return true;
    },
    async markTrainingEnrollmentStudentPaymentEmailSent(input) {
      expect(input.enrollmentId).toBe("training-enrollment-id");
      if (enrollment !== null) {
        enrollment = {
          ...enrollment,
          studentPaymentEmailSentAt: new Date("2026-05-25T12:02:00.000Z"),
        };
      }
      return true;
    },
    async claimTrainingPaymentEmails(input) {
      expect(input.enrollmentId).toBe("training-enrollment-id");
      return enrollment;
    },
    async recordTrainingPaymentEmailFailure(input) {
      expect(input.enrollmentId).toBe("training-enrollment-id");
      expect(input.error.length).toBeGreaterThan(0);
    },
    async sendTrainingAdminPaymentEmail(input) {
      expect(input.customerEmail).toBe(CUSTOMER_EMAIL);
      expect(input.customerName).toBe(CUSTOMER_NAME);
      expect(input.orderId).toBe(ORDER_ID);
      expect(input.paymentProvider).toBe("square");
      expect(input.programTitle).toBe("Beginner Private Training");
      expect(input.schedulingUrl).toContain(`/training-programs/${PROGRAM_SLUG}/schedule?token=${SCHEDULING_TOKEN}`);
    },
    async sendTrainingCustomerPaymentEmail(input) {
      expect(input.customerEmail).toBe(CUSTOMER_EMAIL);
      expect(input.customerName).toBe(CUSTOMER_NAME);
      expect(input.orderId).toBe(ORDER_ID);
      expect(input.paymentProvider).toBe("square");
      expect(input.programTitle).toBe("Beginner Private Training");
      expect(input.schedulingUrl).toContain(`/training-programs/${PROGRAM_SLUG}/schedule?token=${SCHEDULING_TOKEN}`);
    },
  });

  const checkoutHandler = createTrainingSquareInvoicePostHandler({
    createCheckoutToken: () => "checkout-token-123",
    createCorrelationId: () => CORRELATION_ID,
    createPendingSquareInvoiceOrder: async (input) => {
      expect(input.amountCents).toBe(TOTAL_CENTS);
      expect(input.correlationId).toBe(CORRELATION_ID);
      pendingOrder = createPendingSquareInvoiceOrder({
        amountCents: input.amountCents,
        customerEmail: input.customerEmail,
        customerName: input.customerName,
        programSlug: input.programSlug,
        squareCustomerId: input.squareCustomerId,
        squareInvoiceId: input.squareInvoiceId,
        squareInvoiceVersion: input.squareInvoiceVersion ?? null,
        squareOrderId: input.squareOrderId,
      });

      return { _id: "checkout-order-db-id", orderId: ORDER_ID };
    },
    createSecretToken: () => "secret-token-123",
    getPromotionCode: async () => null,
    getTrainingProgramBySlug: async (slug) => {
      expect(slug).toBe(PROGRAM_SLUG);
      return {
        _id: "training-program-beginner-private",
        blocks: [],
        checkoutEnabled: true,
        currency: "CAD",
        description: "Beginner private lash training program.",
        isAvailable: true,
        price: CLIENT_PRICE,
        slug: PROGRAM_SLUG,
        title: "Beginner Private Training",
      };
    },
    isEnabled: () => true,
    locationId: "mock-square-location",
    recordSquareInvoicePublication: async (orderId, invoiceId, publicUrl, version) => {
      expect(orderId).toBe(ORDER_ID);
      expect(invoiceId).toBe(INVOICE_ID);
      expect(publicUrl).toBe(SQUARE_INVOICE_URL);
      pendingOrder = {
        ...requirePendingOrder(),
        providerMetadata: {
          ...getProviderMetadata(requirePendingOrder()),
          squareInvoicePublicUrl: publicUrl,
          squareInvoiceVersion: version,
        },
        providerStatus: "published",
      };
    },
    squareInvoiceClient: {
      async createCustomer(email, _givenName, _familyName, idempotencyKey) {
        expect(email).toBe(CUSTOMER_EMAIL);
        expect(idempotencyKey).toBe(`${CORRELATION_ID}-customer`);
        return "mock-square-customer-001";
      },
      async createOrder(_locationId, lineItems, referenceId) {
        expect(referenceId).toBe(CORRELATION_ID);
        expect(lineItems).toHaveLength(1);
        expect(lineItems[0]?.base_price_money).toEqual({ amount: TOTAL_CENTS, currency: "CAD" });
        squareOrder = createSquareOrderDetails(referenceId);
        return SQUARE_ORDER_ID;
      },
      async createInvoice(orderId, customerId, paymentRequest) {
        expect(orderId).toBe(SQUARE_ORDER_ID);
        expect(customerId).toBe("mock-square-customer-001");
        expect(paymentRequest.idempotencyKey).toBe(`${CORRELATION_ID}-invoice`);
        squareInvoice = createSquareInvoiceDetails("DRAFT");
        return { id: INVOICE_ID, version: 1 };
      },
      async publishInvoice(invoiceId, version, idempotencyKey) {
        expect(invoiceId).toBe(INVOICE_ID);
        expect(version).toBe(1);
        expect(idempotencyKey).toBe(`${CORRELATION_ID}-publish`);
        squareInvoice = createSquareInvoiceDetails("PUBLISHED", 2);
        return { id: INVOICE_ID, publicUrl: SQUARE_INVOICE_URL, version: 2 };
      },
      async getInvoice(invoiceId) {
        expect(invoiceId).toBe(INVOICE_ID);
        return squareInvoice;
      },
      async getOrder(orderId) {
        expect(orderId).toBe(SQUARE_ORDER_ID);
        return squareOrder;
      },
    },
  });

  const webhookHandler = createSquareWebhookPostHandler({
    claimSquareInvoiceWebhookEvent: async (input) => {
      if (processedWebhookEvents.has(input.eventId)) {
        return { duplicate: true, processingStatus: "processed" };
      }
      return { duplicate: false };
    },
    finalizeSquarePayment: async () => {
      throw new Error("Service booking finalizer should not receive training invoice events");
    },
    finalizeTrainingSquareInvoicePayment: async (input) => {
      const result = await finalizer({
        correlationId: getWebhookCorrelationId(input.event.payloadSanitized),
        invoiceId: input.squareInvoiceId,
        origin: "http://localhost:3000",
        paymentId: input.event.paymentId,
      });

      return {
        duplicateEvent: result.duplicate,
        finalized: result.finalized,
        status: result.reason ?? (result.finalized ? "paid" : "duplicate"),
      };
    },
    findOrderBySquareInvoiceId: async (invoiceId) => pendingOrder?.providerCheckoutId === invoiceId ? pendingOrder : null,
    getEnv: () => ({ notificationUrl: WEBHOOK_URL, serviceBookingEnabled: false, webhookSignatureKey: WEBHOOK_SIGNATURE_KEY }),
    recordSquareInvoiceWebhookEventProcessed: async (input) => {
      processedWebhookEvents.add(input.eventId);
    },
  });

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

    await fulfillWithHandlerResponse(route, checkoutHandler);
  });

  await page.route(new RegExp(`${SQUARE_INVOICE_PATH}(?:$|\\?)`), async (route) => {
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
                      created_at: '2026-05-25T12:01:00.000Z',
                      event_id: 'evt_training_invoice_paid',
                      merchant_id: 'mock-square-merchant',
                      type: 'invoice.payment_made',
                      data: {
                        id: '${INVOICE_ID}',
                        type: 'invoice',
                        object: {
                          invoice: {
                            id: '${INVOICE_ID}',
                            order_id: '${SQUARE_ORDER_ID}',
                            reference_id: '${CORRELATION_ID}',
                            status: 'PAID'
                          },
                          payment: {
                            id: '${SQUARE_PAYMENT_ID}',
                            order_id: '${SQUARE_ORDER_ID}'
                          }
                        }
                      }
                    })
                  });
                  if (!response.ok) throw new Error('Mock finalizer failed');
                  window.location.href = '${CONFIRMATION_PATH}';
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
      event_id: "evt_training_invoice_paid",
      type: "invoice.payment_made",
      data: { object: { invoice: { id: INVOICE_ID, status: "PAID" } } },
    });
    webhookEvents.push("invoice.payment_made");
    squareInvoice = createSquareInvoiceDetails("PAID", 3, SQUARE_PAYMENT_ID);

    await fulfillWithSignedWebhookHandlerResponse(route, webhookHandler);
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
              <a href="/training-programs/${PROGRAM_SLUG}/schedule?token=${SCHEDULING_TOKEN}">Schedule Training Call</a>
            </main>
          </body>
        </html>`,
    });
  });

  function requirePendingOrder(): CheckoutOrderRow {
    expect(pendingOrder).not.toBeNull();
    return pendingOrder ?? failTest("Expected pending Square invoice order");
  }

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

async function fulfillWithHandlerResponse(
  route: Route,
  handler: (request: Request) => Promise<Response>,
): Promise<void> {
  const request = route.request();
  const response = await handler(new Request(request.url(), {
    body: request.postData(),
    headers: request.headers(),
    method: request.method(),
  }));

  await fulfillRouteWithResponse(route, response);
}

async function fulfillWithSignedWebhookHandlerResponse(
  route: Route,
  handler: (request: Request) => Promise<Response>,
): Promise<void> {
  const rawBody = route.request().postData() ?? "";
  const signature = createHmac("sha256", WEBHOOK_SIGNATURE_KEY)
    .update(`${WEBHOOK_URL}${rawBody}`, "utf8")
    .digest("base64");
  const response = await handler(new Request(WEBHOOK_URL, {
    body: rawBody,
    headers: {
      "content-type": "application/json",
      "x-square-hmacsha256-signature": signature,
    },
    method: "POST",
  }));

  await fulfillRouteWithResponse(route, response);
}

async function fulfillRouteWithResponse(route: Route, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  await route.fulfill({
    body: await response.text(),
    headers,
    status: response.status,
  });
}

function createPendingSquareInvoiceOrder(input: {
  amountCents: number;
  customerEmail: string;
  customerName: string;
  programSlug: string;
  squareCustomerId: string;
  squareInvoiceId: string;
  squareInvoiceVersion: number | null;
  squareOrderId: string;
}): CheckoutOrderRow {
  return {
    amountCents: input.amountCents,
    calendarEventId: null,
    calendarFinalizationStatus: "not_required",
    checkoutTokenHash: "checkout-token-hash",
    createdAt: new Date("2026-05-25T12:00:00.000Z"),
    currency: "CAD",
    customerEmail: input.customerEmail,
    customerName: input.customerName,
    deletedAt: null,
    failedAt: null,
    finalizedAt: null,
    helcimInvoiceId: null,
    helcimInvoiceNumber: null,
    helcimTransactionId: null,
    id: "checkout-order-db-id",
    lineItems: [{
      description: "Beginner Private Training",
      productId: input.programSlug,
      quantity: 1,
      sku: `TRAINING-${input.programSlug.toUpperCase()}`,
      totalCents: input.amountCents,
      unitPriceCents: input.amountCents,
    }],
    orderId: ORDER_ID,
    paidAt: null,
    paymentProvider: "square",
    productConfirmationEmailClaimedUntil: null,
    productConfirmationEmailLastError: null,
    productConfirmationEmailSentAt: null,
    providerCheckoutId: input.squareInvoiceId,
    providerMetadata: {
      amountCents: input.amountCents,
      correlationId: CORRELATION_ID,
      currency: "CAD",
      finalizationStatus: "pending",
      flow: "training_square_invoice",
      programSlug: input.programSlug,
      squareCustomerId: input.squareCustomerId,
      squareInvoicePublicUrl: null,
      squareInvoiceVersion: input.squareInvoiceVersion,
    },
    providerOrderId: input.squareOrderId,
    providerPaymentId: null,
    providerStatus: "draft",
    purpose: "training",
    redactedAt: null,
    secretTokenCiphertext: "v1:ciphertext",
    shippingAddress: null,
    squareLocationId: null,
    squarePaymentLinkId: null,
    squarePaymentLinkUrl: null,
    squareTipAmountCents: null,
    status: "pending",
    updatedAt: new Date("2026-05-25T12:00:00.000Z"),
  };
}

function createSquareInvoiceDetails(status: string, version = 2, paymentId?: string): SquareInvoiceDetails {
  return {
    id: INVOICE_ID,
    order_id: SQUARE_ORDER_ID,
    payment_requests: [{
      computed_amount_money: { amount: TOTAL_CENTS, currency: "CAD" },
      payment_ids: paymentId ? [paymentId] : [],
      request_type: "BALANCE",
    }],
    primary_recipient: {
      customer_id: "mock-square-customer-001",
    },
    public_url: SQUARE_INVOICE_URL,
    status,
    version,
  };
}

function createSquareOrderDetails(referenceId = CORRELATION_ID): SquareInvoiceOrderDetails {
  return {
    id: SQUARE_ORDER_ID,
    reference_id: referenceId,
  };
}

function createEnrollmentRecord(order: CheckoutOrderRow): NonNullable<EnrollmentRecord> {
  return {
    checkoutEmail: CUSTOMER_EMAIL,
    checkoutOrder: order,
    enrollmentId: "training-enrollment-id",
    productSnapshot: {
      currency: "CAD",
      id: PROGRAM_SLUG,
      priceCents: TOTAL_CENTS,
      sku: `TRAINING-${PROGRAM_SLUG.toUpperCase()}`,
      title: "Beginner Private Training",
    },
    programSnapshot: {
      id: PROGRAM_SLUG,
      slug: PROGRAM_SLUG,
      title: "Beginner Private Training",
    },
    staffAlertedAt: null,
    studentPaymentEmailSentAt: null,
    tokenExpiresAt: null,
  };
}

function getProviderMetadata(order: CheckoutOrderRow): NonNullable<CheckoutOrderRow["providerMetadata"]> {
  expect(order.providerMetadata).not.toBeNull();
  return order.providerMetadata ?? failTest("Expected Square invoice provider metadata");
}

function getWebhookCorrelationId(payload: Record<string, unknown>): string | undefined {
  const data = getRecord(payload.data);
  const object = getRecord(data?.object);
  const invoice = getRecord(object?.invoice);

  return getText(invoice?.reference_id) ?? getText(invoice?.order_reference_id) ?? undefined;
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function failTest(message: string): never {
  throw new Error(message);
}

function getText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
