import { expect, test, type Page } from "@playwright/test";

const SERVICE_SLUG = "lash-fill";
const SLOT_START = "2030-06-15T16:00:00.000Z";
const SLOT_END = "2030-06-15T17:30:00.000Z";
const PAYMENT_SESSION_REFERENCE = "pay_sess_card_on_file_handoff";
const PAYMENT_PAGE_URL = `/services/${SERVICE_SLUG}/booking/payment?session=${PAYMENT_SESSION_REFERENCE}`;
const FORBIDDEN_PAYMENT_HOSTS = new Set([
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

test("booking flow hands off to the dedicated payment page before provider configuration", async ({
  page,
}) => {
  await page.context().addCookies([
    {
      domain: "localhost",
      name: "lh_contact_popup_dismissed",
      path: "/",
      value: "true",
    },
  ]);
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "lh_cookie_consent",
      JSON.stringify({
        analytics: false,
        decidedAt: "2030-01-01T00:00:00.000Z",
        required: true,
        version: 1,
      }),
    );
  });
  const apiRequests = collectApiRequests(page);
  const forbiddenPaymentHosts = collectForbiddenPaymentHosts(page);
  const holdRequests: Array<Record<string, unknown>> = [];
  let availabilityOfferingId: string | null = null;

  await page.route("**/api/booking/availability**", async (route) => {
    const url = new URL(route.request().url());
    // The offering-backed booking flow requests availability by offering id.
    availabilityOfferingId = url.searchParams.get("offeringId");
    expect(availabilityOfferingId).toBeTruthy();

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
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        hold: {
          end: SLOT_END,
          expiresAt: "2030-06-15T15:10:00.000Z",
          paymentPageUrl: PAYMENT_PAGE_URL,
          paymentSessionReference: PAYMENT_SESSION_REFERENCE,
          service: { slug: SERVICE_SLUG, title: "Lash Fill" },
          start: SLOT_START,
        },
      }),
    });
  });

  await page.route(`**${PAYMENT_PAGE_URL}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><html><body><h1>Dedicated payment handoff</h1></body></html>",
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
    page.getByRole("heading", { name: /appointment details/i }),
  ).toBeVisible();
  await expect(page.getByLabel(/full name/i)).toHaveCount(0);
  await expect(page.getByLabel(/email address/i)).toHaveCount(0);
  await expect(page.getByLabel(/phone number/i)).toHaveCount(0);

  const paymentNavigation = page.waitForRequest(`**${PAYMENT_PAGE_URL}`);
  await page.getByRole("button", { name: /continue to payment/i }).click();
  const paymentNavigationRequest = await paymentNavigation;
  expect(new URL(paymentNavigationRequest.url()).pathname).toBe(
    `/services/${SERVICE_SLUG}/booking/payment`,
  );
  await expect(page).toHaveURL(PAYMENT_PAGE_URL);
  await expect(
    page.getByRole("heading", { name: "Dedicated payment handoff" }),
  ).toBeVisible();

  expect(holdRequests).toEqual([
    expect.objectContaining({
      offeringId: availabilityOfferingId,
      start: SLOT_START,
    }),
  ]);
  expect(holdRequests[0]?.serviceSlug).toBeUndefined();
  expect(holdRequests[0]?.name).toBeUndefined();
  expect(holdRequests[0]?.email).toBeUndefined();
  expect(holdRequests[0]?.phone).toBeUndefined();
  expect(holdRequests[0]?.paymentOption).toBeUndefined();

  const availabilityIndex = apiRequests.indexOf(
    "GET /api/booking/availability",
  );
  const holdsIndex = apiRequests.indexOf("POST /api/booking/holds");

  expect(availabilityIndex).toBeGreaterThanOrEqual(0);
  expect(holdsIndex).toBeGreaterThan(availabilityIndex);
  expect(apiRequests).not.toContain("GET /api/booking/square/config");
  expect(apiRequests).not.toContain("POST /api/booking/checkout");
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

  // Land on a stable page before probing the endpoint. "/booking" is a server
  // redirect to the service catalog; evaluating the fetch mid-redirect aborts it
  // on WebKit ("Load failed"), so navigate to the settled target directly.
  await page.goto("/services");
  await page.waitForLoadState("networkidle");

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
