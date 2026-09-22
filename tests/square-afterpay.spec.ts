import { createRequire } from "node:module";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";

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
        return { status: 'OK', token: 'afterpay-token' };
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
    if (url.pathname.endsWith("/square/config"))
      return route.fulfill({
        json: {
          applicationId: "test-app",
          locationId: "test-location",
          locale: "en-CA",
          environment: "sandbox",
          scriptUrl: "/square.js",
        },
      });
    if (url.pathname.startsWith("/api/")) {
      const body = route.request().postDataJSON();
      await page.evaluate((request) => {
        (
          window as unknown as { fixture: { requests: unknown[] } }
        ).fixture.requests.push(request);
      }, body);
      return route.fulfill({
        json: url.pathname.includes("/booking/")
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
  await expect(page.getByText("Secure Square card fields")).toBeVisible();
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
