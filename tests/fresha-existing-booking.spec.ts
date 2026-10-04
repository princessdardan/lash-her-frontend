import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { Pool } from "pg";
import { createPrivateDbPoolConfig } from "../src/lib/private-db/pool-config";
import { createAdminCalendarAuthFixture } from "./support/admin-calendar-auth-fixture";
import { getAdminCalendarE2EDatabaseUrl } from "./support/admin-calendar-e2e-config";

test("existing booking confirmation and authorized staff views survive closure", async ({
  page,
  request,
}) => {
  const databaseUrl = getAdminCalendarE2EDatabaseUrl();
  test.skip(!databaseUrl, "Requires isolated TEST_DATABASE_URL");
  const auth = await createAdminCalendarAuthFixture();
  const pool = new Pool(createPrivateDbPoolConfig(databaseUrl!));
  const [service, offering, hold, appointment] = Array.from({ length: 4 }, () =>
    randomUUID(),
  );
  const slug = `retained-${service}`;
  const orderReference = `retained-order-${hold}`;
  const publicReference = `retained-${appointment}`;
  const offeringSnapshot = {
    slug,
    serviceSlug: slug,
    title: "Retained Service",
    serviceTitle: "Retained Service",
    durationMinutes: 90,
    depositAmount: 50,
    fullPrice: 150,
    currency: "CAD",
  };

  try {
    const {
      rows: [provider],
    } = await pool.query<{
      id: string;
      primary_resource_id: string;
    }>(
      "SELECT id, primary_resource_id FROM booking_providers WHERE display_name = $1",
      [auth.resourceName],
    );
    await pool.query(
      "INSERT INTO booking_services (id, service_key, display_title, public_slug, status) VALUES ($1, $2, 'Retained Service', $2, 'active')",
      [service, slug],
    );
    await pool.query(
      "INSERT INTO booking_service_offerings (id, offering_key, service_id, provider_id, primary_resource_id, duration_minutes, full_price_cents, deposit_amount_cents, status) VALUES ($1, $2, $3, $4, $5, 90, 15000, 5000, 'active')",
      [
        offering,
        `retained-${offering}`,
        service,
        provider.id,
        provider.primary_resource_id,
      ],
    );
    await pool.query(
      `INSERT INTO appointment_holds (
        id, public_reference, offering_id, offering_snapshot, booking_type,
        customer_snapshot, selected_start, selected_end, timezone, status,
        expires_at, payment_provider, checkout_order_public_id, google_event_id,
        payment_session_reference
      ) VALUES ($1, $2, $3, $4::jsonb, 'in-person-appointment', $5::jsonb,
        '2032-07-01T14:00:00Z', '2032-07-01T15:30:00Z', 'America/Toronto',
        'booked', now() - interval '1 day', 'square', $6, $7, $8)`,
      [
        hold,
        `retained-hold-${hold}`,
        offering,
        JSON.stringify(offeringSnapshot),
        JSON.stringify({
          name: "Retained Client",
          email: "retained@example.test",
        }),
        orderReference,
        `retained-calendar-event-${appointment}`,
        `retained-session-${hold}`,
      ],
    );
    await pool.query(
      `INSERT INTO appointments (
        id, public_reference, source_hold_id, service_offering_id, provider_id,
        primary_resource_id, offering_snapshot, provider_snapshot, customer_name,
        customer_email, customer_email_normalized, selected_start, selected_end,
        occupied_start, occupied_end, timezone, status, payment_status,
        calendar_sync_status, booking_confirmation_email_sent_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, 'Retained Client',
        'retained@example.test', 'retained@example.test',
        '2032-07-01T14:00:00Z', '2032-07-01T15:30:00Z',
        '2032-07-01T14:00:00Z', '2032-07-01T15:30:00Z', 'America/Toronto',
        'confirmed', 'paid', 'synced', now())`,
      [
        appointment,
        publicReference,
        hold,
        offering,
        provider.id,
        provider.primary_resource_id,
        JSON.stringify(offeringSnapshot),
        JSON.stringify({ displayName: auth.resourceName }),
      ],
    );
    await pool.query(
      `INSERT INTO booking_payment_attempts (
        hold_id, appointment_id, operation, status, payment_provider,
        idempotency_key, provider_payment_id, amount_cents
      ) VALUES ($1, $2, 'service_booking_charge', 'captured', 'square', $3, $3, 5000)`,
      [hold, appointment, `retained-payment-${appointment}`],
    );
    const snapshot = async () => ({
      appointment: (
        await pool.query("SELECT * FROM appointments WHERE id = $1", [
          appointment,
        ])
      ).rows,
      hold: (
        await pool.query("SELECT * FROM appointment_holds WHERE id = $1", [
          hold,
        ])
      ).rows,
      payments: (
        await pool.query(
          "SELECT * FROM booking_payment_attempts WHERE appointment_id = $1",
          [appointment],
        )
      ).rows,
    });
    const before = await snapshot();

    const closed = await request.post("/api/booking/holds", {
      data: { holdReference: `retained-hold-${hold}` },
    });
    expect(closed.status()).toBe(410);
    await page.context().addCookies([
      {
        domain: "localhost",
        path: "/",
        name: "lh_contact_popup_dismissed",
        value: "true",
      },
    ]);
    await page.goto(
      `/services/${slug}/booking/confirmation?order=${orderReference}`,
    );
    await expect(
      page.getByRole("heading", { name: "Booking Confirmed", exact: true }),
    ).toBeVisible();
    await expect(
      page.locator("p:visible").filter({ hasText: orderReference }),
    ).toBeVisible();

    await page.context().addCookies(auth.ownerStorageState.cookies);
    await page.goto(`/admin/appointments?view=all&q=${publicReference}`);
    const appointmentRow = page
      .getByRole("row")
      .filter({ hasText: publicReference });
    await expect(appointmentRow).toContainText("Retained Client");
    await appointmentRow
      .locator(`a[href="/admin/appointments/${appointment}"]`)
      .click();
    await expect(
      page.getByRole("heading", { name: "Retained Client", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("retained@example.test", { exact: true }),
    ).toBeVisible();
    expect(await snapshot()).toEqual(before);
  } finally {
    await pool.query(
      "DELETE FROM booking_payment_attempts WHERE appointment_id = $1",
      [appointment],
    );
    await pool.query("DELETE FROM appointments WHERE id = $1", [appointment]);
    await pool.query("DELETE FROM appointment_holds WHERE id = $1", [hold]);
    await pool.query("DELETE FROM booking_service_offerings WHERE id = $1", [
      offering,
    ]);
    await pool.query("DELETE FROM booking_services WHERE id = $1", [service]);
    await pool.end();
    await auth.cleanup();
  }
});
