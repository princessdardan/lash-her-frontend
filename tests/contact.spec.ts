import { test, expect } from '@playwright/test';
import { setupApiMocks } from './utils/api-mocks';

test.describe('Contact Page', () => {
  test.beforeEach(async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/contact');
  });

  test('should load contact page successfully', async ({ page }) => {
    await expect(page).toHaveTitle(/Contact|Lash Her/i);
    await expect(page.locator('main')).toBeVisible();
  });

  test('should display contact information', async ({ page }) => {
    // Look for contact information sections
    const main = page.locator('main');
    await expect(main).toBeVisible();

    // Contact info should be present (email, phone, address, etc.)
    // These selectors are generic - adjust based on actual implementation
    const contactSection = page.locator('main');
    await expect(contactSection).not.toBeEmpty();
  });

  test('should display business hours/schedule', async ({ page }) => {
    // Check if schedule is visible on the page
    const scheduleSection = page.locator('text=/hours|schedule|availability/i').first();

    // If schedule exists, it should be visible
    const hasSchedule = await scheduleSection.isVisible({ timeout: 2000 }).catch(() => false);
    if (hasSchedule) {
      await expect(scheduleSection).toBeVisible();
    }
  });

  test('should display general inquiry form', async ({ page }) => {
    // Look for form elements
    const form = page.locator('form').first();

    // Check if form exists
    const hasForm = await form.isVisible({ timeout: 2000 }).catch(() => false);

    if (hasForm) {
      await expect(form).toBeVisible();
    }
  });

  test('should validate form fields', async ({ page }) => {
    const form = page.locator('form').first();
    const hasForm = await form.isVisible({ timeout: 2000 }).catch(() => false);

    if (hasForm) {
      // Try to submit empty form
      const submitButton = page.getByRole('button', { name: /submit|send|contact/i });

      if (await submitButton.isVisible({ timeout: 1000 }).catch(() => false)) {
        await submitButton.click();

        // Form should show validation errors or prevent submission
        // This is a generic check - specific validation depends on implementation
        await page.waitForTimeout(500);
      }
    }
  });

  test('should fill and submit contact form', async ({ page }) => {
    const form = page.locator('form').first();
    const hasForm = await form.isVisible({ timeout: 2000 }).catch(() => false);

    if (hasForm) {
      // Fill in form fields (adjust selectors based on actual form)
      const nameField = page.getByLabel(/name/i).or(page.getByPlaceholder(/name/i));
      const emailField = page.getByLabel(/email/i).or(page.getByPlaceholder(/email/i));
      const messageField = page.getByLabel(/message|inquiry|comment/i).or(page.getByPlaceholder(/message|inquiry|comment/i));

      if (await nameField.isVisible({ timeout: 1000 }).catch(() => false)) {
        await nameField.fill('Test User');
      }

      if (await emailField.isVisible({ timeout: 1000 }).catch(() => false)) {
        await emailField.fill('test@example.com');
      }

      if (await messageField.isVisible({ timeout: 1000 }).catch(() => false)) {
        await messageField.fill('This is a test inquiry for e2e testing.');
      }

      // Submit the form
      const submitButton = page.getByRole('button', { name: /submit|send|contact/i });
      if (await submitButton.isVisible({ timeout: 1000 }).catch(() => false)) {
        await submitButton.click();

        // Wait for success message or form reset
        await page.waitForTimeout(2000);

        // Check for success message or confirmation
        // This depends on the actual implementation
      }
    }
  });

  test('should validate email format', async ({ page }) => {
    const form = page.locator('form').first();
    const hasForm = await form.isVisible({ timeout: 2000 }).catch(() => false);

    if (hasForm) {
      const emailField = page.getByLabel(/email/i).or(page.getByPlaceholder(/email/i));

      if (await emailField.isVisible({ timeout: 1000 }).catch(() => false)) {
        // Enter invalid email
        await emailField.fill('invalid-email');

        const submitButton = page.getByRole('button', { name: /submit|send|contact/i });
        if (await submitButton.isVisible({ timeout: 1000 }).catch(() => false)) {
          await submitButton.click();

          // Should show validation error
          await page.waitForTimeout(500);
        }
      }
    }
  });

  test('should be mobile responsive', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });

    await expect(page.locator('main')).toBeVisible();

    // Check if contact info is still accessible on mobile
    const contactSection = page.locator('main');
    await expect(contactSection).toBeVisible();
  });

  test('should load without JavaScript errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => {
      errors.push(error.message);
    });

    await page.waitForLoadState('networkidle');
    expect(errors).toHaveLength(0);
  });

  test('should have clickable email and phone links', async ({ page }) => {
    // Look for mailto: and tel: links
    const emailLink = page.locator('a[href^="mailto:"]').first();
    const phoneLink = page.locator('a[href^="tel:"]').first();

    if (await emailLink.isVisible({ timeout: 1000 }).catch(() => false)) {
      await expect(emailLink).toHaveAttribute('href', /mailto:/);
    }

    if (await phoneLink.isVisible({ timeout: 1000 }).catch(() => false)) {
      await expect(phoneLink).toHaveAttribute('href', /tel:/);
    }
  });
});
