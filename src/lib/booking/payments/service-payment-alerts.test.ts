import assert from "node:assert/strict";
import test from "node:test";

import { createServicePaymentAlertLogger } from "./service-payment-alerts";

test("service payment alerts emit safe structured payloads", async () => {
  const calls: unknown[] = [];
  const alerts = createServicePaymentAlertLogger({
    logError: (...args: unknown[]) => calls.push(args),
    logWarn: (...args: unknown[]) => calls.push(args),
  });

  await alerts.alert({
    category: "square_webhook_non_finalized",
    severity: "warning",
    message: "Webhook did not finalize booking",
    context: {
      eventId: "evt_123",
      orderId: "lh-sq-local",
      rawCardToken: "cnon:do-not-log",
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    "[service-payment-alert] Webhook did not finalize booking",
    {
      category: "square_webhook_non_finalized",
      context: {
        eventId: "evt_123",
        orderId: "lh-sq-local",
        rawCardToken: "[redacted]",
      },
      severity: "warning",
    },
  ]);
});

test("service payment alerts redact nested object values under sensitive keys", async () => {
  const calls: unknown[] = [];
  const alerts = createServicePaymentAlertLogger({
    logWarn: (...args: unknown[]) => calls.push(args),
  });

  await alerts.alert({
    category: "square_webhook_non_finalized",
    severity: "warning",
    message: "Nested leak check",
    context: {
      card: { token: "nested-token", brand: "Visa" },
      safe: { id: "keep" },
    },
  });

  const payload = (calls[0] as unknown[])[1] as {
    context: { card: string; safe: { id: string } };
  };
  assert.equal(payload.context.card, "[redacted]");
  assert.deepEqual(payload.context.safe, { id: "keep" });
});

test("service payment alerts redact array values under sensitive keys", async () => {
  const calls: unknown[] = [];
  const alerts = createServicePaymentAlertLogger({
    logWarn: (...args: unknown[]) => calls.push(args),
  });

  await alerts.alert({
    category: "square_webhook_non_finalized",
    severity: "warning",
    message: "Array leak check",
    context: {
      tokens: ["a", "b"],
      safeList: ["visible"],
    },
  });

  const payload = (calls[0] as unknown[])[1] as {
    context: { tokens: string; safeList: string[] };
  };
  assert.equal(payload.context.tokens, "[redacted]");
  assert.deepEqual(payload.context.safeList, ["visible"]);
});

test("service payment alerts redact numeric values under sensitive keys", async () => {
  const calls: unknown[] = [];
  const alerts = createServicePaymentAlertLogger({
    logWarn: (...args: unknown[]) => calls.push(args),
  });

  await alerts.alert({
    category: "square_webhook_non_finalized",
    severity: "warning",
    message: "Numeric leak check",
    context: {
      cvc: 123,
      cvv: "456",
      safeNumber: 42,
    },
  });

  const payload = (calls[0] as unknown[])[1] as {
    context: { cvc: string; cvv: string; safeNumber: number };
  };
  assert.equal(payload.context.cvc, "[redacted]");
  assert.equal(payload.context.cvv, "[redacted]");
  assert.equal(payload.context.safeNumber, 42);
});

test("service payment alerts keep squareCardId provider reference visible while redacting sensitive card tokens", async () => {
  const calls: unknown[] = [];
  const alerts = createServicePaymentAlertLogger({
    logError: (...args: unknown[]) => calls.push(args),
  });

  await alerts.alert({
    category: "square_card_save_failed",
    severity: "error",
    message: "Card save failed",
    context: {
      squareCardId: "sq-card-abc123",
      rawCardToken: "cnon:do-not-log",
      card: { brand: "Visa", last4: "4242" },
    },
  });

  assert.equal(calls.length, 1);
  const payload = (calls[0] as unknown[])[1] as {
    context: { squareCardId: unknown; rawCardToken: unknown; card: unknown };
  };
  assert.equal(payload.context.squareCardId, "sq-card-abc123");
  assert.equal(payload.context.rawCardToken, "[redacted]");
  assert.equal(payload.context.card, "[redacted]");
});

test("service payment alerts redact source-related context keys while keeping squareCardId visible", async () => {
  const calls: unknown[] = [];
  const alerts = createServicePaymentAlertLogger({
    logError: (...args: unknown[]) => calls.push(args),
  });

  await alerts.alert({
    category: "square_card_save_failed",
    severity: "error",
    message: "Card save failed",
    context: {
      squareCardId: "sq-card-abc123",
      sourceId: "cnon:card-token",
      squareSourceId: "cnon:square-token",
      paymentSourceId: "cnon:payment-token",
      cardSourceId: "cnon:generic-token",
    },
  });

  assert.equal(calls.length, 1);
  const payload = (calls[0] as unknown[])[1] as {
    context: {
      squareCardId: unknown;
      sourceId: unknown;
      squareSourceId: unknown;
      paymentSourceId: unknown;
      cardSourceId: unknown;
    };
  };
  assert.equal(payload.context.squareCardId, "sq-card-abc123");
  assert.equal(payload.context.sourceId, "[redacted]");
  assert.equal(payload.context.squareSourceId, "[redacted]");
  assert.equal(payload.context.paymentSourceId, "[redacted]");
  assert.equal(payload.context.cardSourceId, "[redacted]");
});

test("service payment alerts redact payment session references", async () => {
  const calls: unknown[] = [];
  const alerts = createServicePaymentAlertLogger({
    logError: (...args: unknown[]) => calls.push(args),
  });

  await alerts.alert({
    category: "square_card_save_failed",
    severity: "error",
    message: "Card-on-file lookup failed",
    context: {
      paymentSessionReference: "pay_sess_do_not_log",
      sessionReference: "pay_sess_nested_do_not_log",
      squarePaymentId: "square-payment-visible",
    },
  });

  assert.equal(calls.length, 1);
  const payload = (calls[0] as unknown[])[1] as {
    context: {
      paymentSessionReference: unknown;
      sessionReference: unknown;
      squarePaymentId: unknown;
    };
  };
  assert.equal(payload.context.paymentSessionReference, "[redacted]");
  assert.equal(payload.context.sessionReference, "[redacted]");
  assert.equal(payload.context.squarePaymentId, "square-payment-visible");
});
