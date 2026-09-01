import assert from "node:assert/strict";
import test from "node:test";

test("customer email cron authenticates and returns non-2xx when claimed work fails", async () => {
  const previousSecret = process.env.CRON_SECRET;
  const previousDataset = process.env.NEXT_PUBLIC_SANITY_DATASET;
  const previousProjectId = process.env.NEXT_PUBLIC_SANITY_PROJECT_ID;
  process.env.CRON_SECRET = "customer-email-cron-test-secret";
  process.env.NEXT_PUBLIC_SANITY_DATASET = "test";
  process.env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";
  try {
    const { createCustomerEmailOutboxCronHandler } =
      await import("@/lib/commerce/customer-email-outbox-cron");
    let processed = 0;
    const handler = createCustomerEmailOutboxCronHandler(async () => {
      processed += 1;
      return {
        claimed: 1,
        enqueued: 0,
        failed: 1,
        sent: 0,
        suppressed: 0,
      };
    });
    const missing = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    assert.equal(
      (
        await handler(
          new Request("https://lashher.test/api/cron/customer-email-outbox"),
        )
      ).status,
      404,
    );
    process.env.CRON_SECRET = missing;
    assert.equal(
      (
        await handler(
          new Request("https://lashher.test/api/cron/customer-email-outbox", {
            headers: { authorization: "Bearer wrong-secret" },
          }),
        )
      ).status,
      401,
    );
    assert.equal(processed, 0);
    const response = await handler(
      new Request("https://lashher.test/api/cron/customer-email-outbox", {
        headers: {
          authorization: "Bearer customer-email-cron-test-secret",
        },
      }),
    );
    assert.equal(response.status, 503);
    assert.equal(processed, 1);
  } finally {
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
    if (previousDataset === undefined)
      delete process.env.NEXT_PUBLIC_SANITY_DATASET;
    else process.env.NEXT_PUBLIC_SANITY_DATASET = previousDataset;
    if (previousProjectId === undefined)
      delete process.env.NEXT_PUBLIC_SANITY_PROJECT_ID;
    else process.env.NEXT_PUBLIC_SANITY_PROJECT_ID = previousProjectId;
  }
});
