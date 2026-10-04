import { expect, test } from "@playwright/test";

test("existing-session Square configuration is retained without exposing secrets", async ({
  request,
}) => {
  const response = await request.get("/api/booking/square/config");
  // The endpoint remains governed by its existing provider configuration.
  expect([200, 404, 503]).toContain(response.status());
  expect(response.status()).not.toBe(410);
  const body = await response.json();
  expect(JSON.stringify(body)).not.toMatch(
    /accessToken|webhookSignatureKey|secret/i,
  );
  if (response.ok()) {
    expect(Object.keys(body).sort()).toEqual([
      "applicationId",
      "environment",
      "locale",
      "locationId",
      "scriptUrl",
    ]);
  }
});
