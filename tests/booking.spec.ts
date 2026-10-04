import { expect, test } from "@playwright/test";
import { FRESHA_BOOKING_URL } from "../src/lib/booking/fresha";
const TRAINING_SLUG = "advanced-private-training";

test.describe("Fresha service booking cutover", () => {
  for (const path of [
    "/booking",
    "/booking?offering=lash-fill&email=private@example.test&session=secret",
    "/services/lash-fill/booking?provider=nataliea&session=secret",
    "/services/unknown/booking",
  ]) {
    test(`redirects ${path.split("?")[0]} to the fixed Fresha destination (${path.length})`, async ({
      request,
    }) => {
      const response = await request.get(path, { maxRedirects: 0 });
      expect(response.status()).toBe(307);
      expect(response.headers().location).toBe(FRESHA_BOOKING_URL);
    });
  }

  test("booking-page form submissions never forward their bodies to Fresha", async ({
    request,
  }) => {
    for (const path of [
      "/booking?session=private",
      "/services/lash-fill/booking",
    ]) {
      const response = await request.post(path, {
        data: { email: "private@example.test", session: "private" },
        maxRedirects: 0,
      });
      expect(response.status()).toBe(410);
      expect(response.headers().location).toBeUndefined();
      expect(await response.json()).toMatchObject({
        code: "SERVICE_BOOKING_MOVED",
        bookingUrl: FRESHA_BOOKING_URL,
      });
    }
  });

  test("old browser tabs cannot create a reservation or fetch availability", async ({
    request,
  }) => {
    for (const [path, method] of [
      ["availability", "GET"],
      ["availability", "POST"],
      ["holds", "POST"],
      ["create", "POST"],
    ]) {
      const response = await request.fetch(`/api/booking/${path}`, {
        method,
        ...(method === "POST" ? { data: "{invalid json" } : {}),
      });
      expect(response.status()).toBe(410);
      expect(await response.json()).toMatchObject({
        code: "SERVICE_BOOKING_MOVED",
        bookingUrl: FRESHA_BOOKING_URL,
      });
    }
  });

  test("booking entry navigation leaves the app without fetching Square or availability", async ({
    page,
  }) => {
    const bookingRequests: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/booking/"))
        bookingRequests.push(request.url());
    });
    await page.route(FRESHA_BOOKING_URL, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<h1>Fresha destination</h1>",
      }),
    );
    await page.goto("/services/lash-fill/booking?session=must-not-leak");
    await expect(page).toHaveURL(FRESHA_BOOKING_URL);
    expect(bookingRequests).toEqual([]);
  });

  test("historical confirmation and payment child routes are not redirected to Fresha", async ({
    page,
  }) => {
    for (const path of [
      "/booking/confirmation",
      "/services/booking/confirmation",
      "/services/lash-fill/booking/confirmation",
      "/services/lash-fill/booking/payment",
    ]) {
      await page.goto(path);
      await expect(page).not.toHaveURL(FRESHA_BOOKING_URL);
      await expect(
        page.getByRole("heading", { name: /page not found/i }),
      ).toBeVisible();
    }
  });

  test("admin authentication remains separate from the public Fresha redirect", async ({
    request,
  }) => {
    const response = await request.get("/admin/appointments", {
      maxRedirects: 0,
    });
    expect(response.status()).toBe(307);
    const location = new URL(
      response.headers().location,
      "http://localhost:3000",
    );
    expect(location.pathname).toBe("/admin/sign-in");
    expect(location.searchParams.get("returnTo")).toBe("/admin/appointments");
  });

  test("shows branded safe error copy for invalid training scheduling tokens without checkout email", async ({
    page,
  }) => {
    await page.route(
      new RegExp(`/training-programs/${TRAINING_SLUG}/schedule(?:$|\\?)`),
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: `<!doctype html>
          <html>
            <body>
              <main>
                <h1>Scheduling unavailable</h1>
                <p>We could not verify this training scheduling link.</p>
                <a href="/contact">Contact support</a>
              </main>
            </body>
          </html>`,
        });
      },
    );

    await page.goto(
      `/training-programs/${TRAINING_SLUG}/schedule?token=wrong-token`,
    );

    await expect(
      page.getByRole("heading", { name: /scheduling unavailable/i }),
    ).toBeVisible();
    await expect(
      page.getByText(/could not verify this training scheduling link/i),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /contact support/i }),
    ).toBeVisible();
    await expect(page.getByLabel(/checkout email/i)).toHaveCount(0);
    await expect(page.getByLabel(/email address/i)).toHaveCount(0);
    await expect(page.getByText(/wrong-token/i)).toHaveCount(0);
  });
});
