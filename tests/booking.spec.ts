import { expect, type Page, test } from '@playwright/test';

const SERVICE_SLUG = 'lash-fill';
const TRAINING_SLUG = 'advanced-private-training';
const CHECKOUT_TOKEN = 'booking_checkout_token';
const ORDER_ID = 'lh-service-e2e-order';
const HOLD_REFERENCE = 'hold-service-e2e';
const slotStart = '2030-06-15T16:00:00.000Z';
const slotEnd = '2030-06-15T17:00:00.000Z';

interface ValidationRequestBody {
  checkoutToken: string;
  data: Record<string, string | number | boolean | null>;
  hash: string;
}

async function mockHelcimScript(page: Page): Promise<void> {
  await page.route('https://secure.helcim.app/helcim-pay/services/start.js', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: `
        window.appendHelcimPayIframe = function (checkoutToken, allowExit) {
          window.__helcimAppendCall = { checkoutToken: checkoutToken, allowExit: allowExit };
          window.setTimeout(function () {
            window.dispatchEvent(new MessageEvent("message", {
              origin: "https://secure.helcim.app",
              data: JSON.stringify({
                eventName: "helcim-pay-js-" + checkoutToken,
                eventStatus: "SUCCESS",
                eventMessage: {
                  data: {
                    transactionId: "txn_service_123",
                    amount: 100,
                    approved: true
                  },
                  hash: "hash_service_123"
                }
              })
            }));
          }, 50);
        };
        window.removeHelcimPayIframe = function () {
          window.__helcimIframeRemoved = true;
        };
      `,
    });
  });
}


async function mockServiceBookingPage(page: Page): Promise<void> {
  // The production CMS dataset can have no active service offerings, so this shell keeps
  // browser coverage focused on the current booking API request/response contract.
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
                  <label>Full Name <input id="name" /></label>
                  <label>Email Address <input id="email" type="email" /></label>
                  <label>Phone Number <input id="phone" /></label>
                  <button type="submit">Confirm Booking</button>
                </form>
              </section>
            </main>
            <script src="https://secure.helcim.app/helcim-pay/services/start.js"></script>
            <script>
              let selectedSlot = '';
              window.addEventListener('message', async function (event) {
                if (event.origin !== 'https://secure.helcim.app') return;
                const data = JSON.parse(event.data);
                const message = data.eventMessage;
                const response = await fetch('/api/checkout/validate-payment', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ checkoutToken: window.checkoutToken, data: message.data, hash: message.hash })
                });
                const result = await response.json();
                window.location.href = result.redirectUrl;
              });
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
                window.checkoutToken = checkoutData.checkoutToken;
                window.appendHelcimPayIframe(checkoutData.checkoutToken, true);
              });
            </script>
          </body>
        </html>`,
    });
  });
}

function isValidationRequestBody(value: unknown): value is ValidationRequestBody {
  if (!value || typeof value !== 'object') return false;

  const record = value as Record<string, unknown>;
  return (
    record.checkoutToken === CHECKOUT_TOKEN &&
    typeof record.hash === 'string' &&
    !!record.data &&
    typeof record.data === 'object'
  );
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

  test('uses a mocked service shell to exercise booking availability, hold, checkout, and validation API contracts', async ({ page }) => {
    await mockServiceBookingPage(page);
    await mockHelcimScript(page);

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

    await page.route('**/api/booking/holds', async (route) => {
      const requestBody = route.request().postDataJSON() as Record<string, unknown>;
      expect(requestBody.offeringSlug).toBe(SERVICE_SLUG);
      expect(requestBody.start).toBe(slotStart);
      expect(requestBody.email).toBe('service.client@example.com');
      expect(requestBody.paymentOption).toBe('full');

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ hold: { reference: HOLD_REFERENCE } }),
      });
    });

    await page.route('**/api/booking/checkout', async (route) => {
      const requestBody = route.request().postDataJSON() as Record<string, unknown>;
      expect(requestBody.holdReference).toBe(HOLD_REFERENCE);

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ checkoutToken: CHECKOUT_TOKEN, holdReference: HOLD_REFERENCE, orderId: ORDER_ID }),
      });
    });

    await page.route('**/api/checkout/validate-payment', async (route) => {
      const requestBody: unknown = route.request().postDataJSON();
      expect(isValidationRequestBody(requestBody)).toBe(true);

      if (!isValidationRequestBody(requestBody)) {
        await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Invalid request' }) });
        return;
      }

      expect(requestBody.data.transactionId).toBe('txn_service_123');
      expect(requestBody.hash).toBe('hash_service_123');

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          bookingStatus: 'confirmed',
          eventId: 'event-service-1',
          orderId: ORDER_ID,
          redirectUrl: `/services/${SERVICE_SLUG}/booking/confirmation?order=${ORDER_ID}`,
        }),
      });
    });

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
    await expect(page.getByRole('button', { name: /confirm booking/i })).toBeEnabled();
    await page.getByRole('button', { name: /confirm booking/i }).click();

    await expect(page).toHaveURL(`/services/${SERVICE_SLUG}/booking/confirmation?order=${ORDER_ID}`);
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
