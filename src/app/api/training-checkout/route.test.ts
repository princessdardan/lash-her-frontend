import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { createTrainingCheckoutPostHandler } from "./src/app/api/training-checkout/handler.ts";

  const program = {
    _id: "training-program-classic-lash",
    slug: "classic-lash-training",
    title: "Classic Lash Training",
    checkoutEnabled: true,
    price: 1499,
    currency: "CAD",
    isAvailable: true,
  };

  function createRequest(body) {
    return new Request("http://localhost:3000/api/training-checkout", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  function validBody(overrides = {}) {
    return {
      programSlug: "classic-lash-training",
      programId: "training-program-classic-lash",
      customerName: "  Nataliea Lash  ",
      customerEmail: "CLIENT@EXAMPLE.COM ",
      clientPrice: 1499,
      payment: { sourceId: "cnon:card-nonce" },
      ...overrides,
    };
  }

  function runScenario({
    getTrainingProgramBySlug,
    reserveSquareTrainingOrder,
    chargeSquareTrainingOrder,
    createTrainingEnrollment,
    squareCommerceEnabled = true,
  } = {}) {
    const fetchedSlugs = [];
    const enrollments = [];
    const reserved = [];
    const charges = [];
    const handler = createTrainingCheckoutPostHandler({
      getTrainingProgramBySlug: async (slug) => {
        fetchedSlugs.push(slug);
        if (getTrainingProgramBySlug) return getTrainingProgramBySlug(slug);
        return program;
      },
      getPromotionCode: async () => null,
      createTrainingEnrollment: async (input) => {
        enrollments.push(input);
        if (createTrainingEnrollment) return createTrainingEnrollment(input);
        return { _id: "training-enrollment-5252" };
      },
      squareCommerceEnabled,
      reserveSquareTrainingOrder: async (input) => {
        reserved.push(input);
        if (reserveSquareTrainingOrder) return reserveSquareTrainingOrder(input);
        return { orderId: "lh-train-1", databaseId: "db-train-1" };
      },
      chargeSquareTrainingOrder: async (input) => {
        charges.push(input);
        if (chargeSquareTrainingOrder) return chargeSquareTrainingOrder(input);
        return { ok: true, squarePaymentId: "sq-train-1", transition: "applied" };
      },
      markTrainingOrderVerificationFailed: async () => {},
    });

    return { enrollments, fetchedSlugs, handler, reserved, charges };
  }
`;

test("training checkout route rejects invalid requests before downstream calls", () => {
  runRouteScenario(`
    const { enrollments, fetchedSlugs, handler, reserved, charges } = runScenario();

    const response = await handler(createRequest({
      programSlug: " ",
      customerName: "Nataliea Lash",
      customerEmail: "client@example.com",
    }));
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(body, { error: "Invalid training checkout request" });
    assert.equal(fetchedSlugs.length, 0);
    assert.equal(reserved.length, 0);
    assert.equal(charges.length, 0);
    assert.equal(enrollments.length, 0);
  `);
});

test("training checkout route rejects missing programs before payment setup", () => {
  runRouteScenario(`
    const { enrollments, fetchedSlugs, handler, reserved, charges } = runScenario({
      getTrainingProgramBySlug: async () => null,
    });

    const response = await handler(createRequest(validBody()));
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(body, { error: "Invalid training checkout request" });
    assert.deepEqual(fetchedSlugs, ["classic-lash-training"]);
    assert.equal(reserved.length, 0);
    assert.equal(charges.length, 0);
    assert.equal(enrollments.length, 0);
  `);
});

test("training checkout route reserves, enrolls, and charges via Square", () => {
  runRouteScenario(`
    const { enrollments, handler, reserved, charges } = runScenario();

    const response = await handler(createRequest(validBody()));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, { orderId: "lh-train-1", status: "paid" });
    assert.equal(reserved.length, 1);
    assert.equal(reserved[0].customerName, "Nataliea Lash");
    assert.equal(reserved[0].customerEmail, "client@example.com");
    assert.equal(reserved[0].amountCents, 169387);
    assert.equal(reserved[0].programSlug, "classic-lash-training");
    assert.equal(enrollments.length, 1);
    assert.equal(enrollments[0].checkoutOrderId, "db-train-1");
    assert.equal(charges.length, 1);
    assert.equal(charges[0].orderReference, "lh-train-1");
    assert.equal(charges[0].amountCents, 169387);
    assert.equal(charges[0].sourceId, "cnon:card-nonce");
  `);
});

test("training checkout route returns 402 when the Square charge is declined", () => {
  runRouteScenario(`
    const { handler, charges } = runScenario({
      chargeSquareTrainingOrder: async () => ({ ok: false, reason: "payment_declined" }),
    });

    const response = await handler(createRequest(validBody()));
    const body = await response.json();

    assert.equal(response.status, 402);
    assert.deepEqual(body, { error: "Payment could not be completed" });
    assert.equal(charges.length, 1);
  `);
});

test("training checkout route rejects a request that carries no card nonce", () => {
  runRouteScenario(`
    const { handler, reserved, charges } = runScenario();

    const response = await handler(createRequest(validBody({ payment: undefined })));
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(body, { error: "Invalid training checkout request" });
    assert.equal(reserved.length, 0);
    assert.equal(charges.length, 0);
  `);
});

test("training checkout route is unavailable when Square commerce is disabled", () => {
  runRouteScenario(`
    const { handler, reserved } = runScenario({ squareCommerceEnabled: false });

    const response = await handler(createRequest(validBody()));
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.deepEqual(body, { error: "Training checkout is temporarily unavailable" });
    assert.equal(reserved.length, 0);
  `);
});

test("training checkout route returns a generic failure when enrollment write fails", () => {
  runRouteScenario(`
    const { handler, reserved, enrollments } = runScenario({
      createTrainingEnrollment: async () => {
        throw new Error("Private DB unavailable");
      },
    });

    const response = await handler(createRequest(validBody()));
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(body, { error: "Unable to start training checkout" });
    assert.equal(reserved.length, 1);
    assert.equal(enrollments.length, 1);
  `);
});

test("training checkout route charges the primary training path through Square", () => {
  const routeSource = readFileSync(
    "src/app/api/training-checkout/handler.ts",
    "utf8",
  );

  assert.ok(
    routeSource.includes("createLiveSquareTrainingCharger"),
    "training route should wire the Square training charger",
  );
  assert.ok(
    routeSource.includes("isSquareCommerceCheckoutEnabled"),
    "training route should gate the Square charge on the commerce flag",
  );
  assert.ok(
    !routeSource.includes("helcim") && !routeSource.includes("Helcim"),
    "training route should no longer reference Helcim",
  );
});

function runRouteScenario(assertions: string): void {
  const scenario = `${helperScript}\nvoid (async () => {\n${assertions}\n})()`;
  const env = { ...process.env };

  env.NEXT_PUBLIC_SANITY_DATASET = "test";
  env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";

  execFileSync("./node_modules/.bin/tsx", ["--eval", scenario], {
    cwd: process.cwd(),
    env,
    stdio: "pipe",
  });
}
