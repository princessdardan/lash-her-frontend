import "server-only";

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import {
  enqueuePaidProductOrderConfirmationEmail,
  listPaidProductOrdersMissingConfirmationOutbox,
  recordProductOrderConfirmationEmailFailure,
} from "./order-store";
import {
  claimCustomerEmails,
  completeCustomerEmail,
  failCustomerEmail,
} from "./customer-email-outbox";
import {
  sendProductOrderConfirmationEmail,
  type SendProductOrderConfirmationEmailInput,
} from "./product-order-email";
import { deliverShippingCustomerLinkEmail } from "@/lib/shipping/customer-link-email";
import {
  deliverShippingCustomerUpdate,
  deliverShippingPolicyAlertEmail,
} from "@/lib/shipping/policy-alerts";
import { deliverShipmentNotification } from "@/lib/shipping/notifications";
import { markShipmentNotificationSent } from "@/lib/shipping/shipment-store";
import { checkoutOrders } from "@/lib/private-db/schema";

export interface CustomerEmailOutboxWorkerResult {
  claimed: number;
  enqueued: number;
  failed: number;
  sent: number;
}

export async function processCustomerEmailOutbox(
  input: {
    limit?: number;
    leaseOwner?: string;
    now?: Date;
  } = {},
): Promise<CustomerEmailOutboxWorkerResult> {
  const leaseOwner =
    input.leaseOwner?.trim() || `customer-email/${randomUUID()}`;
  const missingOrderIds = await listPaidProductOrdersMissingConfirmationOutbox({
    limit: input.limit,
  });
  let enqueued = 0;
  for (const orderId of missingOrderIds) {
    const queued = await enqueuePaidProductOrderConfirmationEmail({
      orderId,
      ...(input.now ? { now: input.now } : {}),
    });
    if (queued) enqueued += 1;
  }
  const claimed = await claimCustomerEmails({
    leaseOwner,
    ...(input.limit ? { limit: input.limit } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
  let sent = 0;
  let failed = 0;

  for (const email of claimed) {
    try {
      if (email.decodeError) throw new Error(email.decodeError);
      const result = await deliverClaimedCustomerEmail(email);
      const completed = await completeCustomerEmail({
        id: email.id,
        leaseOwner,
        providerMessageId: result.id,
        ...(input.now ? { now: input.now } : {}),
        ...(result.completion
          ? {
              onCompleted: async (tx) => {
                const completedAt = input.now ?? new Date();
                if (result.completion?.type === "product_confirmation") {
                  await tx
                    .update(checkoutOrders)
                    .set({
                      productConfirmationEmailClaimedUntil: null,
                      productConfirmationEmailLastError: null,
                      productConfirmationEmailSentAt: completedAt,
                      updatedAt: completedAt,
                    })
                    .where(
                      eq(checkoutOrders.orderId, result.completion.orderId),
                    );
                } else if (
                  result.completion?.type === "shipment_notification"
                ) {
                  await markShipmentNotificationSent(
                    result.completion.shipmentId,
                    result.completion.kind,
                    completedAt,
                    tx,
                  );
                }
              },
            }
          : {}),
      });
      if (!completed) {
        throw new Error("Customer email outbox lease was lost after delivery");
      }
      sent += 1;
    } catch (error) {
      failed += 1;
      const orderId =
        email.kind === "product_order_confirmation"
          ? getOrderId(email.payload)
          : null;
      if (orderId) {
        await recordProductOrderConfirmationEmailFailure({
          error: error instanceof Error ? error.message : "Unknown email error",
          orderId,
          ...(input.now ? { now: input.now } : {}),
        }).catch(() => undefined);
      }
      await failCustomerEmail({
        id: email.id,
        leaseOwner,
        error: error instanceof Error ? error.message : "Unknown email error",
        ...(input.now ? { now: input.now } : {}),
      });
    }
  }

  return { claimed: claimed.length, enqueued, failed, sent };
}

async function deliverClaimedCustomerEmail(email: {
  kind: import("./customer-email-outbox").CustomerEmailOutboxKind;
  payload: unknown;
  providerIdempotencyKey: string;
  recipient: string;
}): Promise<{
  id: string;
  completion?:
    | { type: "product_confirmation"; orderId: string }
    | {
        type: "shipment_notification";
        shipmentId: string;
        kind: "accepted" | "exception" | "delivered";
      };
}> {
  switch (email.kind) {
    case "product_order_confirmation": {
      const payload = parseProductOrderEmailPayload(email.payload);
      if (payload.customerEmail.trim().toLowerCase() !== email.recipient) {
        throw new Error(
          "Customer email outbox recipient does not match payload",
        );
      }
      const result = await sendProductOrderConfirmationEmail(payload);
      return {
        ...result,
        completion: { type: "product_confirmation", orderId: payload.orderId },
      };
    }
    case "shipping_customer_link": {
      const payload = parseShippingCustomerLinkPayload(email.payload);
      return deliverShippingCustomerLinkEmail({
        to: email.recipient,
        ...payload,
        idempotencyKey: email.providerIdempotencyKey,
      });
    }
    case "shipping_customer_update": {
      const payload = parseShippingCustomerUpdatePayload(email.payload);
      return deliverShippingCustomerUpdate({
        to: email.recipient,
        ...payload,
        idempotencyKey: email.providerIdempotencyKey,
      });
    }
    case "shipping_policy_alert": {
      const payload = parseShippingPolicyAlertPayload(email.payload);
      return deliverShippingPolicyAlertEmail({
        to: email.recipient,
        ...payload,
        idempotencyKey: email.providerIdempotencyKey,
      });
    }
    case "shipping_shipment_notification": {
      const payload = parseShipmentNotificationPayload(email.payload);
      const result = await deliverShipmentNotification({
        to: email.recipient,
        ...payload,
        idempotencyKey: email.providerIdempotencyKey,
      });
      return {
        ...result,
        completion: {
          type: "shipment_notification",
          shipmentId: payload.shipmentId,
          kind: payload.kind,
        },
      };
    }
  }
}

function parseShipmentNotificationPayload(value: unknown): {
  shipmentId: string;
  kind: "accepted" | "exception" | "delivered";
  orderReference: string;
  customerName: string;
  trackingNumber: string | null;
  trackingUrl: string | null;
} {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.shipmentId) ||
    (value.kind !== "accepted" &&
      value.kind !== "exception" &&
      value.kind !== "delivered") ||
    !isNonEmptyString(value.orderReference) ||
    !isNonEmptyString(value.customerName) ||
    !isNullableString(value.trackingNumber) ||
    !isNullableHttpsUrl(value.trackingUrl)
  ) {
    throw new Error("Malformed shipment notification outbox payload");
  }
  return {
    shipmentId: value.shipmentId,
    kind: value.kind,
    orderReference: value.orderReference,
    customerName: value.customerName,
    trackingNumber: value.trackingNumber,
    trackingUrl: value.trackingUrl,
  };
}

function parseShippingCustomerLinkPayload(value: unknown): {
  orderReference: string;
  link: string;
  purpose: "decision" | "address-change" | "payment-offer";
} {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.orderReference) ||
    !isNonEmptyString(value.link) ||
    (value.purpose !== "decision" &&
      value.purpose !== "address-change" &&
      value.purpose !== "payment-offer")
  ) {
    throw new Error("Malformed shipping customer link outbox payload");
  }
  return {
    orderReference: value.orderReference,
    link: value.link,
    purpose: value.purpose,
  };
}

function parseShippingCustomerUpdatePayload(value: unknown): {
  orderReference: string;
  subject: string;
  message: string;
} {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.orderReference) ||
    !isNonEmptyString(value.subject) ||
    !isNonEmptyString(value.message)
  ) {
    throw new Error("Malformed shipping customer update outbox payload");
  }
  return {
    orderReference: value.orderReference,
    subject: value.subject,
    message: value.message,
  };
}

function parseShippingPolicyAlertPayload(value: unknown): {
  subject: string;
  message: string;
  critical: boolean;
} {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.subject) ||
    !isNonEmptyString(value.message) ||
    typeof value.critical !== "boolean"
  ) {
    throw new Error("Malformed shipping policy alert outbox payload");
  }
  return {
    subject: value.subject,
    message: value.message,
    critical: value.critical,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length <= 200);
}

function isNullableHttpsUrl(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string" || value.length > 2_000) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function getOrderId(value: unknown): string | null {
  return isRecord(value) && typeof value.orderId === "string"
    ? value.orderId
    : null;
}

function parseProductOrderEmailPayload(
  value: unknown,
): SendProductOrderConfirmationEmailInput {
  if (
    !isRecord(value) ||
    typeof value.currency !== "string" ||
    typeof value.customerEmail !== "string" ||
    typeof value.customerName !== "string" ||
    typeof value.orderId !== "string" ||
    typeof value.totalAmount !== "number" ||
    !Number.isFinite(value.totalAmount) ||
    !Array.isArray(value.lineItems) ||
    !value.lineItems.every(isLineItem) ||
    (value.shippingAddress !== null &&
      value.shippingAddress !== undefined &&
      !isShippingAddress(value.shippingAddress))
  ) {
    throw new Error("Malformed product order confirmation outbox payload");
  }
  return value as unknown as SendProductOrderConfirmationEmailInput;
}

function isLineItem(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.productId === "string" &&
    typeof value.sku === "string" &&
    typeof value.description === "string" &&
    Number.isInteger(value.quantity) &&
    typeof value.totalCents === "number" &&
    Number.isSafeInteger(value.totalCents)
  );
}

function isShippingAddress(value: unknown): boolean {
  return (
    isRecord(value) &&
    ["line1", "city", "province", "postalCode", "country"].every(
      (key) => typeof value[key] === "string" && value[key].trim().length > 0,
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
