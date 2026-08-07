import { execFileSync } from "node:child_process";
import test from "node:test";

const helper = String.raw`
  import assert from "node:assert/strict";
  import { createCourseCheckoutRepository } from "./src/lib/course-commerce/course-checkout-repository.ts";

  const input = {
    checkoutToken: "raw-checkout-token",
    course: {
      id: "123e4567-e89b-42d3-a456-426614174000",
      slug: "classic-lash-foundations",
      title: "Classic Lash Foundations",
      priceCents: 49900,
      currency: "CAD",
    },
    customerEmail: "student@example.com",
    customerName: "Student Name",
    customerUserId: "123e4567-e89b-42d3-a456-426614174001",
    helcimInvoiceId: 42,
    helcimInvoiceNumber: "INV-42",
    secretToken: "raw-secret-token",
  };

  function createScenario(orderRow = { id: "internal-order-id" }) {
    const calls = { transactionCount: 0, orders: [], items: [] };
    const repository = createCourseCheckoutRepository({
      async run(operation) {
        calls.transactionCount += 1;
        return operation({
          async insertCheckoutOrder(values) {
            calls.orders.push(values);
            return orderRow;
          },
          async insertCourseOrderItem(values) {
            calls.items.push(values);
          },
        });
      },
    }, {
      createOrderId: () => "lh-public-order-42",
      encryptSecret: (secret) => "encrypted:" + secret.length,
      hashCheckoutToken: (token) => "hashed:" + token.length,
    });
    return { calls, repository };
  }
`;

test("course checkout repository atomically inserts one order and one claimed course item", () => {
  runScenario(String.raw`
    const { calls, repository } = createScenario();
    const result = await repository.persistPendingCheckout(input);

    assert.deepEqual(result, { orderId: "lh-public-order-42" });
    assert.equal(calls.transactionCount, 1);
    assert.equal(calls.orders.length, 1);
    assert.equal(calls.items.length, 1);
    assert.deepEqual(calls.orders[0], {
      amountCents: 49900,
      checkoutTokenHash: "hashed:18",
      currency: "CAD",
      customerEmail: "student@example.com",
      customerName: "Student Name",
      customerUserId: input.customerUserId,
      helcimInvoiceId: 42,
      helcimInvoiceNumber: "INV-42",
      lineItems: [{
        description: "Classic Lash Foundations",
        productId: input.course.id,
        quantity: 1,
        sku: input.course.slug,
        totalCents: 49900,
        unitPriceCents: 49900,
      }],
      orderId: "lh-public-order-42",
      paymentProvider: "helcim",
      purpose: "course",
      secretTokenCiphertext: "encrypted:16",
      status: "pending",
    });
    assert.deepEqual(calls.items[0], {
      checkoutOrderId: "internal-order-id",
      courseId: input.course.id,
      courseSlug: input.course.slug,
      courseTitle: input.course.title,
      currency: "CAD",
      customerUserId: input.customerUserId,
      financialStatus: "pending",
      ownershipStatus: "claimed",
      priceCents: 49900,
    });
    assert.equal(JSON.stringify(calls).includes("raw-checkout-token"), false);
    assert.equal(JSON.stringify(calls).includes("raw-secret-token"), false);
  `);
});

test("course checkout repository persists guest ownership without a customer id", () => {
  runScenario(String.raw`
    const { calls, repository } = createScenario();
    await repository.persistPendingCheckout({ ...input, customerUserId: null });
    assert.equal(calls.orders[0].customerUserId, null);
    assert.equal(calls.items[0].customerUserId, null);
    assert.equal(calls.items[0].ownershipStatus, "guest_unclaimed");
  `);
});

test("course checkout repository does not insert an item without an order id", () => {
  runScenario(String.raw`
    const { calls, repository } = createScenario(null);
    await assert.rejects(
      repository.persistPendingCheckout(input),
      /Course checkout order insert did not return an id/,
    );
    assert.equal(calls.transactionCount, 1);
    assert.equal(calls.orders.length, 1);
    assert.equal(calls.items.length, 0);
  `);
});

function runScenario(assertions: string): void {
  const scenario = `${helper}\nvoid (async () => {\n${assertions}\n})()`;
  const env = {
    ...process.env,
    NEXT_PUBLIC_SANITY_DATASET: "test",
    NEXT_PUBLIC_SANITY_PROJECT_ID: "test-project",
  };
  execFileSync(
    "./node_modules/.bin/tsx",
    ["--conditions=react-server", "--eval", scenario],
    { cwd: process.cwd(), env, stdio: "pipe" },
  );
}
