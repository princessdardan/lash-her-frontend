import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { createCheckoutPostHandler } from "./src/app/api/checkout/handler.ts";
  import {
    CHECKOUT_CUSTOMER_NAME_MAX_LENGTH,
    CHECKOUT_EMAIL_MAX_LENGTH,
    CHECKOUT_SHIPPING_LINE_MAX_LENGTH,
    CHECKOUT_SHIPPING_LOCALITY_MAX_LENGTH,
  } from "./src/lib/commerce/checkout-validation.ts";

  const product = {
    _id: "product-lash-cleanser",
    title: "Lash Cleanser",
    price: 24,
    currency: "CAD",
    isAvailable: true,
    shipping: {
      fulfillmentMode: "physical",
      weightGrams: 35,
      lengthCm: 12,
      widthCm: 8,
      heightCm: 3,
      isRigid: true,
      customsDescription: "Synthetic eyelash cleanser brush",
      countryOfOrigin: "CA",
    },
  };

  const shippingAddress = {
    line1: "646 Oakwood Avenue",
    city: "Toronto",
    province: "Ontario",
    postalCode: "M6E 2Y4",
    country: "Canada",
  };

  const TERMS_REQUIREMENT = {
    version: "terms-test-v1",
    text: "Test terms of sale",
    textHash: "a".repeat(64),
  };
  const TERMS_DISCLOSURE = {
    termsAccepted: true,
    termsVersion: TERMS_REQUIREMENT.version,
    termsTextHash: TERMS_REQUIREMENT.textHash,
  };
  const SHIPPED_REFUND_REQUIREMENT = {
    version: "shipped-refund-test-v1",
    text: "Test shipped-order refund policy",
    textHash: "c".repeat(64),
  };
  const SHIPPED_REFUND_DISCLOSURE = {
    cancellationPolicyAccepted: true,
    cancellationPolicyVersion: SHIPPED_REFUND_REQUIREMENT.version,
    cancellationPolicyTextHash: SHIPPED_REFUND_REQUIREMENT.textHash,
  };

  function createRequest(body) {
    if (typeof body === "string") {
      return new Request("http://localhost:3000/api/checkout", {
        method: "POST",
        body,
      });
    }
    const { disclosures, ...rest } = body ?? {};
    const effectiveMode = rest.fulfillmentMode ?? "automated_shipping";
    const baseDisclosure =
      effectiveMode === "automated_shipping"
        ? { ...TERMS_DISCLOSURE, ...SHIPPED_REFUND_DISCLOSURE }
        : TERMS_DISCLOSURE;
    return new Request("http://localhost:3000/api/checkout", {
      method: "POST",
      body: JSON.stringify({
        fulfillmentMode: "automated_shipping",
        shippingQuote: {
          token: "shipping-quote-token",
          fingerprint: "a".repeat(64),
          rateId: "rate-1",
        },
        payment: { sourceId: "cnon:card-nonce" },
        ...rest,
        disclosures: { ...baseDisclosure, ...(disclosures ?? {}) },
      }),
    });
  }

  function runScenario({
    createInitializingOrder,
    getProductsByIds,
    getPromotionCode,
    createInitializingManualOrder,
    loadManualCheckoutPolicy,
    loadTermsRequirement,
    loadShippedRefundPolicyRequirement,
    markInitializationFailed,
    validateShippingSelection,
  } = {}) {
    const fetchedProductIds = [];
    const initializationFailures = [];
    const invoices = [];
    const orders = [];
    const paySessions = [];
    const handler = createCheckoutPostHandler({
      getProductsByIds: async (ids) => {
        fetchedProductIds.push(ids);
        if (getProductsByIds) {
          return getProductsByIds(ids);
        }
        return [product];
      },
      getPromotionCode: async (code) => {
        if (getPromotionCode) {
          return getPromotionCode(code);
        }
        return null;
      },
      shippingEnabled: true,
      validateShippingSelection: validateShippingSelection ?? (async () => ({
        fingerprint: "a".repeat(64),
      })),
      createInitializingOrder: async (input) => {
        orders.push(input);
        if (createInitializingOrder) {
          return createInitializingOrder(input);
        }
        return {
          orderId: "lh-product-order",
          primaryObligationId: "22222222-2222-4222-8222-222222222222",
          currency: "CAD",
          shippingAmountCents: 1299,
          totalAmountCents: Math.round(input.cart.amount * 100) + 1299,
          shippingRateTitle: "Tracked shipping",
        };
      },
      finalizeInitializingOrder: async () => undefined,
      markInitializationFailed: async (orderId, error) => {
        initializationFailures.push({ orderId, error });
        if (markInitializationFailed) {
          await markInitializationFailed(orderId, error);
        }
      },
      markOrderVerificationFailed: async () => {},
      squareCommerceEnabled: true,
      chargeSquareProductOrder: async () => ({
        ok: true,
        squarePaymentId: "sq-checkout-1",
        transition: "applied",
      }),
      ...(createInitializingManualOrder ? { createInitializingManualOrder } : {}),
      ...(loadManualCheckoutPolicy ? { loadManualCheckoutPolicy } : {}),
      loadTermsRequirement: loadTermsRequirement ?? (() => TERMS_REQUIREMENT),
      loadShippedRefundPolicyRequirement:
        loadShippedRefundPolicyRequirement ??
        (() => SHIPPED_REFUND_REQUIREMENT),
    });

    return {
      fetchedProductIds,
      handler,
      initializationFailures,
      invoices,
      orders,
      paySessions,
    };
  }
`;

test("manual checkout requires exact explicit cancellation-policy acceptance and starts with pickup", () => {
  runRouteScenario(`
    const manualProduct = {
      ...product,
      shipping: { fulfillmentMode: "manual" },
    };
    let manualCreates = 0;
    const { handler } = runScenario({
      getProductsByIds: async () => [manualProduct],
      createInitializingManualOrder: async () => {
        manualCreates += 1;
        throw new Error("should not reserve an unaccepted manual order");
      },
      loadManualCheckoutPolicy: async () => ({
        enabled: true,
        cancellationPolicyText: "Approved cancellation policy",
        cancellationPolicyVersion: "manual-policy-v1",
        cancellationPolicyTextHash: "a".repeat(64),
        blockers: [],
      }),
    });
    const base = {
      customer: { name: "Nataliea Lash", email: "client@example.com" },
      items: [{ productId: product._id, quantity: 1 }],
      fulfillmentMode: "manual_pickup",
      shippingQuote: undefined,
    };

    const missingAcceptance = await handler(createRequest({
      ...base,
      disclosures: { cancellationPolicyVersion: "manual-policy-v1" },
    }));
    assert.equal(missingAcceptance.status, 503);

    const wrongHash = await handler(createRequest({
      ...base,
      disclosures: {
        cancellationPolicyAccepted: true,
        cancellationPolicyVersion: "manual-policy-v1",
        cancellationPolicyTextHash: "b".repeat(64),
      },
    }));
    assert.equal(wrongHash.status, 503);

    const directManualShipping = await handler(createRequest({
      ...base,
      fulfillmentMode: "manual_shipping",
      disclosures: {
        cancellationPolicyAccepted: true,
        cancellationPolicyVersion: "manual-policy-v1",
        cancellationPolicyTextHash: "a".repeat(64),
      },
    }));
    assert.equal(directManualShipping.status, 409);
    assert.equal(manualCreates, 0);

    let reservedInput;
    const acceptedHandler = runScenario({
      getProductsByIds: async () => [manualProduct],
      createInitializingManualOrder: async (input) => {
        reservedInput = input;
        return {
          orderId: "lh-manual-order",
          primaryObligationId: "11111111-1111-4111-8111-111111111111",
          currency: "CAD",
          shippingAmountCents: 0,
          totalAmountCents: 2400,
          shippingRateTitle: "Studio pickup",
        };
      },
      loadManualCheckoutPolicy: async () => ({
        enabled: true,
        cancellationPolicyText: "Approved cancellation policy",
        cancellationPolicyVersion: "manual-policy-v1",
        cancellationPolicyTextHash: "a".repeat(64),
        blockers: [],
      }),
    }).handler;
    const accepted = await acceptedHandler(createRequest({
      ...base,
      disclosures: {
        cancellationPolicyAccepted: true,
        cancellationPolicyVersion: "manual-policy-v1",
        cancellationPolicyTextHash: "a".repeat(64),
      },
    }));
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), {
      orderId: "lh-manual-order",
      status: "paid",
    });
    assert.equal(reservedInput.fulfillmentMode, "manual_pickup");
    assert.equal(reservedInput.cancellationPolicy.accepted, true);
    assert.equal(reservedInput.cancellationPolicy.version, "manual-policy-v1");
    assert.equal(reservedInput.cancellationPolicy.textHash, "a".repeat(64));
    assert.ok(reservedInput.cancellationPolicy.presentedAt instanceof Date);
    assert.match(
      reservedInput.cancellationPolicy.requestEvidence,
      /^checkout_post:[0-9a-f-]{36}$/i,
    );
    assert.equal(reservedInput.termsAssent.accepted, true);
    assert.equal(reservedInput.termsAssent.version, "terms-test-v1");
    assert.equal(reservedInput.termsAssent.textHash, "a".repeat(64));
    assert.ok(reservedInput.termsAssent.presentedAt instanceof Date);
    assert.equal(
      reservedInput.termsAssent.requestEvidence,
      reservedInput.cancellationPolicy.requestEvidence,
    );
  `);
});

test("automated cart can check out as free studio pickup", () => {
  runRouteScenario(`
    // The default product is an automated (shippable) product; the customer
    // chooses studio pickup. It must route to the manual/pickup reservation
    // (no shipping quote or address), not be rejected as an invalid mode.
    let reservedInput;
    let shippingReserves = 0;
    const scenario = runScenario({
      createInitializingOrder: async () => {
        shippingReserves += 1;
        throw new Error("automated pickup must not reserve a shipping order");
      },
      createInitializingManualOrder: async (input) => {
        reservedInput = input;
        return {
          orderId: "lh-pickup-order",
          primaryObligationId: "33333333-3333-4333-8333-333333333333",
          currency: "CAD",
          shippingAmountCents: 0,
          totalAmountCents: 2712,
          shippingRateTitle: "Studio pickup",
        };
      },
      loadManualCheckoutPolicy: async () => ({
        enabled: true,
        cancellationPolicyText: "Approved cancellation policy",
        cancellationPolicyVersion: "manual-policy-v1",
        cancellationPolicyTextHash: "a".repeat(64),
        blockers: [],
      }),
    });
    const response = await scenario.handler(createRequest({
      customer: { name: "Nataliea Lash", email: "client@example.com" },
      items: [{ productId: product._id, quantity: 1 }],
      fulfillmentMode: "manual_pickup",
      shippingQuote: undefined,
      disclosures: {
        cancellationPolicyAccepted: true,
        cancellationPolicyVersion: "manual-policy-v1",
        cancellationPolicyTextHash: "a".repeat(64),
      },
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      orderId: "lh-pickup-order",
      status: "paid",
    });
    assert.equal(shippingReserves, 0);
    assert.equal(scenario.orders.length, 0);
    assert.equal(reservedInput.fulfillmentMode, "manual_pickup");
    assert.equal(reservedInput.cancellationPolicy.accepted, true);
    assert.equal(reservedInput.termsAssent.accepted, true);
  `);
});

test("checkout rejects orders without a current Terms-of-sale acceptance", () => {
  runRouteScenario(`
    let reserves = 0;
    const { handler } = runScenario({
      createInitializingOrder: async () => {
        reserves += 1;
        throw new Error("should not reserve without terms acceptance");
      },
    });
    const base = {
      customer: {
        name: "Nataliea Lash",
        email: "client@example.com",
        phone: "4165550100",
      },
      items: [{ productId: product._id, quantity: 1 }],
      shippingAddress,
    };

    const missing = await handler(createRequest({
      ...base,
      disclosures: {
        termsAccepted: undefined,
        termsVersion: undefined,
        termsTextHash: undefined,
      },
    }));
    assert.equal(missing.status, 409);

    const staleVersion = await handler(createRequest({
      ...base,
      disclosures: { termsVersion: "terms-test-v0" },
    }));
    assert.equal(staleVersion.status, 409);

    const wrongHash = await handler(createRequest({
      ...base,
      disclosures: { termsTextHash: "b".repeat(64) },
    }));
    assert.equal(wrongHash.status, 409);

    assert.equal(reserves, 0);
  `);
});

test("shipping checkout without a phone number fails fast with a clean 400", () => {
  runRouteScenario(`
    let reserves = 0;
    let shippingValidations = 0;
    const { handler } = runScenario({
      validateShippingSelection: async () => {
        shippingValidations += 1;
        return { fingerprint: "a".repeat(64) };
      },
      createInitializingOrder: async () => {
        reserves += 1;
        throw new Error("should not reserve a shipping order without a phone");
      },
    });
    const response = await handler(createRequest({
      customer: { name: "Nataliea Lash", email: "client@example.com" },
      items: [{ productId: product._id, quantity: 1 }],
      shippingAddress,
    }));
    // Clean 400 (not an opaque 500), and it fails before any reserve/prepare work.
    assert.equal(response.status, 400);
    assert.equal(reserves, 0);
    assert.equal(shippingValidations, 0);
  `);
});

test("automated checkout reconstruction omits an absent variant id so quote fingerprints remain stable", () => {
  runRouteScenario(`
    let validatedItems;
    const { handler } = runScenario({
      validateShippingSelection: async ({ request }) => {
        validatedItems = request.items;
        return { fingerprint: "a".repeat(64) };
      },
    });
    const response = await handler(createRequest({
      customer: {
        name: "Nataliea Lash",
        email: "client@example.com",
        phone: "4165550100",
      },
      items: [{ productId: product._id, quantity: 1 }],
      shippingAddress,
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(validatedItems, [
      { productId: product._id, quantity: 1 },
    ]);
    assert.equal(Object.hasOwn(validatedItems[0], "variantId"), false);
  `);
});

test("checkout route rejects invalid requests before downstream calls", () => {
  runRouteScenario(`
    const { fetchedProductIds, handler, invoices, orders, paySessions } = runScenario();

    const response = await handler(createRequest({ customer: { name: "Nataliea" }, items: [] }));
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(body, { error: "Invalid checkout request" });
    assert.equal(fetchedProductIds.length, 0);
    assert.equal(invoices.length, 0);
    assert.equal(paySessions.length, 0);
    assert.equal(orders.length, 0);
  `);
});

test("checkout route rejects oversized request bodies before downstream calls", () => {
  runRouteScenario(`
    const { fetchedProductIds, handler, orders } = runScenario();
    const response = await handler(createRequest("x".repeat(64 * 1024 + 1)));
    assert.equal(response.status, 413);
    assert.equal(fetchedProductIds.length, 0);
    assert.equal(orders.length, 0);
  `);
});

test("checkout route rejects malformed customer and shipping fields before downstream calls", () => {
  runRouteScenario(`
    const { fetchedProductIds, handler, invoices, orders, paySessions } = runScenario();

    const invalidBodies = [
      {
        customer: { name: "Nataliea Lash", email: "client.example.com" },
        shippingAddress,
      },
      {
        customer: { name: "Nataliea Lash", email: "client@" },
        shippingAddress,
      },
      {
        customer: { name: "Nataliea Lash", email: "x".repeat(CHECKOUT_EMAIL_MAX_LENGTH + 1) + "@example.com" },
        shippingAddress,
      },
      {
        customer: { name: "x".repeat(CHECKOUT_CUSTOMER_NAME_MAX_LENGTH + 1), email: "client@example.com" },
        shippingAddress,
      },
      {
        customer: { name: "Nataliea Lash", email: "client@example.com" },
        shippingAddress: { ...shippingAddress, line1: "x".repeat(CHECKOUT_SHIPPING_LINE_MAX_LENGTH + 1) },
      },
      {
        customer: { name: "Nataliea Lash", email: "client@example.com" },
        shippingAddress: { ...shippingAddress, line2: "x".repeat(CHECKOUT_SHIPPING_LINE_MAX_LENGTH + 1) },
      },
      {
        customer: { name: "Nataliea Lash", email: "client@example.com" },
        shippingAddress: { ...shippingAddress, city: "Tor" + String.fromCharCode(10) + "onto" },
      },
      {
        customer: { name: "Nataliea Lash", email: "client@example.com" },
        shippingAddress: { ...shippingAddress, country: "x".repeat(CHECKOUT_SHIPPING_LOCALITY_MAX_LENGTH + 1) },
      },
    ];

    for (const body of invalidBodies) {
      const response = await handler(createRequest({
        ...body,
        items: [{ productId: "product-lash-cleanser", quantity: 1 }],
      }));
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "Invalid checkout request" });
    }

    assert.equal(fetchedProductIds.length, 0);
    assert.equal(invoices.length, 0);
    assert.equal(paySessions.length, 0);
    assert.equal(orders.length, 0);
  `);
});

test("checkout route reserves a durable payment operation for a valid cart", () => {
  runRouteScenario(`
    const { fetchedProductIds, handler, orders } = runScenario();

    const response = await handler(createRequest({
      customer: { name: "  Nataliea Lash  ", email: "client@example.com", phone: "4165550100" },
      shippingAddress: { ...shippingAddress, line1: " 646 Oakwood Avenue ", line2: " Suite 2 " },
      items: [{ productId: "product-lash-cleanser", quantity: 2 }],
    }));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      orderId: "lh-product-order",
      status: "paid",
    });
    assert.deepEqual(fetchedProductIds, [["product-lash-cleanser"]]);
    assert.equal(orders.length, 1);
    assert.equal(orders[0].customerName, "Nataliea Lash");
    assert.equal(orders[0].customerEmail, "client@example.com");
    assert.deepEqual(orders[0].shippingAddress, {
      ...shippingAddress,
      province: "ON",
      country: "Canada",
      countryCode: "CA",
      line2: "Suite 2",
      phone: "4165550100",
    });
    assert.equal(orders[0].shippingQuoteToken, "shipping-quote-token");
    assert.equal(orders[0].shippingRateId, "rate-1");
    assert.equal(orders[0].cart.amount, 48);
    assert.equal(orders[0].refundPolicy.accepted, true);
    assert.equal(orders[0].refundPolicy.version, "shipped-refund-test-v1");
    assert.equal(orders[0].refundPolicy.textHash, "c".repeat(64));
    assert.ok(orders[0].refundPolicy.presentedAt instanceof Date);
    assert.equal(
      orders[0].refundPolicy.requestEvidence,
      orders[0].termsAssent.requestEvidence,
    );
  `);
});

test("shipped checkout rejects orders without a current refund-policy acceptance", () => {
  runRouteScenario(`
    let reserves = 0;
    const { handler } = runScenario({
      createInitializingOrder: async () => {
        reserves += 1;
        throw new Error("should not reserve without refund-policy acceptance");
      },
    });
    const base = {
      customer: { name: "Nataliea Lash", email: "client@example.com" },
      items: [{ productId: product._id, quantity: 1 }],
    };

    const missing = await handler(createRequest({
      ...base,
      disclosures: {
        cancellationPolicyAccepted: undefined,
        cancellationPolicyVersion: undefined,
        cancellationPolicyTextHash: undefined,
      },
    }));
    assert.equal(missing.status, 409);

    const wrongVersion = await handler(createRequest({
      ...base,
      disclosures: { cancellationPolicyVersion: "shipped-refund-test-v0" },
    }));
    assert.equal(wrongVersion.status, 409);

    const wrongHash = await handler(createRequest({
      ...base,
      disclosures: { cancellationPolicyTextHash: "d".repeat(64) },
    }));
    assert.equal(wrongHash.status, 409);
    assert.equal(reserves, 0);
  `);
});

test("checkout route binds promotion totals to the durable payment reservation", () => {
  runRouteScenario(`
    const { handler, orders } = runScenario({
      getPromotionCode: async (code) => ({
        _id: "promo-save10",
        code,
        isEnabled: true,
        discountType: "percentage",
        amount: 10,
        appliesTo: "products",
      }),
    });

    const response = await handler(createRequest({
      customer: { name: "Nataliea Lash", email: "client@example.com", phone: "4165550100" },
      shippingAddress,
      items: [{ productId: "product-lash-cleanser", quantity: 2 }],
      promotionCode: "SAVE10",
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      orderId: "lh-product-order",
      status: "paid",
    });
    assert.equal(orders[0].cart.amount, 43.2);
    assert.equal(orders[0].cart.promotionCode, "SAVE10");
    assert.equal(orders[0].cart.promotionDiscountAmount, 4.8);
  `);
});

test("checkout route reserves product payment without Square secrets", () => {
  runRouteScenario(`
    assert.equal(process.env.SERVICE_BOOKING_SQUARE_ENABLED, "true");
    assert.equal(process.env.SQUARE_ACCESS_TOKEN, undefined);

    const { handler, orders } = runScenario();

    const response = await handler(createRequest({
      customer: { name: "Nataliea Lash", email: "client@example.com", phone: "4165550100" },
      shippingAddress,
      items: [{ productId: "product-lash-cleanser", quantity: 1 }],
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      orderId: "lh-product-order",
      status: "paid",
    });
    assert.equal(orders.length, 1);
  `);
});

test("checkout route rejects unavailable Sanity products before Helcim setup", () => {
  runRouteScenario(`
    const { handler, invoices, orders, paySessions } = runScenario({
      getProductsByIds: async () => [{ ...product, isAvailable: false }],
    });

    const response = await handler(createRequest({
      customer: { name: "Nataliea Lash", email: "client@example.com", phone: "4165550100" },
      shippingAddress,
      items: [{ productId: "product-lash-cleanser", quantity: 1 }],
    }));
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(body, { error: "Unable to start checkout" });
    assert.equal(invoices.length, 0);
    assert.equal(paySessions.length, 0);
    assert.equal(orders.length, 0);
  `);
});

test("checkout route rejects unavailable selected variants before Helcim setup", () => {
  runRouteScenario(`
    const { handler, invoices, orders, paySessions } = runScenario({
      getProductsByIds: async () => [{
        ...product,
        variants: [{
          _key: "volume",
          availabilityLabel: "Sold Out",
          isAvailable: false,
          price: 32,
          title: "Volume",
        }],
      }],
    });

    const response = await handler(createRequest({
      customer: { name: "Nataliea Lash", email: "client@example.com", phone: "4165550100" },
      shippingAddress,
      items: [{ productId: "product-lash-cleanser", variantId: "volume", quantity: 1 }],
    }));
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(body, { error: "Unable to start checkout" });
    assert.equal(invoices.length, 0);
    assert.equal(paySessions.length, 0);
    assert.equal(orders.length, 0);
  `);
});

test("checkout route rejects missing canonical products before Helcim setup", () => {
  runRouteScenario(`
    const { handler, invoices } = runScenario({
      getProductsByIds: async () => [],
    });

    const response = await handler(createRequest({
      customer: { name: "Nataliea Lash", email: "client@example.com", phone: "4165550100" },
      shippingAddress,
      items: [{ productId: "product-lash-cleanser", quantity: 1 }],
    }));

    assert.equal(response.status, 400);
    assert.equal(invoices.length, 0);
  `);
});

test("checkout route returns a server failure when checkout input loading fails", () => {
  runRouteScenario(`
    const originalConsoleLog = console.log;
    const consoleCalls = [];
    console.log = (...args) => {
      consoleCalls.push(args);
    };

    try {
      const { handler, invoices, orders, paySessions } = runScenario({
        getProductsByIds: async () => {
          throw new Error("Sanity unavailable for client@example.com");
        },
      });

      const response = await handler(createRequest({
        customer: { name: "Nataliea Lash", email: "client@example.com", phone: "4165550100" },
        shippingAddress,
        items: [{ productId: "product-lash-cleanser", quantity: 1 }],
      }));

      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: "Unable to start checkout" });
      assert.equal(invoices.length, 0);
      assert.equal(paySessions.length, 0);
      assert.equal(orders.length, 0);
      const logEntry = JSON.parse(consoleCalls[0][0]);
      assert.equal(logEntry.level, "error");
      assert.equal(logEntry.message, "[checkout] Unable to initialize checkout");
      assert.equal(logEntry.stage, "load_checkout_inputs");
      assert.equal(logEntry.error, "Checkout initialization failed");
      assert.equal(logEntry.errorName, "Error");

      assert.equal(JSON.stringify(consoleCalls).includes("client@example.com"), false);
      assert.equal(JSON.stringify(consoleCalls).includes("Sanity unavailable"), false);
    } finally {
      console.log = originalConsoleLog;
    }
  `);
});

test("checkout route returns a generic failure when durable order reservation fails", () => {
  runRouteScenario(`
    const { handler, orders } = runScenario({
      createInitializingOrder: async () => {
        throw new Error("Database unavailable");
      },
    });

    const response = await handler(createRequest({
      customer: { name: "Nataliea Lash", email: "client@example.com", phone: "4165550100" },
      shippingAddress,
      items: [{ productId: "product-lash-cleanser", quantity: 1 }],
    }));
    const body = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(body, { error: "Unable to start checkout" });
    assert.equal(orders.length, 1);
  `);
});

test("checkout route rejects reservations without a durable payment operation", () => {
  runRouteScenario(`
    const originalConsoleLog = console.log;
    const consoleCalls = [];
    console.log = (...args) => {
      consoleCalls.push(args);
    };

    try {
      const { handler, initializationFailures, orders } = runScenario({
        createInitializingOrder: async () => ({
          orderId: "lh-product-order",
          shippingAmountCents: 1299,
          totalAmountCents: 3699,
          shippingRateTitle: "Tracked shipping",
        }),
      });

      const response = await handler(createRequest({
        customer: { name: "Nataliea Lash", email: "client@example.com", phone: "4165550100" },
        shippingAddress,
        items: [{ productId: "product-lash-cleanser", quantity: 1 }],
      }));

      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: "Unable to start checkout" });
      assert.equal(orders.length, 1);
      assert.deepEqual(initializationFailures, [{
        orderId: "lh-product-order",
        error: "Durable payment operation was not reserved",
      }]);
      const logEntry = JSON.parse(consoleCalls[0][0]);
      assert.equal(logEntry.level, "error");
      assert.equal(logEntry.message, "[checkout] Unable to initialize checkout");
      assert.equal(logEntry.stage, "reserve_order");
      assert.equal(logEntry.error, "Checkout initialization failed");
      assert.equal(logEntry.errorName, "Error");
    } finally {
      console.log = originalConsoleLog;
    }
  `);
});

test("checkout route reports database failures from durable order reservation", () => {
  runRouteScenario(`
    const { handler, orders } = runScenario({
      createInitializingOrder: async () => {
        throw new Error("Database unavailable");
      },
    });

    const response = await handler(createRequest({
      customer: { name: "Nataliea Lash", email: "client@example.com", phone: "4165550100" },
      shippingAddress,
      items: [{ productId: "product-lash-cleanser", quantity: 1 }],
    }));
    const body = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(body, { error: "Unable to start checkout" });
    assert.equal(orders.length, 1);
  `);
});

test("checkout route logs database causes without leaking query params", () => {
  runRouteScenario(`
    const originalConsoleLog = console.log;
    const consoleCalls = [];
    console.log = (...args) => {
      consoleCalls.push(args);
    };

    try {
      const databaseError = new Error(
        'Failed query: insert into "checkout_orders" values ($1)\\nparams: dardemiri@gmail.com,secret-token-4242',
      );
      databaseError.name = "DrizzleQueryError";
      databaseError.cause = Object.assign(
        new Error('invalid input syntax for type uuid: "secret-token-4242" for dardemiri@gmail.com'),
        {
          code: "23505",
          constraint: "checkout_orders_order_id_unique",
          detail: "Key (customer_email)=(dardemiri@gmail.com) already exists.",
          table: "checkout_orders",
        },
      );

      const { handler } = runScenario({
        createInitializingOrder: async () => {
          throw databaseError;
        },
      });

      const response = await handler(createRequest({
        customer: { name: "Dardan Demiri", email: "dardemiri@gmail.com", phone: "4165550100" },
        shippingAddress,
        items: [{ productId: "product-lash-cleanser", quantity: 1 }],
      }));

      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: "Unable to start checkout" });
      assert.equal(consoleCalls.length, 1);
      const logEntry = JSON.parse(consoleCalls[0][0]);
      assert.equal(logEntry.level, "error");
      assert.equal(logEntry.message, "[checkout] Unable to initialize checkout");
      assert.equal(logEntry.stage, "reserve_order");
      assert.equal(logEntry.error, "Database query failed");
      assert.equal(logEntry.errorName, "DrizzleQueryError");
      assert.deepEqual(logEntry.cause, {
        code: "23505",
        table: "checkout_orders",
        constraint: "checkout_orders_order_id_unique",
      });

      const serializedLog = JSON.stringify(consoleCalls);
      assert.equal(serializedLog.includes("dardemiri@gmail.com"), false);
      assert.equal(serializedLog.includes("secret-token-4242"), false);
      assert.equal(serializedLog.includes("params:"), false);
      assert.equal(serializedLog.includes("detail"), false);
      assert.equal(serializedLog.includes("invalid input syntax"), false);
    } finally {
      console.log = originalConsoleLog;
    }
  `);
});

test("checkout route logs undefined checkout order columns without raw database messages", () => {
  runRouteScenario(`
    const originalConsoleLog = console.log;
    const consoleCalls = [];
    console.log = (...args) => {
      consoleCalls.push(args);
    };

    try {
      const databaseError = new Error(
        'Failed query: insert into "checkout_orders" values ($1)\\nparams: dardemiri@gmail.com,secret-token-4242',
      );
      databaseError.name = "DrizzleQueryError";
      databaseError.cause = Object.assign(
        new Error('column "product_confirmation_email_sent_at" does not exist'),
        {
          code: "42703",
          detail: "Query params included dardemiri@gmail.com and secret-token-4242.",
          severity: "ERROR",
        },
      );

      const { handler } = runScenario({
        createInitializingOrder: async () => {
          throw databaseError;
        },
      });

      const response = await handler(createRequest({
        customer: { name: "Dardan Demiri", email: "dardemiri@gmail.com", phone: "4165550100" },
        shippingAddress,
        items: [{ productId: "product-lash-cleanser", quantity: 1 }],
      }));

      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: "Unable to start checkout" });
      assert.equal(consoleCalls.length, 1);
      const logEntry = JSON.parse(consoleCalls[0][0]);
      assert.equal(logEntry.level, "error");
      assert.equal(logEntry.message, "[checkout] Unable to initialize checkout");
      assert.equal(logEntry.stage, "reserve_order");
      assert.equal(logEntry.error, "Database query failed");
      assert.equal(logEntry.errorName, "DrizzleQueryError");
      assert.deepEqual(logEntry.cause, {
        code: "42703",
        severity: "ERROR",
        column: "product_confirmation_email_sent_at",
      });

      const serializedLog = JSON.stringify(consoleCalls);
      assert.equal(serializedLog.includes("dardemiri@gmail.com"), false);
      assert.equal(serializedLog.includes("secret-token-4242"), false);
      assert.equal(serializedLog.includes("params:"), false);
      assert.equal(serializedLog.includes("detail"), false);
      assert.equal(serializedLog.includes("does not exist"), false);
    } finally {
      console.log = originalConsoleLog;
    }
  `);
});

test("checkout route logs generic failure messages without leaking sensitive values", () => {
  runRouteScenario(`
    const originalConsoleLog = console.log;
    const consoleCalls = [];
    console.log = (...args) => {
      consoleCalls.push(args);
    };

    try {
      const { handler } = runScenario({
        createInitializingOrder: async () => {
          throw new Error("Helcim unavailable for dardemiri@gmail.com with secret-token-4242");
        },
      });

      const response = await handler(createRequest({
        customer: { name: "Dardan Demiri", email: "dardemiri@gmail.com", phone: "4165550100" },
        shippingAddress,
        items: [{ productId: "product-lash-cleanser", quantity: 1 }],
      }));

      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: "Unable to start checkout" });
      assert.equal(consoleCalls.length, 1);
      const logEntry = JSON.parse(consoleCalls[0][0]);
      assert.equal(logEntry.level, "error");
      assert.equal(logEntry.message, "[checkout] Unable to initialize checkout");
      assert.equal(logEntry.stage, "reserve_order");
      assert.equal(logEntry.error, "Checkout initialization failed");
      assert.equal(logEntry.errorName, "Error");

      const serializedLog = JSON.stringify(consoleCalls);
      assert.equal(serializedLog.includes("dardemiri@gmail.com"), false);
      assert.equal(serializedLog.includes("secret-token-4242"), false);
      assert.equal(serializedLog.includes("Helcim unavailable"), false);
    } finally {
      console.log = originalConsoleLog;
    }
  `);
});

test("product checkout route charges product orders through Square", () => {
  const routeSource = readFileSync("src/app/api/checkout/handler.ts", "utf8");

  // The Helcim -> Square migration intentionally reverses the former
  // "product checkout must not reference Square" provider boundary: product
  // checkout now captures payment through the Square Web Payments SDK.
  assert.ok(
    routeSource.includes("createLiveSquareProductCharger"),
    "checkout route should wire the Square commerce charger",
  );
  assert.ok(
    routeSource.includes("isSquareCommerceCheckoutEnabled"),
    "checkout route should gate the Square charge on the commerce flag",
  );
});

function runRouteScenario(assertions: string): void {
  const scenario = `${helperScript}\nvoid (async () => {\n${assertions}\n})()`;
  const env = { ...process.env };

  env.NEXT_PUBLIC_SANITY_DATASET = "test";
  env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";
  env.SERVICE_BOOKING_SQUARE_ENABLED = "true";
  delete env.PAYMENT_GATEWAY_MODE;
  delete env.PAYMENT_MOCK_DEFAULT_SCENARIO;
  delete env.VERCEL_ENV;
  delete env.SQUARE_ACCESS_TOKEN;
  delete env.SQUARE_LOCATION_ID;
  delete env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  delete env.SQUARE_SERVICE_BOOKING_RETURN_URL;
  delete env.SQUARE_SERVICE_BOOKING_WEBHOOK_URL;

  execFileSync(
    process.execPath,
    [
      "--import",
      "./scripts/register-server-only-test.mjs",
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      scenario,
    ],
    {
      cwd: process.cwd(),
      env,
      stdio: "pipe",
    },
  );
}
