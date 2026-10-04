import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { Pool } from "pg";
import { FRESHA_BOOKING_URL } from "../src/lib/booking/fresha";
import { createPrivateDbPoolConfig } from "../src/lib/private-db/pool-config";
import { getAdminCalendarE2EDatabaseUrl } from "./support/admin-calendar-e2e-config";

test("real service catalog stays visible without booking integrations and links to Fresha", async ({
  page,
}) => {
  const databaseUrl = getAdminCalendarE2EDatabaseUrl();
  test.skip(!databaseUrl, "Requires isolated TEST_DATABASE_URL");
  const pool = new Pool(createPrivateDbPoolConfig(databaseUrl!));
  const [resource, provider, service, offering] = Array.from(
    { length: 4 },
    () => randomUUID(),
  );
  const slug = `fresha-${service}`;
  try {
    await pool.query(
      "INSERT INTO booking_resources (id, resource_key, name, kind, timezone, status) VALUES ($1, $2, 'Fresha fixture', 'provider', 'America/Toronto', 'disabled')",
      [resource, `fresha-${resource}`],
    );
    await pool.query(
      "INSERT INTO booking_providers (id, provider_key, display_name, primary_resource_id, public_slug, status) VALUES ($1, $2, 'Fresha Provider', $3, $2, 'active')",
      [provider, `fresha-${provider}`, resource],
    );
    await pool.query(
      "INSERT INTO booking_services (id, service_key, display_title, public_slug, status) VALUES ($1, $2, 'Fresha Test Service', $2, 'active')",
      [service, slug],
    );
    await pool.query(
      "INSERT INTO booking_service_offerings (id, offering_key, service_id, provider_id, primary_resource_id, duration_minutes, full_price_cents, deposit_amount_cents, public_summary, status) VALUES ($1, $2, $3, $4, $5, 90, 15000, 5000, 'Retained provider service description.', 'active')",
      [offering, `fresha-${offering}`, service, provider, resource],
    );
    await page.context().addCookies([
      {
        domain: "localhost",
        path: "/",
        name: "lh_contact_popup_dismissed",
        value: "true",
      },
    ]);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/services");
    await page.getByRole("tab", { name: "Fresha", exact: true }).click();
    const panel = page.getByRole("tabpanel", {
      name: "Fresha",
      exact: true,
    });
    await expect(
      panel.getByRole("heading", { name: "Fresha Test Service" }),
    ).toBeVisible();
    await expect(panel.getByText("90 min")).toBeVisible();
    await expect(panel.getByText("$150.00 CAD", { exact: true })).toBeVisible();
    await expect(
      panel.getByText("Retained provider service description."),
    ).toBeVisible();
    await expect(
      panel.getByRole("link", { name: "Book on Fresha" }),
    ).toHaveAttribute("href", FRESHA_BOOKING_URL);
    await expect(
      page
        .locator("p:visible")
        .filter({ hasText: /final booking details are confirmed on Fresha/ }),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      panel.getByRole("link", { name: "Book on Fresha" }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await pool.query("DELETE FROM booking_service_offerings WHERE id = $1", [
      offering,
    ]);
    await pool.query("DELETE FROM booking_services WHERE id = $1", [service]);
    await pool.query("DELETE FROM booking_providers WHERE id = $1", [provider]);
    await pool.query("DELETE FROM booking_resources WHERE id = $1", [resource]);
    await pool.end();
  }
});
