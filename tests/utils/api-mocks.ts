import { Page } from '@playwright/test';
import menuData from '../fixtures/menu-data.json';
import globalData from '../fixtures/global-data.json';
import trainingPageData from '../fixtures/training-page-data.json';

/**
 * Set up legacy client-side CMS endpoint fixtures for mocked UX tests.
 *
 * The current app reads Sanity data server-side through `src/data/loaders.ts`.
 * These route mocks are retained only for older Playwright specs that exercise
 * navigation/responsive UI behavior without depending on a historical API server.
 */
export async function setupApiMocks(page: Page) {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:1337';

  // Legacy main menu fixture
  await page.route(`${apiUrl}/api/main-menu*`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(menuData),
    });
  });

  // Legacy global settings fixture (header, footer)
  await page.route(`${apiUrl}/api/global*`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(globalData),
    });
  });

  // Legacy training page fixture
  await page.route(`${apiUrl}/api/training*`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(trainingPageData),
    });
  });

  // Legacy home page fixture
  await page.route(`${apiUrl}/api/home-page*`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          id: 1,
          documentId: 'home-1',
          title: 'Welcome to Lash Her',
          blocks: []
        },
        meta: {}
      }),
    });
  });

  // Legacy contact page fixture
  await page.route(`${apiUrl}/api/contact*`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          id: 1,
          documentId: 'contact-1',
          blocks: []
        },
        meta: {}
      }),
    });
  });

  // Legacy gallery fixture
  await page.route(`${apiUrl}/api/gallery*`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [],
        meta: {}
      }),
    });
  });
}

/**
 * Set up legacy endpoint fixtures with custom menu data.
 * Useful for testing specific mocked menu configurations.
 */
export async function setupApiMocksWithCustomMenu(page: Page, customMenuData: typeof menuData) {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:1337';

  await page.route(`${apiUrl}/api/main-menu*`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(customMenuData),
    });
  });

  // Install the remaining legacy endpoint fixtures.
  await setupApiMocks(page);
}
