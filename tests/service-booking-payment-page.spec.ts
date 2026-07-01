import { test, expect, type TestInfo } from "@playwright/test";
import { config } from "dotenv";
import { Pool } from "pg";

import { createPrivateDbPoolConfig } from "../src/lib/private-db/pool-config";

config({ path: [".env.local", ".env"] });

declare global {
  interface Window {
    __squareAttachedSelector?: string;
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
          payment: { amount: 130, currency: "CAD" },
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

  await page.route(
    "**/sandbox.web.squarecdn.com/v1/square.js",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body: `
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
                  tokenize: async function () {
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

    await page.getByLabel(/Full Name/i).fill("Playwright Test");
    await page.getByLabel(/Email Address/i).fill("client@example.test");
    await page.getByLabel(/Phone Number/i).fill("5550100000");
    await page
      .getByRole("button", { name: /Continue to secure Square checkout/i })
      .click();

    await expect(page).toHaveURL(
      new RegExp(
        `/services/${SERVICE_SLUG}/booking/payment\\?session=${paymentSessionReference}`,
      ),
    );

    const container = page.locator("[id^='square-card-container']");
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

    expect(attachedSelector).toMatch(/^#square-card-container-/);

    const containerId = await container.getAttribute("id");
    expect(`#${containerId}`).toBe(attachedSelector);

    expect(pageErrors).toEqual([]);
    await expect(
      page.getByText(/Missing #square-card-container|was not found/i),
    ).toHaveCount(0);
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
