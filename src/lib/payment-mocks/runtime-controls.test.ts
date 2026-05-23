import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPaymentMockAllowed,
  resolvePaymentMockScenario,
} from "./runtime-controls";

const baseEnv = {
  NODE_ENV: "development",
  VERCEL_ENV: "development",
} satisfies NodeJS.ProcessEnv;

const mockEnv = {
  ...baseEnv,
  PAYMENT_GATEWAY_MODE: "mock",
} satisfies NodeJS.ProcessEnv;

test("payment mock scenario resolution follows injected, header, query, env, success precedence", () => {
  const request = new Request("http://localhost:3000/api/payment-mocks?mockPaymentScenario=cancel", {
    headers: {
      "x-lash-payment-mock-scenario": "refund",
    },
  });

  assert.equal(resolvePaymentMockScenario({
    env: { ...mockEnv, PAYMENT_MOCK_DEFAULT_SCENARIO: "decline" },
    injectedScenario: "temporary_error",
    now: new Date("2026-05-23T12:00:00.000Z"),
    request,
  }), "temporary_error");

  assert.equal(resolvePaymentMockScenario({
    env: { ...mockEnv, PAYMENT_MOCK_DEFAULT_SCENARIO: "decline" },
    now: new Date("2026-05-23T12:00:00.000Z"),
    request,
  }), "refund");

  assert.equal(resolvePaymentMockScenario({
    env: { ...mockEnv, PAYMENT_MOCK_DEFAULT_SCENARIO: "decline" },
    now: new Date("2026-05-23T12:00:00.000Z"),
    request: new Request("http://localhost:3000/api/payment-mocks?mockPaymentScenario=cancel"),
  }), "cancel");

  assert.equal(resolvePaymentMockScenario({
    env: { ...mockEnv, PAYMENT_MOCK_DEFAULT_SCENARIO: "decline" },
    now: new Date("2026-05-23T12:00:00.000Z"),
    request: new Request("http://localhost:3000/api/payment-mocks"),
  }), "decline");

  assert.equal(resolvePaymentMockScenario({
    env: mockEnv,
    now: new Date("2026-05-23T12:00:00.000Z"),
    request: new Request("http://localhost:3000/api/payment-mocks"),
  }), "success");
});

test("payment mock scenario resolution rejects unsupported header values without leaking request headers", () => {
  assert.throws(() => resolvePaymentMockScenario({
    env: mockEnv,
    now: new Date("2026-05-23T12:00:00.000Z"),
    request: new Request("http://localhost:3000/api/payment-mocks?mockPaymentScenario=cancel", {
      headers: {
        "x-lash-payment-mock-scenario": "unsupported",
        authorization: "Bearer secret-token",
      },
    }),
  }), (error: unknown) => {
    assert.equal(error instanceof Error, true);
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /Unsupported payment mock scenario: unsupported/);
    assert.equal(message.includes("x-lash-payment-mock-scenario"), false);
    assert.equal(message.includes("authorization"), false);
    assert.equal(message.includes("secret-token"), false);
    return true;
  });
});

test("payment mock guard rejects any mock controls in production before provider work", () => {
  const productionEnv = {
    NODE_ENV: "production",
    VERCEL_ENV: "production",
  } satisfies NodeJS.ProcessEnv;

  assert.throws(() => assertPaymentMockAllowed({
    env: { ...productionEnv, PAYMENT_GATEWAY_MODE: "mock" },
    request: new Request("http://localhost:3000/api/payment-mocks"),
  }), /Payment mock mode is not allowed in production/);

  assert.throws(() => assertPaymentMockAllowed({
    env: { ...productionEnv, PAYMENT_MOCK_DEFAULT_SCENARIO: "refund" },
    request: new Request("http://localhost:3000/api/payment-mocks"),
  }), /Payment mock mode is not allowed in production/);

  assert.throws(() => assertPaymentMockAllowed({
    env: productionEnv,
    request: new Request("http://localhost:3000/api/payment-mocks", {
      headers: {
        "x-lash-payment-mock-scenario": "refund",
      },
    }),
  }), /Payment mock mode is not allowed in production/);

  assert.throws(() => assertPaymentMockAllowed({
    env: productionEnv,
    request: new Request("http://localhost:3000/api/payment-mocks?mockPaymentScenario=refund"),
  }), /Payment mock mode is not allowed in production/);
});

test("payment mock guard rejects request-level controls unless mock mode is enabled", () => {
  assert.throws(() => assertPaymentMockAllowed({
    env: baseEnv,
    request: new Request("http://localhost:3000/api/payment-mocks", {
      headers: {
        "x-lash-payment-mock-scenario": "refund",
      },
    }),
  }), /Payment mock controls require PAYMENT_GATEWAY_MODE=mock/);

  assert.throws(() => assertPaymentMockAllowed({
    env: { ...baseEnv, PAYMENT_GATEWAY_MODE: "live" },
    request: new Request("http://localhost:3000/api/payment-mocks?mockPaymentScenario=refund"),
  }), /Payment mock controls require PAYMENT_GATEWAY_MODE=mock/);
});

test("payment mock guard allows request-level controls in local mock mode", () => {
  assert.doesNotThrow(() => assertPaymentMockAllowed({
    env: { ...baseEnv, PAYMENT_GATEWAY_MODE: "mock" },
    request: new Request("http://localhost:3000/api/payment-mocks?mockPaymentScenario=refund", {
      headers: {
        "x-lash-payment-mock-scenario": "cancel",
      },
    }),
  }));
});
