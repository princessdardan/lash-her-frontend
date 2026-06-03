import { expect, test } from "@playwright/test";

const storageKey = "lh_cookie_consent";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate((key) => window.localStorage.removeItem(key), storageKey);
  await page.reload();
});

test("cookie banner appears when no consent is stored", async ({ page }) => {
  await expect(page.getByRole("region", { name: "Cookie consent" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept analytics" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reject analytics" })).toBeVisible();
});

test("reject analytics hides banner and persists rejection", async ({ page }) => {
  await page.getByRole("button", { name: "Reject analytics" }).click();
  await expect(page.getByRole("region", { name: "Cookie consent" })).toBeHidden();

  const stored = await page.evaluate((key) => window.localStorage.getItem(key), storageKey);
  expect(JSON.parse(stored || "{}")).toMatchObject({ required: true, analytics: false, version: 1 });

  await page.reload();
  await expect(page.getByRole("region", { name: "Cookie consent" })).toBeHidden();
});

test("accept analytics hides banner and persists analytics consent", async ({ page }) => {
  await page.getByRole("button", { name: "Accept analytics" }).click();
  await expect(page.getByRole("region", { name: "Cookie consent" })).toBeHidden();

  const stored = await page.evaluate((key) => window.localStorage.getItem(key), storageKey);
  expect(JSON.parse(stored || "{}")).toMatchObject({ required: true, analytics: true, version: 1 });
});

test("manage choices reveals category explanations", async ({ page }) => {
  await page.getByRole("button", { name: "Manage choices" }).click();
  await expect(page.getByText("Required", { exact: true })).toBeVisible();
  await expect(page.getByText("Analytics", { exact: true })).toBeVisible();
  await expect(page.getByText("Always on. Supports functional site behavior")).toBeVisible();
  await expect(
    page.getByText("Optional. Helps measure visits and improve the website. Analytics is off unless you accept it."),
  ).toBeVisible();
});
