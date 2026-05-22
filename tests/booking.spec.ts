import { expect, test } from '@playwright/test';

const bookingUrl = '/booking?type=training-call';
const confirmationText = 'Your booking is confirmed. Check your email for details and a Google Calendar invitation.';
const slotStart = '2030-06-15T16:00:00.000Z';
const slotEnd = '2030-06-15T16:30:00.000Z';

test.describe('Booking Page', () => {
  test('shows not found for booking confirmation without an order reference', async ({ page }) => {
    await page.goto('/booking/confirmation');

    await expect(page.getByRole('heading', { name: /page not found/i })).toBeVisible();
  });

  test('keeps in-person-appointment selection on the query URL', async ({ page }) => {
    await page.goto('/booking?type=in-person-appointment');

    await expect(page).toHaveURL(/\/booking\?type=in-person-appointment$/);
    await expect(page.getByRole('heading', { name: /select service/i })).toBeVisible();
  });

  test('renders the booking flow with no available times', async ({ page }) => {
    await page.route('**/api/booking/availability?type=training-call', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ slots: [] }),
      });
    });

    await page.goto(bookingUrl);

    await expect(page.getByRole('heading', { name: /select time/i })).toBeVisible();
    await expect(page.getByText('No times available for this service.')).toBeVisible();
  });

  test('submits a booking and shows confirmation', async ({ page }) => {
    await page.route('**/api/booking/availability?type=training-call', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          slots: [
            {
              start: slotStart,
              end: slotEnd,
            },
          ],
        }),
      });
    });

    await page.route('**/api/booking/create', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, eventId: 'event-1' }),
      });
    });

    await page.goto(bookingUrl);

    await expect(page.getByRole('heading', { name: /select time/i })).toBeVisible();

    const timeStr = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/Toronto",
    }).format(new Date(slotStart));
    await page.getByRole('button', { name: timeStr }).click();

    await page.getByRole('button', { name: /continue/i }).click();

    await page.getByLabel(/full name/i).fill('Test Client');
    await page.getByLabel(/email address/i).fill('test.client@example.com');
    await page.getByLabel(/phone number/i).fill('(555) 123-4567');

    await page.getByRole('button', { name: /confirm booking/i }).click();

    await expect(page.getByText(confirmationText)).toBeVisible();
  });
});
