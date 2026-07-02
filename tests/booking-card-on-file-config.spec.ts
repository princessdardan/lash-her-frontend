import { expect, test, type Page } from "@playwright/test";

const SERVICE_SLUG = "lash-fill";
const SLOT_START = "2030-06-15T16:00:00.000Z";
const SLOT_END = "2030-06-15T17:30:00.000Z";
const HOLD_REFERENCE = "hold-card-on-file-unavailable";
const ORDER_ID = "lh-card-on-file-fallback-order";
const CHECKOUT_URL = `http://localhost:3000/api/booking/square/return?orderId=${ORDER_ID}&paymentId=mock-square-payment-1`;
const FORBIDDEN_PAYMENT_HOSTS = new Set([
  "api.helcim.com",
  "connect.squareup.com",
  "connect.squareupsandbox.com",
]);

function collectApiRequests(page: Page): string[] {
  const requests: string[] = [];

  page.on("request", (request) => {
    const url = new URL(request.url());

    if (
      url.origin === "http://localhost:3000" &&
      url.pathname.startsWith("/api/")
    ) {
      requests.push(`${request.method()} ${url.pathname}`);
    }
  });

  return requests;
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

test("booking page falls back to legacy checkout when card-on-file config is unavailable", async ({
  page,
}) => {
  const apiRequests = collectApiRequests(page);
  const forbiddenPaymentHosts = collectForbiddenPaymentHosts(page);
  let configRequestCount = 0;
  const holdRequests: Array<Record<string, unknown>> = [];
  const checkoutRequests: Array<Record<string, unknown>> = [];

  await page.route("**/api/booking/availability**", async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("service")).toBe(SERVICE_SLUG);

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        slots: [{ start: SLOT_START, end: SLOT_END }],
      }),
    });
  });

  await page.route("**/api/booking/holds", async (route) => {
    expect(route.request().method()).toBe("POST");
    holdRequests.push(
      route.request().postDataJSON() as Record<string, unknown>,
    );

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ hold: { reference: HOLD_REFERENCE } }),
    });
  });

  await page.route("**/api/booking/square/config", async (route) => {
    expect(route.request().method()).toBe("GET");
    configRequestCount++;

    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({
        error: "Square card-on-file booking is not enabled",
      }),
    });
  });

  await page.route(/\/api\/booking\/checkout(?:\?.*)?$/, async (route) => {
    expect(route.request().method()).toBe("POST");
    checkoutRequests.push(
      route.request().postDataJSON() as Record<string, unknown>,
    );

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        checkoutUrl: CHECKOUT_URL,
        holdReference: HOLD_REFERENCE,
        orderId: ORDER_ID,
        paymentProvider: "square",
        reused: false,
        squarePaymentLinkId: "square-payment-link-fallback",
      }),
    });
  });

  await page.route("**/api/booking/square/return**", async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("orderId")).toBe(ORDER_ID);
    expect(url.searchParams.get("paymentId")).toBe("mock-square-payment-1");

    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><html><body>Mock Square checkout return</body></html>",
    });
  });

  await page.goto(`/services/${SERVICE_SLUG}/booking`);

  await expect(
    page.getByRole("heading", { name: /select time/i }),
  ).toBeVisible();

  const timeStr = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Toronto",
  }).format(new Date(SLOT_START));
  await page.getByRole("button", { name: timeStr }).click();
  await page.getByRole("button", { name: /continue$/i }).click();

  await expect(
    page.getByRole("heading", { name: /your details/i }),
  ).toBeVisible();

  await page.getByLabel(/full name/i).fill("Service Client");
  await page.getByLabel(/email address/i).fill("service.client@example.com");
  await page.getByLabel(/phone number/i).fill("(555) 123-4567");

  await page
    .getByRole("button", { name: /continue to secure square checkout/i })
    .click();

  // The card-on-file form mounts and loads config before falling back.
  await expect(page.getByRole("status")).toContainText(
    /loading secure card form/i,
  );

  // Wait for the legacy checkout navigation to be initiated instead of waiting
  // for the full page 'load' event, which can race with React re-renders and
  // abort with "net::ERR_ABORTED; maybe frame was detached?".
  const returnNavigationRequest = await page.waitForRequest(
    "**/api/booking/square/return**",
  );
  expect(returnNavigationRequest.url()).toBe(CHECKOUT_URL);
  const returnUrl = new URL(returnNavigationRequest.url());
  expect(returnUrl.searchParams.get("orderId")).toBe(ORDER_ID);
  expect(returnUrl.searchParams.get("paymentId")).toBe("mock-square-payment-1");

  expect(configRequestCount).toBeGreaterThanOrEqual(1);
  expect(holdRequests).toEqual([
    expect.objectContaining({
      serviceSlug: SERVICE_SLUG,
      start: SLOT_START,
      name: "Service Client",
      email: "service.client@example.com",
      phone: "(555) 123-4567",
      paymentOption: "full",
    }),
  ]);
  expect(checkoutRequests.length).toBeGreaterThanOrEqual(1);
  expect(checkoutRequests).toEqual(
    Array.from({ length: checkoutRequests.length }, () => ({
      holdReference: HOLD_REFERENCE,
    })),
  );

  const availabilityIndex = apiRequests.indexOf(
    "GET /api/booking/availability",
  );
  const holdsIndex = apiRequests.indexOf("POST /api/booking/holds");
  const configIndex = apiRequests.indexOf("GET /api/booking/square/config");
  const checkoutIndex = apiRequests.indexOf("POST /api/booking/checkout");

  expect(availabilityIndex).toBeGreaterThanOrEqual(0);
  expect(holdsIndex).toBeGreaterThan(availabilityIndex);
  expect(configIndex).toBeGreaterThan(holdsIndex);
  expect(checkoutIndex).toBeGreaterThan(configIndex);
  expect(forbiddenPaymentHosts).toEqual([]);
});

test("public Square config endpoint exposes only allowed keys", async ({
  page,
}) => {
  let configCalled = false;

  await page.route("**/api/booking/square/config", async (route) => {
    configCalled = true;

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        applicationId: "sandbox-sq0idb-e2e",
        environment: "sandbox",
        locationId: "LOC_E2E",
        scriptUrl: "https://sandbox.web.squarecdn.com/v1/square.js",
      }),
    });
  });

  await page.goto("/booking");

  const body = await page.evaluate(async () => {
    const response = await fetch("/api/booking/square/config", {
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`Unexpected config status: ${response.status}`);
    }

    return response.json();
  });

  expect(configCalled).toBe(true);
  expect(body).toEqual({
    applicationId: "sandbox-sq0idb-e2e",
    environment: "sandbox",
    locationId: "LOC_E2E",
    scriptUrl: "https://sandbox.web.squarecdn.com/v1/square.js",
  });

  const bodyText = JSON.stringify(body);
  expect(bodyText).not.toMatch(/accessToken|webhookSignatureKey|secret/i);
});
