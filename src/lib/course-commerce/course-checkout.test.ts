import { execFileSync } from "node:child_process";
import test from "node:test";

const helper = String.raw`
  import assert from "node:assert/strict";
  import {
    CourseCheckoutError,
    createCourseCheckout,
  } from "./src/lib/course-commerce/course-checkout.ts";

  const course = {
    id: "123e4567-e89b-42d3-a456-426614174000",
    slug: "classic-lash-foundations",
    title: "Classic Lash Foundations",
    description: null,
    priceCents: 49900,
    currency: "CAD",
    modules: [],
  };

  function createScenario(overrides = {}) {
    const calls = { courses: [], invoices: [], paySessions: [], persisted: [] };
    const dependencies = {
      async getPublishedCourseBySlug(slug, signal) {
        calls.courses.push({ slug, signal });
        return "course" in overrides ? overrides.course : course;
      },
      helcimGateway: {
        async createInvoice(input) {
          calls.invoices.push(input);
          return "invoice" in overrides ? overrides.invoice : { invoiceId: 42, invoiceNumber: "INV-42" };
        },
        async initializePay(input) {
          calls.paySessions.push(input);
          return "paySession" in overrides ? overrides.paySession : {
            checkoutToken: "checkout-token-42",
            secretToken: "secret-token-42",
          };
        },
      },
      repository: {
        async persistPendingCheckout(input) {
          calls.persisted.push(input);
          return { orderId: "lh-public-order-42" };
        },
      },
    };
    return { calls, checkout: createCourseCheckout(dependencies) };
  }

  const validInput = {
    courseSlug: course.slug,
    customer: { email: " Student@Example.com ", name: "  Student Name  " },
    customerUserId: "123e4567-e89b-42d3-a456-426614174001",
  };
`;

test("course checkout creates one-course Helcim purchase from authoritative pricing", () => {
  runScenario(String.raw`
    const { calls, checkout } = createScenario();
    const result = await checkout(validInput);

    assert.deepEqual(result, {
      checkoutToken: "checkout-token-42",
      orderId: "lh-public-order-42",
    });
    assert.equal(calls.courses.length, 1);
    assert.equal(calls.courses[0].slug, course.slug);
    assert.deepEqual(calls.invoices, [{
      currency: "CAD",
      lineItems: [{
        description: course.title,
        price: 499,
        quantity: 1,
        sku: course.slug,
      }],
      notes: "Lash Her course checkout",
      status: "DUE",
      type: "INVOICE",
    }]);
    assert.deepEqual(calls.paySessions, [{
      amount: 499,
      currency: "CAD",
      invoiceNumber: "INV-42",
      paymentType: "purchase",
    }]);
    assert.equal(calls.persisted.length, 1);
    assert.equal(calls.persisted[0].customerEmail, "student@example.com");
    assert.equal(calls.persisted[0].customerName, "Student Name");
    assert.equal(calls.persisted[0].customerUserId, validInput.customerUserId);
    assert.equal(calls.persisted[0].course.priceCents, 49900);
  `);
});

test("course checkout preserves guest ownership when no canonical customer exists", () => {
  runScenario(String.raw`
    const { calls, checkout } = createScenario();
    await checkout({ ...validInput, customerUserId: null });
    assert.equal(calls.persisted[0].customerUserId, null);
  `);
});

test("course checkout rejects unavailable pricing before creating Helcim resources", () => {
  runScenario(String.raw`
    for (const invalidCourse of [
      { ...course, priceCents: 0 },
      { ...course, priceCents: Number.NaN },
      { ...course, currency: "USD" },
      { ...course, slug: "another-course" },
    ]) {
      const { calls, checkout } = createScenario({ course: invalidCourse });
      await assert.rejects(
        checkout(validInput),
        (error) => error instanceof CourseCheckoutError && error.code === "COURSE_UNAVAILABLE",
      );
      assert.equal(calls.invoices.length, 0);
      assert.equal(calls.paySessions.length, 0);
      assert.equal(calls.persisted.length, 0);
    }
  `);
});

test("course checkout validates Helcim responses before persistence", () => {
  runScenario(String.raw`
    for (const overrides of [
      { invoice: null },
      { invoice: { invoiceId: 0, invoiceNumber: "INV-42" } },
      { invoice: { invoiceId: 42, invoiceNumber: "" } },
      { paySession: null },
      { paySession: { checkoutToken: "", secretToken: "secret-token-42" } },
      { paySession: { checkoutToken: "checkout-token-42", secretToken: "bad" + String.fromCharCode(10) } },
    ]) {
      const { calls, checkout } = createScenario(overrides);
      await assert.rejects(
        checkout(validInput),
        (error) => error instanceof CourseCheckoutError && error.code === "INVALID_PROVIDER_RESPONSE",
      );
      assert.equal(calls.persisted.length, 0);
    }
  `);
});

test("course checkout defensively rejects invalid internal identity and bounded inputs", () => {
  runScenario(String.raw`
    for (const input of [
      { ...validInput, courseSlug: "../draft" },
      { ...validInput, customerUserId: "google-provider-sub" },
      { ...validInput, customer: { ...validInput.customer, email: "invalid" } },
      { ...validInput, customer: { ...validInput.customer, name: "x".repeat(121) } },
    ]) {
      const { calls, checkout } = createScenario();
      await assert.rejects(
        checkout(input),
        (error) => error instanceof CourseCheckoutError && error.code === "INVALID_INPUT",
      );
      assert.equal(calls.courses.length, 0);
    }
  `);
});

function runScenario(assertions: string): void {
  const scenario = `${helper}\nvoid (async () => {\n${assertions}\n})()`;
  execFileSync(
    "./node_modules/.bin/tsx",
    ["--conditions=react-server", "--eval", scenario],
    { cwd: process.cwd(), env: process.env, stdio: "pipe" },
  );
}
