import { Page } from '@playwright/test';
import menuData from '../fixtures/menu-data.json';
import globalData from '../fixtures/global-data.json';
import trainingPageData from '../fixtures/training-page-data.json';

/**
 * Setup API mocking for Strapi endpoints
 * This ensures tests can run without requiring a live Strapi backend
 */
export async function setupApiMocks(page: Page) {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:1337';

  // Mock main menu data
  await page.route(`${apiUrl}/api/main-menu*`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(menuData),
    });
  });

  // Mock global data (header, footer)
  await page.route(`${apiUrl}/api/global*`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(globalData),
    });
  });

  // Mock training page data
  await page.route(`${apiUrl}/api/training*`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(trainingPageData),
    });
  });

  // Mock home page data
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

  // Mock contact page data
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

  // Mock gallery data
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
 * Setup API mocks with custom menu data
 * Useful for testing specific menu configurations
 */
export async function setupApiMocksWithCustomMenu(page: Page, customMenuData: any) {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:1337';

  await page.route(`${apiUrl}/api/main-menu*`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(customMenuData),
    });
  });

  // Setup other mocks
  await setupApiMocks(page);
}
