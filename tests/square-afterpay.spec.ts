import { createRequire } from "node:module";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { NextRequest } from "next/server";
import { createTrainingCheckoutPostHandler } from "@/app/api/training-checkout/handler";
import { chargeSquareTrainingOrder } from "@/lib/commerce/square-training-checkout";

// Reuse tsx's installed transformer to run production React components in a
// browser without introducing a test-only public Next.js route.
const requireFromTsx = createRequire(require.resolve("tsx"));
const { build } = requireFromTsx("esbuild") as typeof import("esbuild");
let bundle: string;

test.beforeAll(async () => {
  const result = await build({
    entryPoints: [path.resolve("tests/fixtures/square-afterpay-harness.tsx")],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [
      {
        name: "test-router",
        setup(builder) {
          builder.onResolve({ filter: /^next\/navigation$/ }, () => ({
            path: "router",
            namespace: "fixture",
          }));
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents:
              "export const useRouter = () => ({ push: (url) => { document.body.dataset.destination = url; } });",
            loader: "js",
          }));
        },
      },
    ],
  });
  bundle = result.outputFiles[0].text;
});

const sdk = `
window.fixture = { requests: [], intents: [], tokenizations: 0, methodAmounts: [] };
window.Square = { payments() { return {
  setLocale() {},
  card: async () => ({
    attach: async (selector) => { document.querySelector(selector).textContent = 'Secure Square card fields'; },
    destroy() {},
    tokenize: async (details) => {
      window.fixture.intents.push(details);
      if (window.fixture.cardDecline) return { status: 'ERROR' };
      return { status: 'OK', token: 'cnon:policy-card', verificationToken: 'verify-card' };
    }
  }),
  paymentRequest: (options) => options,
  afterpayClearpay: async (request) => {
    window.fixture.methodAmounts.push(request.total.amount);
    if (new URLSearchParams(location.search).get('unavailable')) throw new Error('Merchant ineligible');
    let button;
    return {
      attach: async (selector) => {
        button = document.createElement('button'); button.type = 'button'; button.textContent = 'Pay with Afterpay';
        document.querySelector(selector).appendChild(button);
      },
      destroy: async () => { button?.remove(); return true; },
      tokenize: async () => {
        window.fixture.tokenizations++;
        await new Promise(resolve => setTimeout(resolve, window.fixture.delay ?? 30));
        if (window.fixture.cancel) return { status: 'Cancel' };
        if (window.fixture.decline) return { status: 'ERROR', errors: [{ message: 'Afterpay declined' }] };
        return { status: 'OK', token: window.fixture.uniqueTokens ? 'afterpay-token-' + window.fixture.tokenizations : 'afterpay-token' };
      }
    };
  }
}; } };
`;

async function openCheckout(page: Page, query = "kind=product") {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/bundle.js")
      return route.fulfill({ contentType: "text/javascript", body: bundle });
    if (url.pathname === "/square.js")
      return route.fulfill({ contentType: "text/javascript", body: sdk });
    if (url.pathname.endsWith("/square/config")) {
      if (query.includes("cardUnavailable=1"))
        return route.fulfill({ status: 404, json: {} });
      return route.fulfill({
        json: {
          applicationId: "test-app",
          locationId: "test-location",
          locale: "en-CA",
          environment: "sandbox",
          scriptUrl: "/square.js",
        },
      });
    }
    if (url.pathname === "/invoice-test") {
      return route.fulfill({
        contentType: "text/html",
        body: "<h1>Square invoice payment</h1>",
      });
    }
    if (url.pathname.startsWith("/api/")) {
      const body = route.request().postDataJSON();
      await page.evaluate((request) => {
        (
          window as unknown as { fixture: { requests: unknown[] } }
        ).fixture.requests.push(request);
      }, body);
      return route.fulfill({
        json: url.pathname.endsWith("/square-invoice")
          ? { orderId: "order-1", publicUrl: "http://localhost/invoice-test" }
          : url.pathname.includes("/booking/")
            ? {
                bookingStatus: "booked",
                paymentStatus: "captured",
                holdReference: "hold-1",
                card: { last4: "1111" },
              }
            : { orderId: "order-1", status: "paid" },
      });
    }
    return route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><body><div id="root"></div><script src="/bundle.js"></script></body></html>',
    });
  });
  await page.goto(`http://localhost/__afterpay-fixture?${query}`);
  if (query.includes("cardUnavailable=1")) {
    await expect(
      page.getByText(/Card checkout is temporarily unavailable/),
    ).toBeVisible();
  } else {
    await expect(page.getByText("Secure Square card fields")).toBeVisible();
  }
  return errors;
}

async function fixture(page: Page) {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          fixture: {
            requests: Array<Record<string, unknown>>;
            intents: Array<Record<string, unknown>>;
            tokenizations: number;
            methodAmounts: string[];
          };
        }
      ).fixture,
  );
}

test("products offer Afterpay and submit a single payment with the final total", async ({
  page,
}) => {
  const errors = await openCheckout(page);
  const button = page.getByRole("button", {
    name: "Pay with Afterpay",
    exact: true,
  });
  await expect(button).toBeEnabled();
  await button.evaluate((element) => {
    (element as HTMLButtonElement).click();
    (element as HTMLButtonElement).click();
  });
  await expect(page.locator("body")).toHaveAttribute(
    "data-destination",
    /products\/confirmation/,
  );
  const state = await fixture(page);
  expect(state.tokenizations).toBe(1);
  expect(state.requests).toHaveLength(1);
  expect(state.requests[0].payment).toEqual({
    sourceId: "afterpay-token",
    method: "afterpay",
    expectedAmountCents: 17515,
  });
  expect(state.intents).toHaveLength(0);
  await expect(button).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Processing...", exact: true }),
  ).toBeDisabled();
  expect(errors).toEqual([]);
});

test("training requires customer details and terms for Afterpay", async ({
  page,
}) => {
  await openCheckout(page, "kind=training");
  const button = page.getByRole("button", {
    name: "Pay with Afterpay",
    exact: true,
  });
  await expect(button).toBeDisabled();
  await page.getByLabel("Full Name", { exact: true }).fill("Test Buyer");
  await page
    .getByLabel("Email Address", { exact: true })
    .fill("buyer@example.test");
  await page.getByLabel("I acknowledge the terms").check();
  await button.click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-destination",
    /training-programs\/classic-lashes\/confirmation/,
  );
  expect((await fixture(page)).requests[0].payment).toEqual({
    sourceId: "afterpay-token",
    method: "afterpay",
    expectedAmountCents: 17515,
  });
});

async function fillTrainingDetails(page: Page) {
  await page.getByLabel("Full Name", { exact: true }).fill("Test Buyer");
  await page
    .getByLabel("Email Address", { exact: true })
    .fill("buyer@example.test");
  await page.getByLabel("I acknowledge the terms").check();
}

test("training split charges only the chosen Afterpay portion and the remaining card balance", async ({
  page,
}) => {
  const errors = await openCheckout(page, "kind=training&amount=395500");
  await expect(
    page.getByRole("button", { name: "Pay with Afterpay", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText(/C\$4,000/)).toHaveCount(0);
  await page.getByLabel("Use Afterpay + card").check();
  await expect(page.getByLabel("Afterpay amount (CAD)")).toHaveValue("2000.00");
  await expect(page.getByText("C$1,955.00", { exact: true })).toBeVisible();
  await fillTrainingDetails(page);
  const button = page.getByRole("button", {
    name: "Pay with Afterpay",
    exact: true,
  });
  await button.evaluate((element) => {
    (element as HTMLButtonElement).click();
    (element as HTMLButtonElement).click();
  });
  await expect(page.locator("body")).toHaveAttribute(
    "data-destination",
    /confirmation/,
  );
  const state = await fixture(page);
  expect(state.requests).toHaveLength(1);
  expect(state.requests[0]).toMatchObject({
    payment: {
      method: "afterpay_card",
      expectedAmountCents: 395500,
      afterpayAmountCents: 200000,
      afterpay: {
        method: "afterpay",
        sourceId: "afterpay-token",
        expectedAmountCents: 200000,
      },
      card: { sourceId: "cnon:policy-card" },
    },
  });
  expect(state.intents).toEqual([
    expect.objectContaining({ amount: "1955.00", intent: "CHARGE" }),
  ]);
  expect(state.methodAmounts).toContain("2000.00");
  expect(errors).toEqual([]);
});

test("training split respects lower portions and rejects invalid amounts before tokenization", async ({
  page,
}) => {
  await openCheckout(page, "kind=training&amount=282500");
  await fillTrainingDetails(page);
  await page.getByLabel("Use Afterpay + card").check();
  const input = page.getByLabel("Afterpay amount (CAD)");
  await input.fill("2000.01");
  await expect(
    page.getByRole("button", { name: "Pay with Afterpay", exact: true }),
  ).toHaveCount(0);
  await input.fill("1500");
  await expect(page.getByText("C$1,325.00", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Pay with Afterpay", exact: true })
    .click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-destination",
    /confirmation/,
  );
  expect((await fixture(page)).requests[0]).toMatchObject({
    payment: { afterpayAmountCents: 150000 },
  });
});

test("cancelled Afterpay or failed card tokenization submits no split charge", async ({
  page,
}) => {
  await openCheckout(page, "kind=training&amount=282500");
  await fillTrainingDetails(page);
  await page.getByLabel("Use Afterpay + card").check();
  await page.evaluate(() => {
    (window as unknown as { fixture: { cancel: boolean } }).fixture.cancel =
      true;
  });
  const button = page.getByRole("button", {
    name: "Pay with Afterpay",
    exact: true,
  });
  await button.click();
  await expect(button).toBeEnabled();
  expect((await fixture(page)).requests).toHaveLength(0);
  await page.evaluate(() => {
    Object.assign((window as unknown as { fixture: object }).fixture, {
      cancel: false,
      cardDecline: true,
    });
  });
  await button.click();
  await expect(page.getByRole("alert")).toContainText(
    "card could not be verified",
  );
  expect((await fixture(page)).requests).toHaveLength(0);
});

test("split request with a lost response survives reload and checks the same attempt without tokenizing again", async ({
  page,
}) => {
  await openCheckout(page, "kind=training&amount=282500");
  await fillTrainingDetails(page);
  await page.getByLabel("Use Afterpay + card").check();
  let key = "";
  await page.route("**/api/training-checkout", (route) => {
    key = route.request().postDataJSON().reservationKey;
    return route.abort("connectionreset");
  });
  await page
    .getByRole("button", { name: "Pay with Afterpay", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Check payment status" }),
  ).toBeEnabled();
  await page.reload();
  const status = page.getByRole("button", { name: "Check payment status" });
  await expect(status).toBeEnabled();
  await page.route("**/api/training-checkout/split-status", (route) => {
    expect(route.request().postDataJSON()).toEqual({
      reservationKey: key,
      customerEmail: "buyer@example.test",
    });
    return route.fulfill({ json: { status: "paid", orderId: "split-paid" } });
  });
  await status.click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-destination",
    /order=split-paid/,
  );
});

test("cancelled split attempts allow a new method only after the server confirms cancellation", async ({
  page,
}) => {
  await openCheckout(page, "kind=training&amount=282500");
  await fillTrainingDetails(page);
  await page.getByLabel("Use Afterpay + card").check();
  await page.route("**/api/training-checkout", (route) =>
    route.fulfill({
      status: 503,
      json: { error: "Still confirming", retryWithNewReservation: false },
    }),
  );
  await page
    .getByRole("button", { name: "Pay with Afterpay", exact: true })
    .click();
  await expect(page.getByLabel("Use Afterpay + card")).toHaveCount(0);
  await page.route("**/api/training-checkout/split-status", (route) =>
    route.fulfill({
      status: 402,
      json: {
        error: "Neither payment completed",
        retryWithNewReservation: true,
      },
    }),
  );
  await page.getByRole("button", { name: "Check payment status" }).click();
  await expect(page.getByLabel("Use Afterpay + card")).toBeVisible();
  await page.getByLabel("Use Afterpay + card").uncheck();
  await expect(
    page.getByRole("button", { name: "Pay securely", exact: true }),
  ).toBeEnabled();
});

test("training recovers a lost paid response with one order and one capture", async ({
  page,
}) => {
  await openCheckout(page, "kind=training");
  await page.evaluate(() => {
    (
      window as unknown as { fixture: { uniqueTokens: boolean } }
    ).fixture.uniqueTokens = true;
  });
  const orders = new Map<string, { squarePaymentId: string } | null>();
  const authorized = new Map<string, string>();
  const requests: Array<{
    reservationKey: string;
    payment: { sourceId: string };
  }> = [];
  let captures = 0;
  const handler = createTrainingCheckoutPostHandler({
    getTrainingProgramBySlug: async () => ({
      _id: "program-1",
      slug: "classic-lashes",
      title: "Classic lashes",
      description: "",
      blocks: [],
      checkoutEnabled: true,
      price: 155,
      currency: "CAD",
      isAvailable: true,
    }),
    getPromotionCode: async () => null,
    createTrainingEnrollment: async () => ({ _id: "enrollment" }),
    squareCommerceEnabled: true,
    reserveSquareTrainingOrder: async ({ reservationKey }) => {
      expect(reservationKey).toBeTruthy();
      const orderId = reservationKey!;
      if (!orders.has(orderId)) orders.set(orderId, null);
      return { orderId, databaseId: orderId };
    },
    chargeSquareTrainingOrder: (input) =>
      chargeSquareTrainingOrder(input, {
        findRecordedPayment: async (orderId) => orders.get(orderId) ?? null,
        authorizePayment: async (request) => {
          const previousSource = authorized.get(request.idempotency_key);
          if (previousSource && previousSource !== request.source_id) {
            throw new Error("IDEMPOTENCY_KEY_REUSED");
          }
          authorized.set(request.idempotency_key, request.source_id);
          return {
            payment: {
              id: `payment-${request.idempotency_key}`,
              status: "APPROVED",
              source_type: "BUY_NOW_PAY_LATER",
              amount_money: request.amount_money,
            },
          };
        },
        finalize: async ({ orderReference, squarePaymentId }) => {
          orders.set(orderReference, { squarePaymentId });
          return { transition: "applied" };
        },
        capturePayment: async () => {
          captures++;
        },
        voidPayment: async () => {
          throw new Error("Cannot void a captured payment");
        },
        voidPaymentByIdempotencyKey: async () => {
          throw new Error("Cannot void a captured payment");
        },
        sendNotifications: async () => {},
        logError: () => {},
      }),
  });
  await page.route("**/api/training-checkout", async (route) => {
    requests.push(route.request().postDataJSON());
    const response = await handler(
      new NextRequest(route.request().url(), {
        method: "POST",
        body: route.request().postData(),
      }),
    );
    expect(response.status).toBe(200);
    if (requests.length === 1) return route.abort("connectionreset");
    return route.fulfill({
      status: response.status,
      json: await response.json(),
    });
  });
  await page.getByLabel("Full Name", { exact: true }).fill("Test Buyer");
  await page
    .getByLabel("Email Address", { exact: true })
    .fill("buyer@example.test");
  await page.getByLabel("I acknowledge the terms").check();
  const button = page.getByRole("button", {
    name: "Pay with Afterpay",
    exact: true,
  });
  await button.click();
  await expect(page.getByRole("alert")).toBeVisible();
  await button.click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-destination",
    /training-programs\/classic-lashes\/confirmation/,
  );
  expect(requests).toHaveLength(2);
  expect(requests[0].reservationKey).toBe(requests[1].reservationKey);
  expect(requests[0].payment.sourceId).not.toBe(requests[1].payment.sourceId);
  expect(orders.size).toBe(1);
  expect(authorized.size).toBe(1);
  expect(captures).toBe(1);
});

for (const retryWithNewReservation of [false, true]) {
  test(`training ${retryWithNewReservation ? "rotates" : "preserves"} its reservation after ${retryWithNewReservation ? "confirmed cancellation" : "an uncertain payment"}`, async ({
    page,
  }) => {
    await openCheckout(page, "kind=training");
    const keys: string[] = [];
    await page.route("**/api/training-checkout", (route) => {
      keys.push(route.request().postDataJSON().reservationKey);
      return route.fulfill(
        keys.length === 1
          ? {
              status: retryWithNewReservation ? 402 : 503,
              json: { error: "Payment failed", retryWithNewReservation },
            }
          : { json: { orderId: "order-1", status: "paid" } },
      );
    });
    await page.getByLabel("Full Name", { exact: true }).fill("Test Buyer");
    await page
      .getByLabel("Email Address", { exact: true })
      .fill("buyer@example.test");
    await page.getByLabel("I acknowledge the terms").check();
    const button = page.getByRole("button", {
      name: "Pay with Afterpay",
      exact: true,
    });
    await button.click();
    await expect(page.getByRole("alert")).toBeVisible();
    await button.click();
    await expect(page.locator("body")).toHaveAttribute(
      "data-destination",
      /confirmation/,
    );
    expect(keys).toHaveLength(2);
    expect(keys[0] === keys[1]).toBe(!retryWithNewReservation);
  });
}

test("service Afterpay saves a separate card using STORE and confirms only after submission", async ({
  page,
}) => {
  const errors = await openCheckout(page, "kind=booking");
  await page.getByLabel("Full Name", { exact: true }).fill("Test Buyer");
  await page
    .getByLabel("Email Address", { exact: true })
    .fill("buyer@example.test");
  await page.getByLabel("Phone Number", { exact: true }).fill("4165550100");
  await page
    .getByLabel("I have read and agree to the no-show policy above.")
    .check();
  await page
    .getByRole("button", { name: "Pay with Afterpay", exact: true })
    .click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-destination",
    "booking-confirmed",
  );
  const state = await fixture(page);
  expect(state.intents[0].intent).toBe("STORE");
  expect(state.intents[0]).not.toHaveProperty("amount");
  expect(state.intents[0]).not.toHaveProperty("currencyCode");
  expect(state.requests[0]).toMatchObject({
    paymentMethod: "afterpay",
    sourceId: "afterpay-token",
    cardSourceId: "cnon:policy-card",
    cardVerificationToken: "verify-card",
    payment: { option: "full", expectedAmountCents: 15500 },
  });
  expect(errors).toEqual([]);
});

test("Canadian limits include exactly C$2,000 and update when the total changes", async ({
  page,
}) => {
  await openCheckout(page, "kind=product&amount=200001");
  await expect(
    page.getByRole("button", { name: "Pay with Afterpay", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("Test total").fill("200000");
  await expect(
    page.getByRole("button", { name: "Pay with Afterpay", exact: true }),
  ).toBeEnabled();
  expect((await fixture(page)).methodAmounts.at(-1)).toBe("2000.00");
  await page.getByLabel("Test total").fill("99");
  await expect(
    page.getByRole("button", { name: "Pay with Afterpay", exact: true }),
  ).toHaveCount(0);
});

test("merchant ineligibility leaves card checkout usable", async ({ page }) => {
  await openCheckout(page, "kind=product&unavailable=1");
  await expect(
    page.getByText(
      "Afterpay is unavailable for this checkout. You can pay by card.",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Pay securely", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-destination",
    /products\/confirmation/,
  );
  expect((await fixture(page)).intents[0].intent).toBe("CHARGE");
});

for (const scenario of ["decline", "cancel"] as const) {
  test(`Afterpay ${scenario} creates no order and allows retry`, async ({
    page,
  }) => {
    await openCheckout(page);
    await page.evaluate((key) => {
      (window as unknown as { fixture: Record<string, unknown> }).fixture[key] =
        true;
    }, scenario);
    await page
      .getByRole("button", { name: "Pay with Afterpay", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Pay securely", exact: true }),
    ).toBeEnabled();
    expect((await fixture(page)).requests).toHaveLength(0);
    await page.evaluate((key) => {
      (window as unknown as { fixture: Record<string, unknown> }).fixture[key] =
        false;
    }, scenario);
    await page
      .getByRole("button", { name: "Pay with Afterpay", exact: true })
      .click();
    await expect(page.locator("body")).toHaveAttribute(
      "data-destination",
      /products\/confirmation/,
    );
  });
}

test("a total changed while Afterpay is open never submits the stale payment", async ({
  page,
}) => {
  await openCheckout(page);
  await page.evaluate(() => {
    (window as unknown as { fixture: Record<string, unknown> }).fixture.delay =
      500;
  });
  await page
    .getByRole("button", { name: "Pay with Afterpay", exact: true })
    .click();
  await page.getByLabel("Test total").fill("18000");
  await expect(page.getByRole("alert")).toContainText("Your total changed");
  expect((await fixture(page)).requests).toHaveLength(0);
  await expect(
    page.getByRole("button", { name: "Pay securely", exact: true }),
  ).toBeEnabled();
});

test("service card verification failure never submits an Afterpay charge", async ({
  page,
}) => {
  await openCheckout(page, "kind=booking");
  await page.getByLabel("Full Name", { exact: true }).fill("Test Buyer");
  await page
    .getByLabel("Email Address", { exact: true })
    .fill("buyer@example.test");
  await page.getByLabel("Phone Number", { exact: true }).fill("4165550100");
  await page
    .getByLabel("I have read and agree to the no-show policy above.")
    .check();
  await page.evaluate(() => {
    (
      window as unknown as { fixture: Record<string, unknown> }
    ).fixture.cardDecline = true;
  });
  await page
    .getByRole("button", { name: "Pay with Afterpay", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "policy card could not be verified",
  );
  expect((await fixture(page)).requests).toHaveLength(0);
  await expect(
    page.getByRole("button", { name: "Pay and confirm booking", exact: true }),
  ).toBeEnabled();
});
