import { execFileSync } from "node:child_process";
import test from "node:test";

const helper = String.raw`
  import assert from "node:assert/strict";
  import {
    CourseCheckoutSessionError,
    POST,
    createCourseCheckoutPostHandler,
    verifiedCustomerFromSession,
  } from "./src/app/api/checkout/course/handler.ts";
  import { CourseCheckoutError } from "./src/lib/course-commerce/course-checkout.ts";

  const canonicalId = "123e4567-e89b-42d3-a456-426614174001";
  const validBody = {
    courseSlug: "classic-lash-foundations",
    customer: { email: " Student@Example.com ", name: "  Student Name  " },
  };

  function request(body, headers) {
    return new Request("http://localhost/api/checkout/course", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers,
    });
  }

  function createScenario(overrides = {}) {
    const calls = { identity: 0, statusChecks: [], inputs: [], errors: [] };
    const handler = createCourseCheckoutPostHandler({
      async getVerifiedCustomerSession() {
        calls.identity += 1;
        return "session" in overrides ? overrides.session : {
          customerUserId: canonicalId,
          email: "student@example.com",
        };
      },
      async isActiveCustomerUser(customerUserId) {
        calls.statusChecks.push(customerUserId);
        return overrides.isActive === undefined ? true : overrides.isActive;
      },
      async startCheckout(input) {
        calls.inputs.push(input);
        if (overrides.error) throw overrides.error;
        return { checkoutToken: "checkout-token", orderId: "lh-public-order" };
      },
      reportError(error) {
        calls.errors.push(error);
      },
    });
    return { calls, handler };
  }
`;

test("course checkout route returns only the checkout token and public order id", () => {
  runScenario(String.raw`
    const { calls, handler } = createScenario();
    const response = await handler(request({
      ...validBody,
      customerUserId: "browser-controlled-id",
      customer: { ...validBody.customer, customerUserId: "nested-browser-id" },
    }));

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      checkoutToken: "checkout-token",
      orderId: "lh-public-order",
    });
    assert.equal(calls.identity, 1);
    assert.deepEqual(calls.statusChecks, [canonicalId]);
    assert.equal(calls.inputs.length, 1);
    assert.equal(calls.inputs[0].courseSlug, validBody.courseSlug);
    assert.deepEqual(calls.inputs[0].customer, {
      email: "student@example.com",
      name: "Student Name",
    });
    assert.equal(calls.inputs[0].customerUserId, canonicalId);
  `);
});

test("course checkout route rejects malformed and oversized input before dependencies", () => {
  runScenario(String.raw`
    for (const body of [
      "{",
      {},
      { ...validBody, courseSlug: "../draft" },
      { ...validBody, customer: { ...validBody.customer, email: "invalid" } },
      { ...validBody, customer: { ...validBody.customer, name: "x".repeat(121) } },
      { ...validBody, extra: "x".repeat(5000) },
    ]) {
      const { calls, handler } = createScenario();
      const response = await handler(request(body));
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "Invalid course checkout request" });
      assert.equal(calls.identity, 0);
      assert.equal(calls.statusChecks.length, 0);
      assert.equal(calls.inputs.length, 0);
    }
  `);
});

test("course checkout route uses only a verified canonical session id and email", () => {
  runScenario(String.raw`
    assert.equal(verifiedCustomerFromSession(null), null);
    assert.equal(verifiedCustomerFromSession({ user: { email: "staff@example.com" } }), null);
    for (const session of [
      { user: { id: canonicalId, email: "student@example.com", isEmailVerified: false } },
      { user: { id: "google-provider-sub", email: "student@example.com", isEmailVerified: true } },
      { user: { id: canonicalId, email: "invalid", isEmailVerified: true } },
    ]) {
      assert.throws(
        () => verifiedCustomerFromSession(session),
        CourseCheckoutSessionError,
      );
    }
    assert.deepEqual(
      verifiedCustomerFromSession({
        user: { id: canonicalId, email: " Student@Example.com ", isEmailVerified: true },
      }),
      { customerUserId: canonicalId, email: "student@example.com" },
    );
  `);
});

test("course checkout route rejects inactive sessions and browser email substitution", () => {
  runScenario(String.raw`
    for (const overrides of [
      { isActive: false },
      { session: { customerUserId: canonicalId, email: "verified@example.com" } },
    ]) {
      const { calls, handler } = createScenario(overrides);
      const response = await handler(request(validBody));
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), {
        error: "Customer session cannot be used for course checkout",
      });
      assert.equal(calls.inputs.length, 0);
      assert.deepEqual(calls.statusChecks, [canonicalId]);
    }
  `);
});

test("course checkout route rejects guest payment until an ownership claim flow exists", () => {
  runScenario(String.raw`
    const { calls, handler } = createScenario({ session: null });
    const response = await handler(request(validBody));
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      error: "Sign in is required for course checkout",
    });
    assert.equal(calls.inputs.length, 0);
    assert.equal(calls.statusChecks.length, 0);
  `);
});

test("course checkout launch gate stops before authentication", () => {
  runScenario(String.raw`
    process.env.COURSE_CHECKOUT_ENABLED = "false";
    const response = await POST(request(validBody));

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "Course checkout is unavailable",
    });
  `);
});

test("course checkout route maps safe domain errors without returning internal detail", () => {
  runScenario(String.raw`
    const scenarios = [
      ["CHECKOUT_DISABLED", 503, "Course checkout is unavailable"],
      ["COURSE_UNAVAILABLE", 409, "Course is not available for purchase"],
      ["INVALID_PROVIDER_RESPONSE", 502, "Unable to start course checkout"],
    ];
    for (const [code, status, publicMessage] of scenarios) {
      const { calls, handler } = createScenario({
        error: new CourseCheckoutError(code, "private provider or configuration detail"),
      });
      const response = await handler(request(validBody));
      const responseBody = await response.json();
      assert.equal(response.status, status);
      assert.deepEqual(responseBody, { error: publicMessage });
      assert.equal(calls.errors.length, 1);
      assert.equal(JSON.stringify(responseBody).includes("private"), false);
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
