import { expect, type Page, test } from '@playwright/test';

const SERVICE_SLUG = 'lash-fill';
const TRAINING_SLUG = 'advanced-private-training';
const ORDER_ID = 'lh-service-e2e-order';
const HOLD_REFERENCE = 'hold-service-e2e';
const SQUARE_CHECKOUT_URL = `http://localhost:3000/api/booking/square/return?orderId=${ORDER_ID}&paymentId=mock-square-payment-1`;
const FORBIDDEN_PAYMENT_HOSTS = new Set(['api.helcim.com', 'connect.squareup.com', 'connect.squareupsandbox.com']);
const slotStart = '2030-06-15T16:00:00.000Z';
const slotEnd = '2030-06-15T17:00:00.000Z';

async function mockServiceBookingPage(page: Page, checkoutScenario: 'success' | 'conflict' = 'success'): Promise<void> {
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
                const checkoutResponse = await fetch('/api/booking/checkout?mockPaymentScenario=${checkoutScenario}', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'x-lash-payment-mock-scenario': '${checkoutScenario}' },
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

function collectForbiddenPaymentHosts(page: Page): string[] {
  const hosts: string[] = [];

  page.on('request', (request) => {
    const host = new URL(request.url()).host;

    if (FORBIDDEN_PAYMENT_HOSTS.has(host)) {
      hosts.push(host);
    }
  });

  return hosts;
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
    const apiRequests: string[] = [];
    const forbiddenPaymentHosts = collectForbiddenPaymentHosts(page);
    await mockServiceBookingPage(page);
    await mockAvailability(page);

    page.on('request', (request) => {
      const url = new URL(request.url());

      if (url.origin === 'http://localhost:3000' && url.pathname.startsWith('/api/')) {
        apiRequests.push(`${request.method()} ${url.pathname}`);
      }
    });

    await page.route('**/api/booking/square/return**', async (route) => {
      const url = new URL(route.request().url());
      expect(url.searchParams.get('orderId')).toBe(ORDER_ID);
      expect(url.searchParams.get('paymentId')).toBe('mock-square-payment-1');

      await route.fulfill({
        status: 302,
        headers: { location: '/booking/confirmation?payment=paid_calendar_pending' },
        body: '',
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

    await page.route(/\/api\/booking\/checkout(?:\?.*)?$/, async (route) => {
      const url = new URL(route.request().url());
      expect(url.searchParams.get('mockPaymentScenario')).toBe('success');
      expect(route.request().headers()['x-lash-payment-mock-scenario']).toBe('success');
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
    await expect(page).toHaveURL('/booking/confirmation?payment=paid_calendar_pending');
    await expect(page.getByRole('heading', { name: /payment verification pending/i })).toBeVisible();
    await expect(page.getByRole('status')).toContainText(/your payment was received/i);
    expect(apiRequests).toEqual([
      'GET /api/booking/availability',
      'POST /api/booking/holds',
      'POST /api/booking/checkout',
      'GET /api/booking/square/return',
    ]);
    expect(forbiddenPaymentHosts).toEqual([]);
    expect(validationCalled).toBe(false);
  });

  test('shows expired hold recovery instead of navigating to payment', async ({ page }) => {
    const forbiddenPaymentHosts = collectForbiddenPaymentHosts(page);
    await mockServiceBookingPage(page, 'conflict');
    await mockAvailability(page);

    await page.route('**/api/booking/holds', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ hold: { reference: HOLD_REFERENCE } }),
      });
    });

    await page.route(/\/api\/booking\/checkout(?:\?.*)?$/, async (route) => {
      const url = new URL(route.request().url());
      expect(url.searchParams.get('mockPaymentScenario')).toBe('conflict');
      expect(route.request().headers()['x-lash-payment-mock-scenario']).toBe('conflict');

      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Booking hold is no longer available' }),
      });
    });

    await completeServiceDetails(page);
    await page.getByRole('button', { name: /continue to secure square checkout/i }).click();

    await expect(page.getByRole('status')).toContainText(/hold expired, choose another time/i);
    await expect(page.getByRole('link', { name: /continue to secure square checkout/i })).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/services/${SERVICE_SLUG}/booking$`));
    expect(forbiddenPaymentHosts).toEqual([]);
  });

  test('shows branded safe error copy for invalid training scheduling tokens without checkout email', async ({ page }) => {
    await page.route(new RegExp(`/training-programs/${TRAINING_SLUG}/schedule(?:$|\\?)`), async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
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
    });

    await page.goto(`/training-programs/${TRAINING_SLUG}/schedule?token=wrong-token`);

    await expect(page.getByRole('heading', { name: /scheduling unavailable/i })).toBeVisible();
    await expect(page.getByText(/could not verify this training scheduling link/i)).toBeVisible();
    await expect(page.getByRole('link', { name: /contact support/i })).toBeVisible();
    await expect(page.getByLabel(/checkout email/i)).toHaveCount(0);
    await expect(page.getByLabel(/email address/i)).toHaveCount(0);
    await expect(page.getByText(/wrong-token/i)).toHaveCount(0);
  });
});
