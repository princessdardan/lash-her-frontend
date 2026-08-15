import "server-only";

import {
  claimProductPaymentRiskAlertDeliveries,
  completeProductPaymentRiskAlertDelivery,
  retryProductPaymentRiskAlertDelivery,
} from "@/lib/commerce/product-payment-finalizer-alerts";
import { sendShippingPolicyAlert } from "./policy-alerts";
import {
  computeShipmentRetryDelaySeconds,
  MAX_SHIPMENT_OPERATION_ATTEMPTS,
} from "./shipment-store";

export interface ProductPaymentRiskAlertDrainResult {
  claimed: number;
  succeeded: number;
  retried: number;
  deadLettered: number;
  fenced: number;
}

export async function drainProductPaymentRiskAlerts(
  now = new Date(),
): Promise<ProductPaymentRiskAlertDrainResult> {
  const deliveries = await claimProductPaymentRiskAlertDeliveries({
    limit: 25,
    now,
    leaseMs: 5 * 60_000,
  });
  const result: ProductPaymentRiskAlertDrainResult = {
    claimed: deliveries.length,
    succeeded: 0,
    retried: 0,
    deadLettered: 0,
    fenced: 0,
  };
  for (const delivery of deliveries) {
    try {
      const payload = parsePayload(delivery.payload);
      await sendShippingPolicyAlert({
        duties: [delivery.recipientDuty],
        subject: payload.subject,
        message: payload.message,
        critical: true,
        idempotencyKey: delivery.idempotencyKey,
      });
      const completed = await completeProductPaymentRiskAlertDelivery({
        id: delivery.id,
        incidentId: delivery.incidentId,
        leaseOwner: delivery.leaseOwner,
        sentAt: new Date(),
      });
      result[completed ? "succeeded" : "fenced"] += 1;
    } catch (error) {
      const deadLetter =
        error instanceof InvalidRiskAlertPayloadError ||
        delivery.attemptCount >= MAX_SHIPMENT_OPERATION_ATTEMPTS;
      const delaySeconds = computeShipmentRetryDelaySeconds({
        attemptCount: delivery.attemptCount,
      });
      const released = await retryProductPaymentRiskAlertDelivery({
        id: delivery.id,
        leaseOwner: delivery.leaseOwner,
        error:
          error instanceof Error
            ? error.message
            : "Payment risk alert delivery failed",
        availableAt: new Date(now.getTime() + delaySeconds * 1_000),
        deadLetter,
      });
      result[released ? (deadLetter ? "deadLettered" : "retried") : "fenced"] +=
        1;
    }
  }
  return result;
}

function parsePayload(value: Record<string, unknown>): {
  subject: string;
  message: string;
} {
  if (
    typeof value.subject !== "string" ||
    !value.subject.trim() ||
    typeof value.message !== "string" ||
    !value.message.trim() ||
    value.critical !== true
  ) {
    throw new InvalidRiskAlertPayloadError();
  }
  return {
    subject: value.subject.trim().slice(0, 200),
    message: value.message.trim().slice(0, 4_000),
  };
}

class InvalidRiskAlertPayloadError extends Error {
  constructor() {
    super("Payment risk alert payload is invalid");
  }
}
