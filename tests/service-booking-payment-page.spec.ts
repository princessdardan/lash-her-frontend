import { test, expect, type TestInfo } from "@playwright/test";
import { config } from "dotenv";
import { Pool } from "pg";

import { createPrivateDbPoolConfig } from "../src/lib/private-db/pool-config";

config({ path: [".env.local", ".env"] });

declare global {
  interface Window {
    __squareAttachedSelector?: string;
    __squareVerificationDetails?: unknown;
  }
}

const SERVICE_SLUG = "lash-fill";
const OFFERING_ID = "service-lash-fill";
const SLOT_START = "2030-07-01T23:00:00.000Z";
const SLOT_END = "2030-07-02T00:30:00.000Z";

function createTestReferences(testInfo: TestInfo) {
  const suffix = `${testInfo.project.name}-${testInfo.workerIndex}-${testInfo.retry}-${Math.random().toString(36).slice(2, 10)}`;
  const paymentSessionReference = `pay_sess_${suffix}`;
  const publicReference = `lh-test-pay-sess-${suffix}`;
  const paymentPageUrl = `/services/${SERVICE_SLUG}/booking/payment?session=${paymentSessionReference}`;

  return { paymentSessionReference, publicReference, paymentPageUrl };
}

test("service booking redirects to dedicated payment page and mounts Square container", async ({
  page,
}, testInfo) => {
  const { paymentSessionReference, publicReference, paymentPageUrl } =
    createTestReferences(testInfo);

  if (process.env.SERVICE_BOOKING_PAYMENT_E2E_DB_WRITES !== "true") {
    test.skip(
      true,
      "Set SERVICE_BOOKING_PAYMENT_E2E_DB_WRITES=true to opt into private DB writes",
    );
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl || databaseUrl.length === 0) {
    test.skip(true, "DATABASE_URL is not configured");
    return;
  }

  const pool = new Pool(createPrivateDbPoolConfig(databaseUrl));
  let preconditionsOk = false;

  try {
    await pool.query("SELECT 1");
  } catch {
    await pool.end();
    test.skip(true, "DATABASE_URL is not reachable");
    return;
  }

  const columnCheck = await pool.query(
    `SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'appointment_holds'
         AND column_name = 'payment_session_reference'`,
  );

  if ((columnCheck.rowCount ?? 0) === 0) {
    await pool.end();
    test.skip(
      true,
      "appointment_holds.payment_session_reference column is missing",
    );
    return;
  }

  try {
    await pool.query(
      "DELETE FROM appointment_holds WHERE payment_session_reference = $1",
      [paymentSessionReference],
    );

    await pool.query(
      `INSERT INTO appointment_holds (
        public_reference,
        payment_session_reference,
        offering_id,
        offering_snapshot,
        booking_type,
        customer_snapshot,
        selected_start,
        selected_end,
        timezone,
        status,
        expires_at,
        payment_provider
      ) VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, $8, $9, $10, $11, $12)`,
      [
        publicReference,
        paymentSessionReference,
        OFFERING_ID,
        JSON.stringify({
          serviceSlug: SERVICE_SLUG,
          title: "Lash Fill",
          customerStatus: "pending",
          paymentStatus: "pending",
          pricing: {
            depositAmount: 50,
            fullPrice: 130,
            currency: "CAD",
            customAmountMinimum: 50,
            customAmountMaximum: 130,
            addOnPrice: 0,
          },
        }),
        "in-person-appointment",
        JSON.stringify({
          email: "client@example.test",
          name: "Playwright Test",
          phone: "5550100000",
        }),
        new Date(SLOT_START),
        new Date(SLOT_END),
        "America/Toronto",
        "held",
        new Date("2030-07-02T01:00:00.000Z"),
        "square",
      ],
    );

    preconditionsOk = true;
  } finally {
    if (!preconditionsOk) {
      await pool.end();
    }
  }

  const pageErrors: string[] = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  await page.route("**/api/booking/availability?**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        slots: [{ start: SLOT_START, end: SLOT_END }],
      }),
    });
  });

  await page.route("**/api/booking/holds", async (route) => {
    const body = await route.request().postDataJSON();
    expect(body.name).toBeUndefined();
    expect(body.email).toBeUndefined();
    expect(body.phone).toBeUndefined();
    expect(body.paymentOption).toBeUndefined();

    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        hold: {
          paymentSessionReference,
          paymentPageUrl: paymentPageUrl,
          expiresAt: "2030-07-01T23:10:00.000Z",
          start: SLOT_START,
          end: SLOT_END,
          service: { slug: SERVICE_SLUG, title: "Lash Fill" },
        },
      }),
    });
  });

  await page.route("**/api/booking/square/config", async (route) => {
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

  await page.route("**/api/booking/payment/confirm", async (route) => {
    const body = await route.request().postDataJSON();
    expect(body.customer.name).toBe("Playwright Test");
    expect(body.customer.email).toBe("client@example.test");
    expect(body.customer.phone).toBe("5550100000");
    expect(body.customer.marketingOptIn).toBe(true);
    expect(body.policy.accepted).toBe(true);
    expect(body.sourceId).toBe("cnon:test");
    expect(body.verificationToken).toBe("verf:test");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        bookingStatus: "booked",
        card: { last4: "1111" },
        holdReference: publicReference,
        paymentStatus: "captured",
      }),
    });
  });

  await page.route(
    "**/sandbox.web.squarecdn.com/v1/square.js",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body: `
        window.__squareVerificationDetails = null;
        window.Square = {
          payments: function () {
            return {
              card: function () {
                return {
                  attach: async function (selector) {
                    if (document.querySelector(selector) === null) {
                      throw new Error("Missing " + selector);
                    }
                    window.__squareAttachedSelector = selector;
                  },
                  destroy: function () {},
                  tokenize: async function (verificationDetails) {
                    window.__squareVerificationDetails = verificationDetails;
                    return { status: "OK", token: "cnon:test", verificationToken: "verf:test" };
                  },
                };
              },
            };
          },
        };
      `,
      });
    },
  );

  try {
    await page.goto(`/services/${SERVICE_SLUG}/booking`);

    const timeStr = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/Toronto",
    }).format(new Date(SLOT_START));
    await page.getByRole("button", { name: timeStr }).click();

    await page.getByRole("button", { name: /continue$/i }).click();

    await expect(page).toHaveURL(
      new RegExp(
        `/services/${SERVICE_SLUG}/booking/payment\\?session=${paymentSessionReference}`,
      ),
    );

    const container = page.locator("[id^='square-charge-card-container']");
    await expect(container).toBeVisible();

    const attachedSelector = await page.evaluate(async () => {
      for (let i = 0; i < 50; i++) {
        if (typeof window.__squareAttachedSelector === "string") {
          return window.__squareAttachedSelector;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return null;
    });

    expect(attachedSelector).toMatch(/^#square-charge-card-container-/);

    const containerId = await container.getAttribute("id");
    expect(`#${containerId}`).toBe(attachedSelector);

    await page.getByLabel(/Full Name/i).fill("Playwright Test");
    await page.getByLabel(/Email Address/i).fill("client@example.test");
    await page.getByLabel(/Phone Number/i).fill("5550100000");
    await page.getByLabel(/Marketing/i).check();
    await page
      .getByLabel(/I authorize Lash Her to charge today.s booking payment/i)
      .check();

    await expect(page.getByText(/No payment is taken today/i)).toHaveCount(0);
    await expect(page.getByText(/postal code/i)).toBeVisible();
    await expect(page.getByText(/ZIP/i)).toHaveCount(0);

    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().includes("/api/booking/payment/confirm") &&
          response.status() === 200,
      ),
      page.getByRole("button", { name: /Pay and confirm booking/i }).click(),
    ]);

    const verificationDetails = await page.evaluate(
      () => window.__squareVerificationDetails,
    );
    expect(verificationDetails).toMatchObject({
      intent: "CHARGE_AND_STORE",
      currencyCode: "CAD",
      billingContact: {
        countryCode: "CA",
        email: "client@example.test",
      },
    });

    expect(pageErrors).toEqual([]);
    await expect(
      page.getByText(/Missing #square-charge-card-container|was not found/i),
    ).toHaveCount(0);
    await expect(page).toHaveURL(/\/booking\/confirmation/);
  } finally {
    try {
      await pool.query(
        "DELETE FROM appointment_holds WHERE payment_session_reference = $1",
        [paymentSessionReference],
      );
    } finally {
      await pool.end();
    }
  }
});
