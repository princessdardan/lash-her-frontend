import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { retryTransactionalEmail } from "./src/lib/transactional-email-retry.ts";

  const enrollment = {
    checkoutEmail: "student@example.com",
    checkoutOrder: {
      customerEmail: "student@example.com",
      customerName: "Student Name",
      orderId: "lh-training-123",
      paymentProvider: "square",
    },
    enrollmentId: "training-enrollment-1",
    productSnapshot: {
      currency: "CAD",
      id: "product-training-full",
      priceCents: 149900,
      sku: "TRAINING-FULL",
      title: "Lash Training Full Payment",
    },
    programSnapshot: {
      id: "program-lash-training",
      slug: "lash-training",
      title: "Lash Training Program",
    },
    staffAlertedAt: null,
    studentPaymentEmailSentAt: null,
    tokenExpiresAt: null,
  };

  function createDependencies(overrides = {}) {
    const calls = {
      booking: [],
      product: [],
      training: [],
      trainingLookups: [],
      tokenLookups: [],
    };

    return {
      calls,
      dependencies: {
        getOrIssueTrainingSchedulingTokenForPaidOrder: async (orderId) => {
          calls.tokenLookups.push(orderId);
          return {
            ...enrollment,
            schedulingToken: "schedule-token-123",
          };
        },
        getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId: async (orderId) => {
          calls.trainingLookups.push(orderId);
          return enrollment;
        },
        sendBookingConfirmationEmailForOrder: async (orderId) => {
          calls.booking.push(orderId);
        },
        sendProductOrderConfirmationEmailForOrder: async (orderId) => {
          calls.product.push(orderId);
        },
        sendTrainingPaymentNotificationEmailsIfNeeded: async (input) => {
          calls.training.push(input);
        },
        ...overrides,
      },
    };
  }
`;

test("transactional email retry sends product confirmations by order id", () => {
  runRetryScenario(`
    const { calls, dependencies } = createDependencies();

    const result = await retryTransactionalEmail({ flow: "product", orderId: "  lh-product-123  ", origin: "https://example.com" }, dependencies);

    assert.deepEqual(result, { flow: "product", orderId: "lh-product-123", status: "processed" });
    assert.deepEqual(calls.product, ["lh-product-123"]);
    assert.deepEqual(calls.booking, []);
    assert.deepEqual(calls.training, []);
  `);
});

test("transactional email retry propagates product send failures", () => {
  runRetryScenario(`
    const { dependencies } = createDependencies({
      sendProductOrderConfirmationEmailForOrder: async () => {
        throw new Error("Resend unavailable");
      },
    });

    await assert.rejects(
      () => retryTransactionalEmail({ flow: "product", orderId: "lh-product-123", origin: "https://example.com" }, dependencies),
      /Resend unavailable/,
    );
  `);
});

test("transactional email retry sends booking confirmations by order id", () => {
  runRetryScenario(`
    const { calls, dependencies } = createDependencies();

    const result = await retryTransactionalEmail({ flow: "booking", orderId: "lh-booking-123", origin: "https://example.com" }, dependencies);

    assert.deepEqual(result, { flow: "booking", orderId: "lh-booking-123", status: "processed" });
    assert.deepEqual(calls.booking, ["lh-booking-123"]);
    assert.deepEqual(calls.product, []);
    assert.deepEqual(calls.training, []);
  `);
});

test("transactional email retry sends training notifications with absolute scheduling URL", () => {
  runRetryScenario(`
    const { calls, dependencies } = createDependencies();

    const result = await retryTransactionalEmail({ flow: "training", orderId: "lh-training-123", origin: "https://lash.test" }, dependencies);

    assert.deepEqual(result, { flow: "training", orderId: "lh-training-123", status: "processed" });
    assert.deepEqual(calls.trainingLookups, ["lh-training-123"]);
    assert.deepEqual(calls.tokenLookups, ["lh-training-123"]);
    assert.equal(calls.training.length, 1);
    assert.equal(calls.training[0].paymentProvider, "square");
    assert.equal(calls.training[0].schedulingUrl, "https://lash.test/training-programs/lash-training/schedule?token=schedule-token-123");
  `);
});

test("transactional email retry skips training retries without pending enrollment", () => {
  runRetryScenario(`
    const { calls, dependencies } = createDependencies({
      getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId: async () => null,
    });

    const result = await retryTransactionalEmail({ flow: "training", orderId: "lh-training-123", origin: "https://lash.test" }, dependencies);

    assert.deepEqual(result, {
      flow: "training",
      orderId: "lh-training-123",
      status: "skipped",
    });
    assert.deepEqual(calls.tokenLookups, []);
    assert.deepEqual(calls.training, []);
  `);
});

function runRetryScenario(assertions: string): void {
  const scenario = `${helperScript}\nvoid (async () => {\n${assertions}\n})()`;
  const env = { ...process.env };

  env.NEXT_PUBLIC_SANITY_DATASET = "test";
  env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";

  execFileSync(
    "./node_modules/.bin/tsx",
    ["--conditions=react-server", "--eval", scenario],
    {
      cwd: process.cwd(),
      env,
      stdio: "pipe",
    },
  );
}
