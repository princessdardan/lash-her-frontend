export const paymentMockScenarios = [
  "success",
  "decline",
  "cancel",
  "refund",
  "refund_failed",
  "webhook",
  "duplicate_webhook",
  "temporary_error",
  "delayed_capture",
  "idempotency_mismatch",
  "idempotency_expired",
] as const;

export type PaymentMockScenario = (typeof paymentMockScenarios)[number];

const paymentMockScenarioSet = new Set<PaymentMockScenario>(paymentMockScenarios);

export function isPaymentMockScenario(value: string): value is PaymentMockScenario {
  return paymentMockScenarioSet.has(value as PaymentMockScenario);
}

export function parsePaymentMockScenario(value: string | null | undefined): PaymentMockScenario | null {
  if (value === null || value === undefined) {
    return null;
  }

  return isPaymentMockScenario(value) ? value : null;
}

export function assertPaymentMockScenario(value: string): PaymentMockScenario {
  if (!isPaymentMockScenario(value)) {
    throw new Error(`Unsupported payment mock scenario: ${value}`);
  }

  return value;
}
