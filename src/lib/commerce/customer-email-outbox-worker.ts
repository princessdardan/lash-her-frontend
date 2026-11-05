import "server-only";

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import {
  CONTACT_POPUP_CUSTOMER_EMAIL_MAX_LENGTH,
  CONTACT_POPUP_CUSTOMER_NAME_MAX_LENGTH,
  CONTACT_POPUP_OFFER_CTA_LABEL_MAX_LENGTH,
  CONTACT_POPUP_OFFER_CTA_URL_MAX_LENGTH,
  CONTACT_POPUP_OFFER_IDENTITY_MAX_LENGTH,
  CONTACT_POPUP_OFFER_LABEL_MAX_LENGTH,
  CONTACT_POPUP_OFFER_TERMS_MAX_LENGTH,
} from "@/lib/contact-popup/signup-offer-contract";
import { parsePromotionCodeInput } from "@/lib/commerce/discounts";
import {
  enqueuePaidProductOrderConfirmationEmail,
  listPaidProductOrdersMissingConfirmationOutbox,
  recordProductOrderConfirmationEmailFailure,
} from "./order-store";
import {
  claimCustomerEmailById,
  claimCustomerEmails,
  completeCustomerEmail,
  failCustomerEmail,
  isContactPopupOfferRecipientSubscribed,
  suppressCustomerEmail,
  type ContactPopupOfferEmailPayload,
} from "./customer-email-outbox";
import { deliverContactPopupOfferEmail } from "@/lib/email";
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
import { markWriterOperationUncertain } from "@/lib/writer-admission/context";

export interface CustomerEmailOutboxWorkerResult {
  claimed: number;
  enqueued: number;
  failed: number;
  sent: number;
  suppressed: number;
}

export interface CustomerEmailOutboxWorkerDependencies {
  listMissing: typeof listPaidProductOrdersMissingConfirmationOutbox;
  enqueue: typeof enqueuePaidProductOrderConfirmationEmail;
  claim: typeof claimCustomerEmails;
  claimById: typeof claimCustomerEmailById;
  complete: typeof completeCustomerEmail;
  fail: typeof failCustomerEmail;
  suppress: typeof suppressCustomerEmail;
  deliver: (
    email: import("./customer-email-outbox").ClaimedCustomerEmail,
  ) => ReturnType<typeof deliverClaimedCustomerEmail>;
  recordProductFailure: typeof recordProductOrderConfirmationEmailFailure;
}

const defaultDependencies: CustomerEmailOutboxWorkerDependencies = {
  listMissing: listPaidProductOrdersMissingConfirmationOutbox,
  enqueue: enqueuePaidProductOrderConfirmationEmail,
  claim: claimCustomerEmails,
  claimById: claimCustomerEmailById,
  complete: completeCustomerEmail,
  fail: failCustomerEmail,
  suppress: suppressCustomerEmail,
  deliver: deliverClaimedCustomerEmail,
  recordProductFailure: recordProductOrderConfirmationEmailFailure,
};

export async function processCustomerEmailOutbox(
  input: {
    limit?: number;
    leaseOwner?: string;
    now?: Date;
  } = {},
  dependencies: CustomerEmailOutboxWorkerDependencies = defaultDependencies,
): Promise<CustomerEmailOutboxWorkerResult> {
  const leaseOwner =
    input.leaseOwner?.trim() || `customer-email/${randomUUID()}`;
  const missingOrderIds = await dependencies.listMissing({
    limit: input.limit,
  });
  let enqueued = 0;
  for (const orderId of missingOrderIds) {
    const queued = await dependencies.enqueue({
      orderId,
      ...(input.now ? { now: input.now } : {}),
    });
    if (queued) enqueued += 1;
    else markWriterOperationUncertain();
  }
  const claimed = await dependencies.claim({
    leaseOwner,
    ...(input.limit ? { limit: input.limit } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
  return processClaimedCustomerEmails(
    {
      claimed,
      enqueued,
      leaseOwner,
      ...(input.now ? { now: input.now } : {}),
    },
    dependencies,
  );
}

export async function processCustomerEmailOutboxJob(
  input: {
    jobId: string;
    leaseOwner?: string;
    now?: Date;
  },
  dependencies: CustomerEmailOutboxWorkerDependencies = defaultDependencies,
): Promise<CustomerEmailOutboxWorkerResult> {
  const leaseOwner =
    input.leaseOwner?.trim() || `customer-email/${randomUUID()}`;
  const claimed = await dependencies.claimById({
    id: input.jobId,
    leaseOwner,
    ...(input.now ? { now: input.now } : {}),
  });
  return processClaimedCustomerEmails(
    {
      claimed: claimed ? [claimed] : [],
      enqueued: 0,
      leaseOwner,
      ...(input.now ? { now: input.now } : {}),
    },
    dependencies,
  );
}

async function processClaimedCustomerEmails(
  input: {
    claimed: import("./customer-email-outbox").ClaimedCustomerEmail[];
    enqueued: number;
    leaseOwner: string;
    now?: Date;
  },
  dependencies: CustomerEmailOutboxWorkerDependencies,
): Promise<CustomerEmailOutboxWorkerResult> {
  let sent = 0;
  let failed = 0;
  let suppressed = 0;

  for (const email of input.claimed) {
    try {
      if (email.decodeError) throw new Error(email.decodeError);
      const result = await dependencies.deliver(email);
      if (result.suppressed) {
        const recorded = await dependencies.suppress({
          id: email.id,
          leaseOwner: input.leaseOwner,
          ...(input.now ? { now: input.now } : {}),
        });
        if (!recorded) {
          throw new Error(
            "Customer email outbox lease was lost while suppressing delivery",
          );
        }
        suppressed += 1;
        continue;
      }
      if (!result.id?.trim()) markWriterOperationUncertain();
      const completed = await dependencies.complete({
        id: email.id,
        leaseOwner: input.leaseOwner,
        providerMessageId: result.id,
        ...(input.now ? { now: input.now } : {}),
        ...(result.completion
          ? {
              onCompleted: async (tx) => {
                const completedAt = input.now ?? new Date();
                if (result.completion?.type === "product_confirmation") {
                  const updated = await tx
                    .update(checkoutOrders)
                    .set({
                      productConfirmationEmailClaimedUntil: null,
                      productConfirmationEmailLastError: null,
                      productConfirmationEmailSentAt: completedAt,
                      updatedAt: completedAt,
                    })
                    .where(
                      eq(checkoutOrders.orderId, result.completion.orderId),
                    )
                    .returning({ id: checkoutOrders.id });
                  if (updated.length !== 1) markWriterOperationUncertain();
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
      markWriterOperationUncertain();
      failed += 1;
      const orderId =
        email.kind === "product_order_confirmation"
          ? getOrderId(email.payload)
          : null;
      if (orderId) {
        await dependencies
          .recordProductFailure({
            error:
              error instanceof Error ? error.message : "Unknown email error",
            orderId,
            ...(input.now ? { now: input.now } : {}),
          })
          .catch(() => undefined);
      }
      await dependencies.fail({
        id: email.id,
        leaseOwner: input.leaseOwner,
        error: error instanceof Error ? error.message : "Unknown email error",
        ...(input.now ? { now: input.now } : {}),
      });
    }
  }

  return {
    claimed: input.claimed.length,
    enqueued: input.enqueued,
    failed,
    sent,
    suppressed,
  };
}

async function deliverClaimedCustomerEmail(email: {
  kind: import("./customer-email-outbox").CustomerEmailOutboxKind;
  payload: unknown;
  providerIdempotencyKey: string;
  recipient: string;
}): Promise<
  | { suppressed: true }
  | {
      suppressed?: false;
      id: string;
      completion?:
        | { type: "product_confirmation"; orderId: string }
        | {
            type: "shipment_notification";
            shipmentId: string;
            kind: "accepted" | "exception" | "delivered";
          };
    }
> {
  switch (email.kind) {
    case "contact_popup_offer": {
      const payload = parseContactPopupOfferEmailPayload(email.payload);
      if (normalizeEmail(payload.recipientEmail) !== email.recipient) {
        throw new Error(
          "Customer email outbox recipient does not match payload",
        );
      }
      if (
        !(await isContactPopupOfferRecipientSubscribed(payload.recipientEmail))
      ) {
        return { suppressed: true };
      }
      return deliverContactPopupOfferEmail({
        ...payload,
        to: email.recipient,
        idempotencyKey: email.providerIdempotencyKey,
      });
    }
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

export function parseContactPopupOfferEmailPayload(
  value: unknown,
): ContactPopupOfferEmailPayload {
  const promotionCode = isRecord(value)
    ? parsePromotionCodeInput(value.promotionCode)
    : null;
  if (
    !isRecord(value) ||
    !isUuid(value.submissionId) ||
    !isEmail(value.recipientEmail) ||
    (value.customerName !== undefined &&
      !isBoundedNonEmptyString(
        value.customerName,
        CONTACT_POPUP_CUSTOMER_NAME_MAX_LENGTH,
      )) ||
    (value.variant !== "fullContact" && value.variant !== "emailOnly") ||
    !isBoundedNonEmptyString(
      value.promotionId,
      CONTACT_POPUP_OFFER_IDENTITY_MAX_LENGTH,
    ) ||
    !isBoundedNonEmptyString(
      value.promotionRevision,
      CONTACT_POPUP_OFFER_IDENTITY_MAX_LENGTH,
    ) ||
    promotionCode == null ||
    promotionCode !== value.promotionCode ||
    (value.discountType !== "percentage" && value.discountType !== "fixed") ||
    typeof value.discountAmount !== "number" ||
    !Number.isFinite(value.discountAmount) ||
    value.discountAmount <= 0 ||
    (value.discountType === "percentage" && value.discountAmount > 100) ||
    value.appliesTo !== "all" ||
    !isBoundedNonEmptyString(
      value.offerLabel,
      CONTACT_POPUP_OFFER_LABEL_MAX_LENGTH,
    ) ||
    !isBoundedNonEmptyString(
      value.offerTerms,
      CONTACT_POPUP_OFFER_TERMS_MAX_LENGTH,
    ) ||
    !isBoundedNonEmptyString(
      value.ctaLabel,
      CONTACT_POPUP_OFFER_CTA_LABEL_MAX_LENGTH,
    ) ||
    !isHttpsUrl(value.ctaUrl) ||
    !isIsoTimestamp(value.resolvedAt)
  ) {
    throw new Error("Malformed contact popup offer outbox payload");
  }
  return {
    submissionId: value.submissionId,
    recipientEmail: normalizeEmail(value.recipientEmail),
    ...(value.customerName === undefined
      ? {}
      : { customerName: value.customerName.trim() }),
    variant: value.variant,
    promotionId: value.promotionId,
    promotionRevision: value.promotionRevision,
    promotionCode,
    discountType: value.discountType,
    discountAmount: value.discountAmount,
    appliesTo: value.appliesTo,
    offerLabel: value.offerLabel,
    offerTerms: value.offerTerms,
    ctaLabel: value.ctaLabel,
    ctaUrl: value.ctaUrl,
    resolvedAt: value.resolvedAt,
  };
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

function isBoundedNonEmptyString(
  value: unknown,
  maxLength: number,
): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength
  );
}

function isEmail(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > CONTACT_POPUP_CUSTOMER_EMAIL_MAX_LENGTH
  ) {
    return false;
  }
  const normalized = normalizeEmail(value);
  const separator = normalized.lastIndexOf("@");
  return separator > 0 && separator < normalized.length - 1;
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function isHttpsUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > CONTACT_POPUP_OFFER_CTA_URL_MAX_LENGTH
  ) {
    return false;
  }
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = new Date(value);
  return (
    Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value
  );
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
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
