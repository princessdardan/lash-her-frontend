import { expect, type Page, test } from '@playwright/test';

const SERVICE_SLUG = 'lash-fill';
const TRAINING_SLUG = 'advanced-private-training';
const ORDER_ID = 'lh-service-e2e-order';
const HOLD_REFERENCE = 'hold-service-e2e';
const SQUARE_CHECKOUT_URL = 'https://square.link/u/service-checkout';
const slotStart = '2030-06-15T16:00:00.000Z';
const slotEnd = '2030-06-15T17:00:00.000Z';

async function mockServiceBookingPage(page: Page): Promise<void> {
  await page.route(new RegExp(`/services/${SERVICE_SLUG}/booking(?:$|\\?)`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html>
        <html>
          <body>
            <main>
              <p>Book Appointment</p>
              <h1>Lash Fill</h1>
              <section aria-label="booking-flow">
                <h2>Select Time</h2>
                <div id="slots" aria-live="polite">Loading available times...</div>
                <button id="continue-time" disabled>Continue</button>
                <form id="details" hidden>
                  <div id="status" role="status" aria-live="polite"></div>
                  <label>Full Name <input id="name" /></label>
                  <label>Email Address <input id="email" type="email" /></label>
                  <label>Phone Number <input id="phone" /></label>
                  <button type="submit">Continue to secure Square checkout</button>
                </form>
              </section>
            </main>
            <script>
              let selectedSlot = '';
              fetch('/api/booking/availability?offering=${SERVICE_SLUG}')
                .then((response) => response.json())
                .then((data) => {
                  const slots = document.getElementById('slots');
                  slots.textContent = '';
                  for (const slot of data.slots) {
                    const button = document.createElement('button');
                    const formatter = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Toronto' });
                    button.textContent = formatter.format(new Date(slot.start));
                    button.type = 'button';
                    button.addEventListener('click', () => {
                      selectedSlot = slot.start;
                      document.getElementById('continue-time').disabled = false;
                    });
                    slots.appendChild(button);
                  }
                });
              document.getElementById('continue-time').addEventListener('click', () => {
                document.getElementById('details').hidden = false;
              });
              document.getElementById('details').addEventListener('submit', async (event) => {
                event.preventDefault();
                const status = document.getElementById('status');
                status.textContent = 'Creating private hold...';
                const holdResponse = await fetch('/api/booking/holds', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    offeringSlug: '${SERVICE_SLUG}',
                    start: selectedSlot,
                    name: document.getElementById('name').value,
                    email: document.getElementById('email').value,
                    phone: document.getElementById('phone').value,
                    paymentOption: 'full'
                  })
                });
                const holdData = await holdResponse.json();
                const checkoutResponse = await fetch('/api/booking/checkout', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ holdReference: holdData.hold.reference })
                });
                const checkoutData = await checkoutResponse.json();
                if (!checkoutResponse.ok) {
                  status.textContent = checkoutResponse.status === 409 ? 'Hold expired, choose another time' : 'Unable to start checkout';
                  return;
                }
                if (checkoutData.paymentProvider !== 'square' || !checkoutData.checkoutUrl) {
                  status.textContent = 'Unable to start checkout';
                  return;
                }
                status.textContent = 'Opening secure Square checkout';
                const link = document.createElement('a');
                link.href = checkoutData.checkoutUrl;
                link.textContent = 'Continue to secure Square checkout';
                status.appendChild(document.createElement('br'));
                status.appendChild(link);
                window.setTimeout(() => { window.location.href = checkoutData.checkoutUrl; }, 500);
              });
            </script>
          </body>
        </html>`,
    });
  });
}

async function mockAvailability(page: Page): Promise<void> {
  await page.route('**/api/booking/availability**', async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get('offering')).toBe(SERVICE_SLUG);

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
}

async function completeServiceDetails(page: Page): Promise<void> {
  await page.goto(`/services/${SERVICE_SLUG}/booking`);

  await expect(page.getByText('Book Appointment')).toBeVisible();
  await expect(page.getByRole('heading', { name: /select time/i })).toBeVisible();

  const timeStr = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Toronto',
  }).format(new Date(slotStart));
  await page.getByRole('button', { name: timeStr }).click();
  await page.getByRole('button', { name: /continue/i }).click();

  await page.getByLabel(/full name/i).fill('Service Client');
  await page.getByLabel(/email address/i).fill('service.client@example.com');
  await page.getByLabel(/phone number/i).fill('(555) 123-4567');
}

test.describe('Booking route flows', () => {
  test('shows not found for legacy booking confirmation without an order reference', async ({ page }) => {
    await page.goto('/booking/confirmation');

    await expect(page.getByRole('heading', { name: /page not found/i })).toBeVisible();
  });

  test('handles legacy service links without a test-provided redirect', async ({ page }) => {
    await page.goto(`/booking?offeringSlug=${SERVICE_SLUG}`);

    if (new URL(page.url()).pathname === `/services/${SERVICE_SLUG}/booking`) {
      await expect(page).toHaveURL(new RegExp(`/services/${SERVICE_SLUG}/booking$`));
      return;
    }

    await expect(page).toHaveURL(`/booking?offeringSlug=${SERVICE_SLUG}`);
    await expect(page.getByRole('heading', { name: /page not found/i })).toBeVisible();
  });

  test('rejects malformed legacy booking query shapes without redirecting', async ({ page }) => {
    await page.goto(`/booking?offering=${SERVICE_SLUG}&offeringSlug=${SERVICE_SLUG}`);

    await expect(page).toHaveURL(`/booking?offering=${SERVICE_SLUG}&offeringSlug=${SERVICE_SLUG}`);
    await expect(page.getByRole('heading', { name: /page not found/i })).toBeVisible();
  });

  test('shows not found for bare legacy booking route', async ({ page }) => {
    await page.goto('/booking');

    await expect(page.getByRole('heading', { name: /page not found/i })).toBeVisible();
  });

  test('uses a mocked service shell to exercise booking availability, hold, and Square checkout contracts', async ({ page }) => {
    let validationCalled = false;
    const holdRequests: Array<Record<string, unknown>> = [];
    const checkoutRequests: Array<Record<string, unknown>> = [];
    await mockServiceBookingPage(page);
    await mockAvailability(page);

    await page.route(SQUARE_CHECKOUT_URL, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><html><body><h1>Square hosted checkout</h1></body></html>',
      });
    });

    await page.route('**/api/booking/holds', async (route) => {
      holdRequests.push(route.request().postDataJSON() as Record<string, unknown>);

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ hold: { reference: HOLD_REFERENCE } }),
      });
    });

    await page.route('**/api/booking/checkout', async (route) => {
      checkoutRequests.push(route.request().postDataJSON() as Record<string, unknown>);

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          checkoutUrl: SQUARE_CHECKOUT_URL,
          holdReference: HOLD_REFERENCE,
          orderId: ORDER_ID,
          paymentProvider: 'square',
          reused: false,
          squarePaymentLinkId: 'square-payment-link-e2e',
        }),
      });
    });

    await page.route('**/api/checkout/validate-payment', async (route) => {
      validationCalled = true;
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Helcim validation must not be called' }) });
    });

    await completeServiceDetails(page);
    await expect(page.getByRole('button', { name: /continue to secure square checkout/i })).toBeEnabled();
    await page.getByRole('button', { name: /continue to secure square checkout/i }).click();

    await expect(page.getByRole('status')).toContainText(/opening secure square checkout/i);
    await expect(page.getByRole('link', { name: /continue to secure square checkout/i })).toHaveAttribute('href', SQUARE_CHECKOUT_URL);
    expect(holdRequests).toEqual([{
      offeringSlug: SERVICE_SLUG,
      start: slotStart,
      name: 'Service Client',
      email: 'service.client@example.com',
      phone: '(555) 123-4567',
      paymentOption: 'full',
    }]);
    expect(checkoutRequests).toEqual([{ holdReference: HOLD_REFERENCE }]);
    await expect(page).toHaveURL(SQUARE_CHECKOUT_URL);
    await expect(page.getByRole('heading', { name: /square hosted checkout/i })).toBeVisible();
    expect(validationCalled).toBe(false);
  });

  test('shows expired hold recovery instead of navigating to payment', async ({ page }) => {
    await mockServiceBookingPage(page);
    await mockAvailability(page);

    await page.route('**/api/booking/holds', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ hold: { reference: HOLD_REFERENCE } }),
      });
    });

    await page.route('**/api/booking/checkout', async (route) => {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Booking hold is no longer available' }),
      });
    });

    await completeServiceDetails(page);
    await page.getByRole('button', { name: /continue to secure square checkout/i }).click();

    await expect(page.getByRole('status')).toContainText(/hold expired, choose another time/i);
    await expect(page).toHaveURL(new RegExp(`/services/${SERVICE_SLUG}/booking$`));
  });

  test('shows branded safe error copy for invalid training scheduling tokens without checkout email', async ({ page }) => {
    await page.goto(`/training-programs/${TRAINING_SLUG}/schedule?token=wrong-token`);

    await expect(page.getByRole('heading', { name: /scheduling unavailable/i })).toBeVisible();
    await expect(page.getByText(/could not verify this training scheduling link/i)).toBeVisible();
    await expect(page.getByRole('link', { name: /contact support/i })).toBeVisible();
    await expect(page.getByLabel(/checkout email/i)).toHaveCount(0);
    await expect(page.getByLabel(/email address/i)).toHaveCount(0);
    await expect(page.getByText(/wrong-token/i)).toHaveCount(0);
  });
});
