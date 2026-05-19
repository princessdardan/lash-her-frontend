import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { getVerifiedTrainingConfirmation } from "./src/lib/training-confirmation.ts";

  const enrollment = {
    checkoutEmail: "client@example.com",
    checkoutOrder: {
      orderId: "lh-training-123",
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
    tokenExpiresAt: null,
  };
`;

test("training confirmation verifies the order id against the private paid enrollment", () => {
  runTrainingConfirmationScenario(`
    const found = await getVerifiedTrainingConfirmation({
      findEnrollmentByPublicOrderId: async (orderId) => {
        assert.equal(orderId, "lh-training-123");
        return enrollment;
      },
      orderId: "lh-training-123",
      programSlug: "lash-training",
    });

    assert.deepEqual(found, {
      orderId: "lh-training-123",
    });
  `);
});

test("training confirmation rejects mismatched order, slug, or missing order", () => {
  runTrainingConfirmationScenario(`
    assert.equal(await getVerifiedTrainingConfirmation({
      findEnrollmentByPublicOrderId: async () => enrollment,
      orderId: "lh-other-order",
      programSlug: "lash-training",
    }), null);

    assert.equal(await getVerifiedTrainingConfirmation({
      findEnrollmentByPublicOrderId: async () => enrollment,
      orderId: "lh-training-123",
      programSlug: "other-training",
    }), null);

    assert.equal(await getVerifiedTrainingConfirmation({
      findEnrollmentByPublicOrderId: async () => enrollment,
      orderId: "",
      programSlug: "lash-training",
    }), null);
  `);
});

function runTrainingConfirmationScenario(assertions: string): void {
  const scenario = `${helperScript}
void (async () => {
${assertions}
})()`;
  const env = { ...process.env };

  env.NEXT_PUBLIC_SANITY_DATASET = "test";
  env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";
  env.CHECKOUT_SECRET_ENCRYPTION_KEY = "00000000000000000000000000000000";

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
