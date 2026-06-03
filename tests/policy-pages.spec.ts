import { expect, test } from "@playwright/test";

test("unknown policy page renders the not found experience", async ({ page }) => {
  const response = await page.goto("/policies/this-policy-does-not-exist");

  expect([200, 404]).toContain(response?.status());
  await expect(page.getByRole("heading", { name: "404" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Page Not Found" })).toBeVisible();
});
