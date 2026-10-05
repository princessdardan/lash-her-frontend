import { expect, test } from "@playwright/test";
import { FRESHA_BOOKING_URL } from "../src/lib/booking/fresha";

test("services offers the editorial listing or the editor's direct Fresha redirect", async ({
  page,
}) => {
  await page
    .context()
    .addCookies([
      {
        domain: "localhost",
        path: "/",
        name: "lh_contact_popup_dismissed",
        value: "true",
      },
    ]);
  // Stop at the handoff, without making requests to Fresha.
  await page.route("https://www.fresha.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<h1>Fresha destination</h1>",
    }),
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/services?provider=old-provider&session=must-not-leak");

  // This smoke test accepts either published editor setting. Unit tests cover
  // both settings deterministically, including switching the redirect off.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    /^(Services|Fresha destination)$/,
  );
  if (page.url().startsWith("https://www.fresha.com/")) {
    await expect(page).toHaveURL(FRESHA_BOOKING_URL);
  } else {
    const main = page.getByRole("main");
    await expect(main.getByRole("tablist")).toHaveCount(0);
    const bookingLink = main.getByRole("link", {
      name: "View services & book on Fresha",
      exact: true,
    });
    await expect(bookingLink).toHaveAttribute("href", FRESHA_BOOKING_URL);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(bookingLink).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await bookingLink.click();
    await expect(page).toHaveURL(FRESHA_BOOKING_URL);
  }
  expect(errors).toEqual([]);
});
