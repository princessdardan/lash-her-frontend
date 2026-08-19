import "server-only";

import { ShippingQuoteConflictError } from "@/lib/shipping/errors";

import { createHash, createHmac } from "node:crypto";

import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

import type {
  CheckoutOrderLineItemSnapshot,
  CheckoutProviderMetadata,
  CheckoutOrderPurpose,
  CheckoutPaymentEventPayload,
  CheckoutOrderShippingAddressSnapshot,
  PaymentEventProcessingStatus,
  PaymentRiskStatus,
  PaymentProvider,
} from "@/lib/private-db/schema";
import { getCheckoutSecretEncryptionKey } from "@/sanity/env";
import {
  checkoutOrders,
  checkoutPaymentEvents,
  fulfillmentDataQuarantine,
  orderPaymentObligations,
  productShipments,
} from "@/lib/private-db/schema";
import { getPrivateDb } from "@/lib/private-db/client";

import type { ValidatedCart } from "./cart";
import {
  decryptCheckoutSecret,
  encryptCheckoutSecret,
} from "./checkout-secret";
import { parseCad } from "./money";
import {
  hashShippingQuoteToken,
  parseShippingQuoteContextSnapshot,
} from "@/lib/shipping/quote-token";
import { encryptCheckoutIp } from "./checkout-pii";
import { classifyHelcimTransaction } from "./helcim-contract";
import {
  assertCheckoutReadiness,
  assertHelcimProductPaymentsCertificationInTransaction,
  assertManualCheckoutReadinessInTransaction,
  assertProductTaxPolicyApprovalInTransaction,
  assertShippingQuoteContextAtCheckoutCommit,
  evaluateManualCheckoutReadiness,
} from "@/lib/shipping/readiness";
import { enqueueCustomerEmail } from "./customer-email-outbox";
import {
  assertProductTaxPolicyVersionImplemented,
  calculateProductTax,
  STUDIO_PICKUP_TAX_JURISDICTION,
} from "./product-tax-policy";
import { getProductCheckoutTermsRequirement } from "./product-checkout-terms";
import { getShippedRefundPolicyRequirement } from "./product-shipped-refund-policy";

export interface UsImportDisclosureSnapshot {
  terms: "DDU";
  version: string;
  text: string;
  presentedAt: Date;
}

/**
 * Customer acceptance of the source-controlled Terms of sale, captured at
 * checkout for Ontario Reg. 17/05 provability. `requestEvidence` ties the
 * assent to the checkout request that produced it (same value as the
 * cancellation-policy evidence for manual orders).
 */
export interface ProductCheckoutTermsAssentInput {
  accepted: true;
  version: string;
  textHash: string;
  presentedAt: Date;
  requestEvidence: string;
}

const CHECKOUT_REQUEST_EVIDENCE_PATTERN =
  /^checkout_post:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Re-validates the accepted Terms assent against the current source-controlled
 * requirement (version + SHA-256 of text) and returns the JSON snapshot to
 * persist. Throws if acceptance is missing or does not match — order creation
 * must not proceed without a provable, current assent.
 */
function buildProductCheckoutTermsSnapshot(
  input: ProductCheckoutTermsAssentInput,
  now: Date,
): Record<string, string | boolean> {
  const requirement = getProductCheckoutTermsRequirement();
  if (
    input.accepted !== true ||
    input.version !== requirement.version ||
    input.textHash !== requirement.textHash ||
    !CHECKOUT_REQUEST_EVIDENCE_PATTERN.test(input.requestEvidence)
  ) {
    throw new Error(
      "Checkout terms acceptance is required and must match the current terms",
    );
  }
  return {
    accepted: true,
    version: requirement.version,
    text: requirement.text,
    textHash: requirement.textHash,
    presentedAt: input.presentedAt.toISOString(),
    acceptedAt: now.toISOString(),
    requestEvidence: input.requestEvidence,
  };
}

/**
 * Re-validates the accepted shipped-order refund policy against the current
 * source-controlled requirement (version + SHA-256 of text) and returns the JSON
 * snapshot to persist in the shared `cancellationPolicySnapshot` column. Throws
 * if acceptance is missing or does not match — shipped order creation must not
 * proceed without a provable, current refund-policy assent (the shipped-order
 * counterpart to the manual-pickup cancellation policy).
 */
function buildShippedRefundPolicySnapshot(
  input: ProductRefundPolicyAssentInput,
  now: Date,
): Record<string, string | boolean> {
  const requirement = getShippedRefundPolicyRequirement();
  if (
    input.accepted !== true ||
    input.version !== requirement.version ||
    input.textHash !== requirement.textHash ||
    !CHECKOUT_REQUEST_EVIDENCE_PATTERN.test(input.requestEvidence)
  ) {
    throw new Error(
      "Checkout refund-policy acceptance is required and must match the current policy",
    );
  }
  return {
    accepted: true,
    version: requirement.version,
    text: requirement.text,
    textHash: requirement.textHash,
    presentedAt: input.presentedAt.toISOString(),
    acceptedAt: now.toISOString(),
    requestEvidence: input.requestEvidence,
  };
}

const EMAIL_CLAIM_DURATION_MS = 5 * 60 * 1000;

export interface CreatePendingOrderInput {
  customerName: string;
  customerEmail: string;
  checkoutToken: string;
  secretToken: string;
  helcimInvoiceId: number;
  helcimInvoiceNumber: string;
  purpose?: CheckoutOrderPurpose;
  cart: ValidatedCart;
  shippingAddress?: CheckoutOrderShippingAddressSnapshot;
}

export interface CreateInitializingProductOrderInput {
  customerName: string;
  customerEmail: string;
  /**
   * Payment gateway for this order. Defaults to "helcim" for the legacy
   * async-invoice flow; "square" reserves the order ready for the synchronous
   * Web Payments SDK charge (no provider invoice pre-initialization, and no
   * Helcim certified-contract gate).
   */
  provider?: PaymentProvider;
  cart: ValidatedCart;
  shippingAddress: CheckoutOrderShippingAddressSnapshot;
  shippingQuoteToken: string;
  shippingQuoteFingerprint: string;
  shippingRateId: string;
  refundOriginIp: string;
  termsAssent: ProductCheckoutTermsAssentInput;
  /**
   * Shipped-order refund/cancellation policy the customer accepted at checkout,
   * re-validated against the current source-controlled requirement and stored on
   * the order (same columns as the manual-pickup cancellation policy).
   */
  refundPolicy: ProductRefundPolicyAssentInput;
  usImportDisclosure?: UsImportDisclosureSnapshot;
}

export interface ProductRefundPolicyAssentInput {
  accepted: true;
  version: string;
  textHash: string;
  presentedAt: Date;
  requestEvidence: string;
}

export interface InitializingProductOrderRecord {
  databaseId: string;
  orderId: string;
  primaryObligationId: string;
  currency: ValidatedCart["currency"];
  merchandiseAmountCents: number;
  shippingAmountCents: number;
  taxAmountCents: number;
  totalAmountCents: number;
  shippingRateTitle: string;
}

export interface CreateInitializingManualProductOrderInput {
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
  cart: ValidatedCart;
  fulfillmentMode: "manual_pickup";
  cancellationPolicy: {
    accepted: true;
    version: string;
    textHash: string;
    presentedAt: Date;
    requestEvidence: string;
  };
  termsAssent: ProductCheckoutTermsAssentInput;
  usImportDisclosure?: UsImportDisclosureSnapshot;
  refundOriginIp: string;
}

export interface CreatePendingSquareInvoiceOrderInput {
  amountCents: number;
  checkoutToken: string;
  correlationId: string;
  customerEmail: string;
  customerName: string;
  programSlug: string;
  secretToken: string;
  squareCustomerId: string;
  squareInvoiceId: string;
  squareInvoicePublicUrl?: string;
  squareInvoiceVersion?: number;
  squareOrderId: string;
}

export type SquareInvoiceFinalizationStatus = "pending" | "failed" | "paid";

export interface SquareInvoiceProviderMetadata extends CheckoutProviderMetadata {
  amountCents: number;
  correlationId: string;
  currency: "CAD";
  finalizationError?: string;
  finalizationRetryable?: boolean;
  finalizationStatus: SquareInvoiceFinalizationStatus;
  flow: "training_square_invoice";
  programSlug: string;
  squareCustomerId: string;
  squareInvoicePublicUrl: string | null;
  squareInvoiceVersion: number | null;
}

/**
 * Provider metadata for a primary-training order paid through the embedded
 * Square Web Payments SDK card flow (distinct from the Afterpay/BNPL invoice
 * flow above).
 */
export interface SquareCardProviderMetadata extends CheckoutProviderMetadata {
  amountCents: number;
  correlationId: string;
  currency: "CAD";
  finalizationStatus: SquareInvoiceFinalizationStatus;
  flow: "training_square_card";
  programSlug: string;
}

export interface CreatePendingSquareTrainingCardOrderInput {
  customerName: string;
  customerEmail: string;
  programSlug: string;
  amountCents: number;
  merchandiseAmountCents: number;
  taxAmountCents: number;
  cart: ValidatedCart;
}

export interface PendingSquareTrainingCardOrderRecord {
  databaseId: string;
  orderId: string;
}

export interface PendingOrderRecord {
  _id: string;
  orderId: string;
  secretToken: string;
  helcimInvoiceId: number | null;
  helcimInvoiceNumber: string | null;
  amount: number;
  currency: ValidatedCart["currency"];
  customerEmail: string;
  customerName: string;
  lineItems: CheckoutOrderLineItemSnapshot[];
  paymentProvider: PaymentProvider;
  purpose: CheckoutOrderPurpose;
  shippingAddress: CheckoutOrderShippingAddressSnapshot | null;
  paymentObligationId?: string;
}

export interface MatchedCheckoutOrderRecord {
  _id: string;
  amount: number;
  currency: ValidatedCart["currency"];
  helcimInvoiceId: number | null;
  helcimInvoiceNumber: string | null;
  orderId: string;
  paymentProvider: PaymentProvider;
  purpose: CheckoutOrderPurpose;
  paymentObligationId?: string;
}

export interface HelcimWebhookEventRecordResult {
  matchedOrder: MatchedCheckoutOrderRecord | null;
  paid: boolean;
  recorded: boolean;
}

export interface HelcimWebhookEventInput {
  amount?: number | string;
  currency?: string;
  eventId: string;
  eventType: string;
  helcimInvoiceId?: number;
  helcimInvoiceNumber?: string;
  helcimTransactionId?: string;
  originalTransactionId?: string;
  payloadRedacted?: Record<string, unknown>;
  status?: string;
  transactionType?: string;
}

export type HelcimPurchaseTransitionResult =
  | "applied"
  | "already_applied"
  | "state_conflict"
  | "transaction_conflict"
  | "not_found";

export interface ClaimProductOrderConfirmationEmailInput {
  claimForMs?: number;
  now?: Date;
  orderId: string;
}

export interface ProductOrderConfirmationEmailRecord {
  orderDatabaseId: string;
  currency: ValidatedCart["currency"];
  customerEmail: string;
  customerName: string;
  lineItems: CheckoutOrderLineItemSnapshot[];
  merchandiseAmount: number;
  orderId: string;
  shippingAmount: number;
  shippingAddress: CheckoutOrderShippingAddressSnapshot | null;
  totalAmount: number;
  paymentRiskStatus: PaymentRiskStatus;
  promotionCode: string | null;
  promotionDiscount: number;
  manualDiscount: number;
  taxAmount: number;
  fulfillmentMode: CheckoutOrderRow["fulfillmentMode"];
  manualFulfillmentStatus: string | null;
  cancellationPolicySnapshot: Record<string, unknown> | null;
  usImportDisclosure: CheckoutOrderRow["usImportDisclosureSnapshot"];
  termsSnapshot: CheckoutOrderRow["termsSnapshot"];
}

export interface ProductOrderConfirmationEmailFailureInput {
  error: string;
  now?: Date;
  orderId: string;
}

export interface SquareInvoiceWebhookEventInput {
  eventId: string;
  eventType: string;
  orderDatabaseId?: string;
  payloadSanitized?: CheckoutPaymentEventPayload;
  providerCheckoutId?: string;
  providerOrderId?: string;
  providerPaymentId?: string;
  status?: string;
}

export type SquareInvoiceWebhookEventClaimResult =
  | { duplicate: false }
  | { duplicate: true; processingStatus: PaymentEventProcessingStatus };

export type CheckoutOrderRow = typeof checkoutOrders.$inferSelect;
type CheckoutOrderBaseInsert = {
  amountCents: number;
  checkoutTokenHash: string;
  currency: ValidatedCart["currency"];
  customerEmail: string;
  customerName: string;
  helcimInvoiceId?: number | null;
  helcimInvoiceNumber?: string | null;
  lineItems: CheckoutOrderLineItemSnapshot[];
  orderId: string;
  paymentProvider: PaymentProvider;
  providerCheckoutId?: string | null;
  providerMetadata?: CheckoutProviderMetadata;
  providerOrderId?: string | null;
  providerPaymentId?: string | null;
  providerStatus?: string | null;
  purpose: CheckoutOrderPurpose;
  secretTokenCiphertext: string;
  shippingAddress?: CheckoutOrderShippingAddressSnapshot;
  status: "pending";
};
type HelcimCheckoutOrderInsert = CheckoutOrderBaseInsert & {
  helcimInvoiceId: number;
  helcimInvoiceNumber: string;
  paymentProvider: "helcim";
};
type SquareInvoiceCheckoutOrderInsert = CheckoutOrderBaseInsert & {
  currency: "CAD";
  paymentProvider: "square";
  providerCheckoutId: string;
  providerMetadata: SquareInvoiceProviderMetadata;
  providerOrderId: string;
  providerStatus: "draft" | "published" | "paid" | "finalization_failed";
  purpose: "training";
};
type CheckoutOrderInsert =
  | HelcimCheckoutOrderInsert
  | SquareInvoiceCheckoutOrderInsert;
type CheckoutPaymentEventInsert = {
  amountCents: number | null;
  currency: string | undefined;
  eventType: string;
  helcimTransactionId: string | undefined;
  idempotencyKey: string;
  orderId: string | null;
  payloadRedacted: Record<string, unknown> | undefined;
  processingStatus?: PaymentEventProcessingStatus;
  status: string | undefined;
};

export interface CheckoutOrderRepository {
  createCheckoutOrder(values: CheckoutOrderInsert): Promise<{ id: string }>;
  createSquareInvoiceWebhookEvent(
    values: SquareInvoiceWebhookEventInput,
  ): Promise<{ id: string } | null>;
  createWebhookEvent(
    values: CheckoutPaymentEventInsert,
  ): Promise<{ id: string } | null>;
  claimProductOrderConfirmationEmail(input: {
    claimUntil: Date;
    now: Date;
    orderId: string;
  }): Promise<CheckoutOrderRow | null>;
  findSquareInvoiceWebhookEventClaim(
    eventId: string,
  ): Promise<SquareInvoiceWebhookEventClaimResult>;
  findOrderForWebhook(
    input: HelcimWebhookEventInput,
  ): Promise<CheckoutOrderRow | null>;
  findCheckoutOrderByCheckoutTokenHash(
    checkoutTokenHash: string,
  ): Promise<CheckoutOrderRow | null>;
  findPaymentObligationByCheckoutTokenHash?: (
    checkoutTokenHash: string,
  ) => Promise<{
    order: CheckoutOrderRow;
    obligation: typeof orderPaymentObligations.$inferSelect;
  } | null>;
  findPaymentObligationForWebhook?: (
    input: HelcimWebhookEventInput,
  ) => Promise<{
    order: CheckoutOrderRow;
    obligationId: string;
  } | null>;
  findOrderByCorrelationId(
    correlationId: string,
  ): Promise<CheckoutOrderRow | null>;
  findOrderBySquareInvoiceId(
    invoiceId: string,
  ): Promise<CheckoutOrderRow | null>;
  markOrderPaid(
    orderId: string,
    helcimTransactionId: string,
  ): Promise<HelcimPurchaseTransitionResult>;
  markOrderVerificationFailed(orderId: string): Promise<void>;
  markProductOrderConfirmationEmailSent(
    orderId: string,
    now: Date,
  ): Promise<void>;
  recordProductOrderConfirmationEmailFailure(
    orderId: string,
    error: string,
    now: Date,
  ): Promise<void>;
  markSquareInvoiceFinalizationFailed(
    orderId: string,
    error: string,
    retryable: boolean,
  ): Promise<void>;
  markSquareInvoicePaid(orderId: string, paymentId: string): Promise<void>;
  recordSquareInvoicePublication(
    orderId: string,
    invoiceId: string,
    publicUrl: string,
    version: number,
  ): Promise<void>;
  updateSquareInvoiceWebhookEvent(
    values: SquareInvoiceWebhookEventInput,
    processingStatus: PaymentEventProcessingStatus,
  ): Promise<void>;
}

export interface CheckoutOrderStore {
  createPendingOrder(
    input: CreatePendingOrderInput,
  ): Promise<PendingOrderRecord>;
  createPendingSquareInvoiceOrder(
    input: CreatePendingSquareInvoiceOrderInput,
  ): Promise<PendingOrderRecord>;
  findOrderByCorrelationId(
    correlationId: string,
  ): Promise<CheckoutOrderRow | null>;
  findOrderBySquareInvoiceId(
    invoiceId: string,
  ): Promise<CheckoutOrderRow | null>;
  claimProductOrderConfirmationEmail(
    input: ClaimProductOrderConfirmationEmailInput,
  ): Promise<ProductOrderConfirmationEmailRecord | null>;
  getPendingOrderByCheckoutToken(
    checkoutToken: string,
  ): Promise<PendingOrderRecord | null>;
  markOrderPaid(
    orderId: string,
    helcimTransactionId: string,
  ): Promise<HelcimPurchaseTransitionResult>;
  markOrderVerificationFailed(orderId: string): Promise<void>;
  markProductOrderConfirmationEmailSent(
    orderId: string,
    now?: Date,
  ): Promise<void>;
  recordProductOrderConfirmationEmailFailure(
    input: ProductOrderConfirmationEmailFailureInput,
  ): Promise<void>;
  markSquareInvoiceFinalizationFailed(
    orderId: string,
    error: string,
    retryable: boolean,
  ): Promise<void>;
  markSquareInvoicePaid(orderId: string, paymentId: string): Promise<void>;
  recordSquareInvoicePublication(
    orderId: string,
    invoiceId: string,
    publicUrl: string,
    version: number,
  ): Promise<void>;
  recordHelcimWebhookEvent(input: HelcimWebhookEventInput): Promise<boolean>;
  recordHelcimWebhookEventWithOrder(
    input: HelcimWebhookEventInput,
  ): Promise<HelcimWebhookEventRecordResult>;
  claimSquareInvoiceWebhookEvent(
    input: SquareInvoiceWebhookEventInput,
  ): Promise<SquareInvoiceWebhookEventClaimResult>;
  recordSquareInvoiceWebhookEventProcessed(
    input: SquareInvoiceWebhookEventInput,
  ): Promise<void>;
}

export function createCheckoutOrderStore(
  repository: CheckoutOrderRepository,
): CheckoutOrderStore {
  return {
    async createPendingOrder(input) {
      const orderId = `lh-${nanoid(12)}`;
      const secretTokenCiphertext = encryptCheckoutSecret(input.secretToken);
      const checkoutTokenHash = hashCheckoutToken(input.checkoutToken);
      const amountCents = toCents(input.cart.amount);
      const promotionDiscountCents =
        input.cart.promotionDiscountAmount === undefined
          ? undefined
          : toCents(input.cart.promotionDiscountAmount);
      const lineItems = input.cart.lineItems.map((lineItem) => ({
        productId: lineItem.productId,
        ...(lineItem.variantId ? { variantId: lineItem.variantId } : {}),
        sku: lineItem.sku,
        description: lineItem.description,
        productTitle: lineItem.productTitle,
        ...(lineItem.variantTitle
          ? { variantTitle: lineItem.variantTitle }
          : {}),
        ...(lineItem.selectedOptions?.length
          ? { selectedOptions: lineItem.selectedOptions }
          : {}),
        ...(lineItem.checkoutMode
          ? { fulfillmentMode: lineItem.checkoutMode }
          : {}),
        quantity: lineItem.quantity,
        unitPriceCents: toCents(lineItem.price),
        ...(lineItem.originalPrice !== undefined
          ? { originalUnitPriceCents: toCents(lineItem.originalPrice) }
          : {}),
        ...(lineItem.manualDiscount !== undefined
          ? { manualDiscountCents: toCents(lineItem.manualDiscount) }
          : {}),
        ...(input.cart.promotionCode
          ? { promotionCode: input.cart.promotionCode }
          : {}),
        ...(promotionDiscountCents !== undefined
          ? { promotionDiscountCents }
          : {}),
        totalCents: toCents(lineItem.total),
        ...(lineItem.originalTotal !== undefined
          ? { originalTotalCents: toCents(lineItem.originalTotal) }
          : {}),
      }));

      const createdOrder = await repository.createCheckoutOrder({
        orderId,
        status: "pending",
        checkoutTokenHash,
        secretTokenCiphertext,
        helcimInvoiceId: input.helcimInvoiceId,
        helcimInvoiceNumber: input.helcimInvoiceNumber,
        customerName: input.customerName,
        customerEmail: input.customerEmail,
        purpose: input.purpose ?? "product",
        amountCents,
        ...(input.purpose === undefined || input.purpose === "product"
          ? {
              merchandiseAmountCents: amountCents,
              promotionCode: input.cart.promotionCode ?? null,
              promotionDiscountCents: toCents(
                input.cart.promotionDiscountAmount ?? 0,
              ),
              manualDiscountCents: toCents(
                input.cart.manualDiscountAmount ?? 0,
              ),
              taxAmountCents: 0,
            }
          : {}),
        currency: input.cart.currency,
        lineItems,
        paymentProvider: "helcim",
        ...(input.shippingAddress
          ? { shippingAddress: input.shippingAddress }
          : {}),
      });

      return {
        _id: createdOrder.id,
        orderId,
        secretToken: input.secretToken,
        helcimInvoiceId: input.helcimInvoiceId,
        helcimInvoiceNumber: input.helcimInvoiceNumber,
        amount: input.cart.amount,
        currency: input.cart.currency,
        customerEmail: input.customerEmail,
        customerName: input.customerName,
        lineItems,
        paymentProvider: "helcim",
        purpose: input.purpose ?? "product",
        shippingAddress: input.shippingAddress ?? null,
      };
    },

    async createPendingSquareInvoiceOrder(input) {
      const existingByInvoice = await repository.findOrderBySquareInvoiceId(
        input.squareInvoiceId,
      );

      if (existingByInvoice) {
        return toPendingOrderRecord(existingByInvoice);
      }

      const existingByCorrelation = await repository.findOrderByCorrelationId(
        input.correlationId,
      );

      if (existingByCorrelation) {
        return toPendingOrderRecord(existingByCorrelation);
      }

      const orderId = `lh-${nanoid(12)}`;
      const secretTokenCiphertext = encryptCheckoutSecret(input.secretToken);
      const checkoutTokenHash = hashCheckoutToken(input.checkoutToken);
      const lineItems = createTrainingInvoiceLineItems(input);
      const providerMetadata = createSquareInvoiceProviderMetadata(input);

      const createdOrder = await repository.createCheckoutOrder({
        amountCents: input.amountCents,
        checkoutTokenHash,
        currency: "CAD",
        customerEmail: input.customerEmail,
        customerName: input.customerName,
        helcimInvoiceId: null,
        helcimInvoiceNumber: null,
        lineItems,
        orderId,
        paymentProvider: "square",
        providerCheckoutId: input.squareInvoiceId,
        providerMetadata,
        providerOrderId: input.squareOrderId,
        providerStatus: "draft",
        purpose: "training",
        secretTokenCiphertext,
        status: "pending",
      });

      return {
        _id: createdOrder.id,
        orderId,
        secretToken: input.secretToken,
        helcimInvoiceId: null,
        helcimInvoiceNumber: null,
        amount: centsToCad(input.amountCents),
        currency: "CAD",
        customerEmail: input.customerEmail,
        customerName: input.customerName,
        lineItems,
        paymentProvider: "square",
        purpose: "training",
        shippingAddress: null,
      };
    },

    async recordSquareInvoicePublication(
      orderId,
      invoiceId,
      publicUrl,
      version,
    ) {
      await repository.recordSquareInvoicePublication(
        orderId,
        invoiceId,
        publicUrl,
        version,
      );
    },

    async markSquareInvoicePaid(orderId, paymentId) {
      await repository.markSquareInvoicePaid(orderId, paymentId);
    },

    async markSquareInvoiceFinalizationFailed(orderId, error, retryable) {
      await repository.markSquareInvoiceFinalizationFailed(
        orderId,
        error,
        retryable,
      );
    },

    async findOrderBySquareInvoiceId(invoiceId) {
      return repository.findOrderBySquareInvoiceId(invoiceId);
    },

    async claimProductOrderConfirmationEmail(input) {
      const now = input.now ?? new Date();
      const claimUntil = new Date(
        now.getTime() + (input.claimForMs ?? EMAIL_CLAIM_DURATION_MS),
      );
      const claimedOrder = await repository.claimProductOrderConfirmationEmail({
        claimUntil,
        now,
        orderId: input.orderId,
      });

      return claimedOrder === null
        ? null
        : toProductOrderConfirmationEmailRecord(claimedOrder);
    },

    async findOrderByCorrelationId(correlationId) {
      return repository.findOrderByCorrelationId(correlationId);
    },

    async markOrderPaid(orderId, helcimTransactionId) {
      return repository.markOrderPaid(orderId, helcimTransactionId);
    },

    async markOrderVerificationFailed(orderId) {
      await repository.markOrderVerificationFailed(orderId);
    },

    async markProductOrderConfirmationEmailSent(orderId, now = new Date()) {
      await repository.markProductOrderConfirmationEmailSent(orderId, now);
    },

    async recordProductOrderConfirmationEmailFailure(input) {
      await repository.recordProductOrderConfirmationEmailFailure(
        input.orderId,
        input.error,
        input.now ?? new Date(),
      );
    },

    async getPendingOrderByCheckoutToken(checkoutToken) {
      const checkoutTokenHash = hashCheckoutToken(checkoutToken);
      const order =
        await repository.findCheckoutOrderByCheckoutTokenHash(
          checkoutTokenHash,
        );

      if (order && isCheckoutTokenValidationEligible(order)) {
        return toPendingOrderRecord(order);
      }
      const supplemental =
        await repository.findPaymentObligationByCheckoutTokenHash?.(
          checkoutTokenHash,
        );
      if (
        !supplemental ||
        supplemental.order.fulfillmentQuarantinedAt !== null ||
        supplemental.order.purpose !== "product" ||
        !["paid", "cancelled", "refunded"].includes(
          supplemental.order.status,
        ) ||
        supplemental.obligation.purpose === "primary" ||
        !["pending", "expired", "superseded", "cancelled", "refunded"].includes(
          supplemental.obligation.status,
        ) ||
        supplemental.obligation.initializationStatus !== "ready" ||
        supplemental.obligation.quarantinedAt !== null
      ) {
        return null;
      }
      if (
        !supplemental.obligation.secretTokenCiphertext ||
        supplemental.obligation.providerInvoiceId === null ||
        supplemental.obligation.providerInvoiceNumber === null
      ) {
        return null;
      }
      return {
        ...toPendingOrderRecord(supplemental.order),
        paymentObligationId: supplemental.obligation.id,
        secretToken: decryptCheckoutSecret(
          supplemental.obligation.secretTokenCiphertext,
        ),
        helcimInvoiceId: supplemental.obligation.providerInvoiceId,
        helcimInvoiceNumber: supplemental.obligation.providerInvoiceNumber,
        amount: centsToCad(supplemental.obligation.totalAmountCents),
        currency: supplemental.obligation.currency.toUpperCase() as "CAD",
      };
    },

    async recordHelcimWebhookEvent(input) {
      const result = await recordHelcimWebhookEventWithOrderInternal(
        repository,
        input,
      );
      return result.recorded;
    },

    async recordHelcimWebhookEventWithOrder(input) {
      return recordHelcimWebhookEventWithOrderInternal(repository, input);
    },

    async claimSquareInvoiceWebhookEvent(input) {
      const createdEvent =
        await repository.createSquareInvoiceWebhookEvent(input);

      if (createdEvent !== null) {
        return { duplicate: false };
      }

      return repository.findSquareInvoiceWebhookEventClaim(input.eventId);
    },

    async recordSquareInvoiceWebhookEventProcessed(input) {
      await repository.updateSquareInvoiceWebhookEvent(input, "processed");
    },
  };
}

const defaultOrderStore = createCheckoutOrderStore(
  createDrizzleCheckoutOrderRepository(),
);

export async function createPendingOrder(
  input: CreatePendingOrderInput,
): Promise<PendingOrderRecord> {
  return defaultOrderStore.createPendingOrder(input);
}

export async function createInitializingProductOrder(
  input: CreateInitializingProductOrderInput,
): Promise<InitializingProductOrderRecord> {
  const db = getPrivateDb();
  const now = new Date();
  const destinationCountryCode =
    input.shippingAddress.countryCode === "US" ? "US" : "CA";
  if (
    (destinationCountryCode === "US" &&
      !isValidUsImportDisclosure(input.usImportDisclosure)) ||
    (destinationCountryCode !== "US" && input.usImportDisclosure !== undefined)
  ) {
    throw new ShippingQuoteConflictError(
      "Required import-cost disclosure does not match the shipping quote",
    );
  }
  const termsSnapshot = buildProductCheckoutTermsSnapshot(
    input.termsAssent,
    now,
  );
  const refundPolicySnapshot = buildShippedRefundPolicySnapshot(
    input.refundPolicy,
    now,
  );
  const readiness = await assertCheckoutReadiness({ destinationCountryCode });
  const quoteContext = readiness.quoteContext;
  if (!quoteContext) {
    throw new ShippingQuoteConflictError(
      "Shipping quote context is unavailable",
    );
  }
  return db.transaction(async (tx) => {
    const commitReadiness = await assertShippingQuoteContextAtCheckoutCommit(
      tx,
      {
        destinationCountryCode,
        expectedContext: quoteContext,
        now,
      },
    );
    const provider: PaymentProvider = input.provider ?? "helcim";
    // Square commerce runs under the lighter verified-payment fulfillment gate,
    // so it does not require (or record) the Helcim certified-contract snapshot.
    const helcimContract =
      provider === "square"
        ? null
        : await assertHelcimProductPaymentsCertificationInTransaction(tx, now);
    const [quote] = await tx
      .select()
      .from(productShipments)
      .where(
        and(
          eq(
            productShipments.quoteTokenHash,
            hashShippingQuoteToken(input.shippingQuoteToken),
          ),
          eq(productShipments.quoteFingerprint, input.shippingQuoteFingerprint),
          eq(productShipments.status, "quoted"),
          isNull(productShipments.orderId),
          sql`${productShipments.quoteExpiresAt} > ${now}`,
        ),
      )
      .for("update")
      .limit(1);
    if (!quote)
      throw new ShippingQuoteConflictError("Shipping quote expired or changed");
    const quoteContextSnapshot = parseShippingQuoteContextSnapshot(
      quote.deadlinePolicySnapshot,
    );
    // Config-driven change-detection: the stored snapshot's policy/tax versions
    // must still match the current context. Deep-equality is intentionally not
    // used — the snapshot's closureDates are `now`-derived and would spuriously
    // differ across the quote→commit gap. The authoritative config-version check
    // runs in assertShippingQuoteContextAtCheckoutCommit below.
    if (
      !quoteContextSnapshot ||
      quoteContextSnapshot.policyVersion !== quoteContext.policyVersion ||
      quoteContextSnapshot.taxPolicyVersion !== quoteContext.taxPolicyVersion
    ) {
      throw new ShippingQuoteConflictError(
        "Shipping quote policy or calendar context changed",
      );
    }
    await assertProductTaxPolicyApprovalInTransaction(
      tx,
      quoteContextSnapshot.taxPolicyApproval,
      now,
    );
    const rate = quote.rates.find(
      (candidate) => candidate.id === input.shippingRateId,
    );
    if (!rate || !rate.insured || !rate.tracked)
      throw new ShippingQuoteConflictError(
        "Selected shipping service is unavailable",
      );

    const orderId = `lh-${nanoid(12)}`;
    const merchandiseAmountCents = toCents(input.cart.amount);
    const shippingAmountCents = rate.paymentAmountCents;
    assertProductTaxPolicyVersionImplemented(commitReadiness.taxPolicyVersion!);
    // Shipping is taxable in Canada at the destination rate, so tax on the
    // combined merchandise + shipping base. US destinations collect no tax.
    const taxQuote = calculateProductTax({
      destinationCountry: destinationCountryCode,
      destinationRegionCode: input.shippingAddress.province,
      taxableAmountCents: merchandiseAmountCents + shippingAmountCents,
    });
    const taxAmountCents = taxQuote.taxAmountCents;
    const totalAmountCents =
      merchandiseAmountCents + shippingAmountCents + taxAmountCents;
    const [order] = await tx
      .insert(checkoutOrders)
      .values({
        orderId,
        status: "pending",
        initializationStatus: provider === "square" ? "ready" : "initializing",
        checkoutTokenHash: null,
        secretTokenCiphertext: null,
        helcimInvoiceId: null,
        helcimInvoiceNumber: null,
        customerName: input.customerName,
        customerEmail: input.customerEmail,
        purpose: "product",
        amountCents: totalAmountCents,
        merchandiseAmountCents,
        shippingAmountCents,
        promotionCode: input.cart.promotionCode ?? null,
        promotionDiscountCents: toCents(
          input.cart.promotionDiscountAmount ?? 0,
        ),
        manualDiscountCents: toCents(input.cart.manualDiscountAmount ?? 0),
        taxAmountCents,
        currency: input.cart.currency,
        lineItems: toOrderLineItemSnapshots(input.cart),
        paymentProvider: provider,
        shippingAddress: input.shippingAddress,
        refundOriginIpCiphertext: encryptCheckoutIp(input.refundOriginIp),
        atRiskValueCents: merchandiseAmountCents,
        fraudClassification: "low",
        paymentRiskStatus: "pending",
        shippingPolicyVersion: commitReadiness.policyVersion!,
        taxPolicyVersion: commitReadiness.taxPolicyVersion,
        dduNoticeVersion:
          input.usImportDisclosure?.terms === "DDU"
            ? input.usImportDisclosure.version
            : null,
        dduNoticePresentedAt:
          input.usImportDisclosure?.terms === "DDU"
            ? input.usImportDisclosure.presentedAt
            : undefined,
        usImportDisclosureSnapshot: input.usImportDisclosure
          ? toStoredUsImportDisclosure(input.usImportDisclosure)
          : undefined,
        termsVersion: termsSnapshot.version as string,
        termsAcceptedAt: now,
        termsSnapshot,
        cancellationPolicyVersion: refundPolicySnapshot.version as string,
        cancellationPolicySnapshot: refundPolicySnapshot,
        fulfillmentMode: "automated_shipping",
      })
      .returning({ id: checkoutOrders.id });
    const [attached] = await tx
      .update(productShipments)
      .set({
        orderId: order.id,
        selectedRateId: rate.id,
        selectedPostageType: rate.postageType,
        quotedShippingCents: rate.paymentAmountCents,
        status: "payment_pending",
        signatureRequired: rate.signatureRequired,
        signatureRequested: rate.signatureRequired,
        deliveryMaxBusinessDays: rate.deliveryMaxBusinessDays,
        latestEstimatedDeliveryAt: rate.estimatedDeliveryAt
          ? new Date(rate.estimatedDeliveryAt)
          : null,
        updatedAt: now,
      })
      .where(
        and(
          eq(productShipments.id, quote.id),
          isNull(productShipments.orderId),
        ),
      )
      .returning({ id: productShipments.id });
    if (!attached)
      throw new ShippingQuoteConflictError("Shipping quote was already used");
    await tx
      .update(checkoutOrders)
      .set({ activeFulfillmentShipmentId: attached.id, updatedAt: now })
      .where(eq(checkoutOrders.id, order.id));
    const [obligation] = await tx
      .insert(orderPaymentObligations)
      .values({
        orderId: order.id,
        purpose: "primary",
        status: "pending",
        merchandiseAmountCents,
        shippingAmountCents,
        taxAmountCents,
        totalAmountCents,
        currency: input.cart.currency,
        paymentProvider: provider,
        sourceWorkflow: "automated_product_checkout",
        disclosureSnapshot: {
          ...(helcimContract ? { helcimContract } : {}),
          shippingQuoteContext: quoteContextSnapshot,
          tax: taxQuote,
          cancellationPolicy: { ...refundPolicySnapshot },
          ...(input.usImportDisclosure
            ? {
                usImportDisclosure: {
                  terms: input.usImportDisclosure.terms,
                  version: input.usImportDisclosure.version,
                  text: input.usImportDisclosure.text,
                  presentedAt:
                    input.usImportDisclosure.presentedAt.toISOString(),
                },
              }
            : {}),
        },
        taxPolicyVersion: commitReadiness.taxPolicyVersion!,
        policyVersion: commitReadiness.policyVersion!,
        expiresAt: quote.quoteExpiresAt,
        initializationStatus: provider === "square" ? "ready" : "initializing",
        idempotencyKey: `primary/${order.id}`,
      })
      .returning({ id: orderPaymentObligations.id });
    if (!obligation)
      throw new Error("Primary payment obligation was not created");
    return {
      databaseId: order.id,
      orderId,
      primaryObligationId: obligation.id,
      currency: input.cart.currency,
      merchandiseAmountCents,
      shippingAmountCents,
      taxAmountCents,
      totalAmountCents,
      shippingRateTitle: rate.title,
    };
  });
}

export async function createInitializingManualProductOrder(
  input: CreateInitializingManualProductOrderInput,
): Promise<InitializingProductOrderRecord> {
  const now = new Date();
  if (
    input.fulfillmentMode !== "manual_pickup" ||
    input.cancellationPolicy.accepted !== true ||
    !/^checkout_post:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.cancellationPolicy.requestEvidence,
    )
  ) {
    throw new Error(
      "Manual checkout requires explicit policy acceptance and starts with studio pickup",
    );
  }
  const readiness = await evaluateManualCheckoutReadiness({
    catalogMetadataReady: input.cart.checkoutMode === "manual",
    now,
  });
  if (
    !readiness.ready ||
    !readiness.policy ||
    !readiness.taxPolicyApproval ||
    !readiness.fulfillmentPolicyVersion
  ) {
    throw new Error("Manual product payment is not operationally ready");
  }
  const fulfillmentPolicyVersion = readiness.fulfillmentPolicyVersion;
  const taxPolicyApprovalSnapshot = readiness.taxPolicyApproval;
  const cancellationVersion = input.cancellationPolicy.version.trim();
  if (!cancellationVersion) throw new Error("Cancellation policy is required");
  if (
    input.usImportDisclosure !== undefined &&
    !isValidUsImportDisclosure(input.usImportDisclosure)
  ) {
    throw new Error("US import disclosure is invalid");
  }
  if (input.cart.currency !== "CAD") throw new Error("Unsupported currency");
  const db = getPrivateDb();
  const cancellationPolicy = readiness.policy;
  if (
    cancellationPolicy.version !== cancellationVersion ||
    input.cancellationPolicy.textHash !== cancellationPolicy.textHash
  ) {
    throw new Error("Cancellation policy is not currently approved");
  }
  const cancellationPolicySnapshot = {
    accepted: true,
    version: cancellationPolicy.version,
    text: cancellationPolicy.text,
    textHash: cancellationPolicy.textHash,
    approvalEvidenceReference: cancellationPolicy.evidenceReference,
    approvedAt: cancellationPolicy.approvedAt.toISOString(),
    effectiveAt: cancellationPolicy.effectiveAt.toISOString(),
    presentedAt: input.cancellationPolicy.presentedAt.toISOString(),
    acceptedAt: now.toISOString(),
    requestEvidence: input.cancellationPolicy.requestEvidence,
  };
  const termsSnapshot = buildProductCheckoutTermsSnapshot(
    input.termsAssent,
    now,
  );
  const merchandiseAmountCents = toCents(input.cart.amount);
  if (merchandiseAmountCents <= 0) {
    throw new Error("Manual checkout total is invalid");
  }
  return db.transaction(async (tx) => {
    const { helcimContract, taxPolicyApproval } =
      await assertManualCheckoutReadinessInTransaction(
        tx,
        {
          fulfillmentPolicyVersion,
          manualPolicy: cancellationPolicy,
          taxPolicyApproval: taxPolicyApprovalSnapshot,
        },
        now,
      );
    assertProductTaxPolicyVersionImplemented(taxPolicyApproval.version);
    // Manual pickup is fulfilled from the studio, so the place of supply is the
    // studio's province (Ontario). No shipping component for pickup.
    const taxQuote = calculateProductTax({
      destinationCountry: STUDIO_PICKUP_TAX_JURISDICTION.country,
      destinationRegionCode: STUDIO_PICKUP_TAX_JURISDICTION.region,
      taxableAmountCents: merchandiseAmountCents,
    });
    const taxAmountCents = taxQuote.taxAmountCents;
    const totalAmountCents = merchandiseAmountCents + taxAmountCents;
    const orderId = `lh-${nanoid(12)}`;
    const [order] = await tx
      .insert(checkoutOrders)
      .values({
        orderId,
        status: "pending",
        initializationStatus: "initializing",
        customerName: input.customerName,
        customerEmail: input.customerEmail,
        purpose: "product",
        amountCents: totalAmountCents,
        merchandiseAmountCents,
        shippingAmountCents: 0,
        taxAmountCents,
        promotionCode: input.cart.promotionCode ?? null,
        promotionDiscountCents: toCents(
          input.cart.promotionDiscountAmount ?? 0,
        ),
        manualDiscountCents: toCents(input.cart.manualDiscountAmount ?? 0),
        currency: input.cart.currency,
        lineItems: toOrderLineItemSnapshots(input.cart),
        paymentProvider: "helcim",
        shippingAddress: undefined,
        refundOriginIpCiphertext: encryptCheckoutIp(input.refundOriginIp),
        atRiskValueCents: merchandiseAmountCents,
        fraudClassification: "low",
        paymentRiskStatus: "pending",
        shippingPolicyVersion: fulfillmentPolicyVersion,
        taxPolicyVersion: taxPolicyApproval.version,
        dduNoticeVersion:
          input.usImportDisclosure?.terms === "DDU"
            ? input.usImportDisclosure.version
            : undefined,
        dduNoticePresentedAt:
          input.usImportDisclosure?.terms === "DDU"
            ? input.usImportDisclosure.presentedAt
            : undefined,
        usImportDisclosureSnapshot: input.usImportDisclosure
          ? toStoredUsImportDisclosure(input.usImportDisclosure)
          : undefined,
        fulfillmentMode: input.fulfillmentMode,
        manualFulfillmentStatus: "payment_pending",
        cancellationPolicyVersion: cancellationVersion,
        cancellationPolicySnapshot,
        termsVersion: termsSnapshot.version as string,
        termsAcceptedAt: now,
        termsSnapshot,
      })
      .returning({ id: checkoutOrders.id });
    if (!order) throw new Error("Manual checkout order could not be created");
    const [obligation] = await tx
      .insert(orderPaymentObligations)
      .values({
        orderId: order.id,
        purpose: "primary",
        status: "pending",
        merchandiseAmountCents,
        shippingAmountCents: 0,
        taxAmountCents,
        totalAmountCents,
        currency: input.cart.currency,
        paymentProvider: "helcim",
        initializationStatus: "initializing",
        sourceWorkflow: input.fulfillmentMode,
        disclosureSnapshot: {
          helcimContract,
          taxPolicyApproval,
          tax: taxQuote,
          cancellationPolicy: {
            ...cancellationPolicySnapshot,
          },
          ...(input.usImportDisclosure
            ? {
                usImportDisclosure: {
                  terms: input.usImportDisclosure.terms,
                  version: input.usImportDisclosure.version,
                  text: input.usImportDisclosure.text,
                  presentedAt:
                    input.usImportDisclosure.presentedAt.toISOString(),
                },
              }
            : {}),
        },
        taxPolicyVersion: taxPolicyApproval.version,
        policyVersion: fulfillmentPolicyVersion,
        idempotencyKey: `primary/${order.id}`,
      })
      .returning({ id: orderPaymentObligations.id });
    if (!obligation)
      throw new Error("Primary payment obligation was not created");
    return {
      databaseId: order.id,
      orderId,
      primaryObligationId: obligation.id,
      currency: input.cart.currency,
      merchandiseAmountCents,
      shippingAmountCents: 0,
      taxAmountCents,
      totalAmountCents,
      shippingRateTitle:
        input.fulfillmentMode === "manual_pickup"
          ? "Pickup arranged after payment"
          : "Shipping quoted separately",
    };
  });
}

export async function finalizeInitializingProductOrder(input: {
  orderId: string;
  checkoutToken: string;
  secretToken: string;
  helcimInvoiceId: number;
  helcimInvoiceNumber: string;
}): Promise<void> {
  await getPrivateDb().transaction(async (tx) => {
    const [updated] = await tx
      .update(checkoutOrders)
      .set({
        checkoutTokenHash: hashCheckoutToken(input.checkoutToken),
        secretTokenCiphertext: encryptCheckoutSecret(input.secretToken),
        helcimInvoiceId: input.helcimInvoiceId,
        helcimInvoiceNumber: input.helcimInvoiceNumber,
        initializationStatus: "ready",
        initializationError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(checkoutOrders.orderId, input.orderId),
          eq(checkoutOrders.initializationStatus, "initializing"),
        ),
      )
      .returning({ id: checkoutOrders.id });
    if (!updated) {
      throw new Error("Initializing checkout order could not be finalized");
    }
    const [obligation] = await tx
      .update(orderPaymentObligations)
      .set({
        providerInvoiceId: input.helcimInvoiceId,
        providerInvoiceNumber: input.helcimInvoiceNumber,
        providerCheckoutId: input.checkoutToken,
        checkoutTokenHash: hashCheckoutToken(input.checkoutToken),
        secretTokenCiphertext: encryptCheckoutSecret(input.secretToken),
        initializationStatus: "ready",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(orderPaymentObligations.orderId, updated.id),
          eq(orderPaymentObligations.purpose, "primary"),
          eq(orderPaymentObligations.initializationStatus, "initializing"),
          isNull(orderPaymentObligations.quarantinedAt),
        ),
      )
      .returning({ id: orderPaymentObligations.id });
    if (!obligation) {
      throw new Error("Primary payment obligation could not be finalized");
    }
  });
}

export async function finalizeInitializingPaymentObligation(input: {
  obligationId: string;
  checkoutToken: string;
  secretToken: string;
  helcimInvoiceId: number;
  helcimInvoiceNumber: string;
  expectedLeaseOwner?: string;
  expectedStateVersion?: number;
}): Promise<void> {
  const conditions = [
    eq(orderPaymentObligations.id, input.obligationId),
    inArray(orderPaymentObligations.purpose, [
      "primary",
      "manual_shipping",
      "address_increase",
    ]),
    eq(orderPaymentObligations.status, "pending"),
    eq(orderPaymentObligations.initializationStatus, "initializing"),
    isNull(orderPaymentObligations.quarantinedAt),
  ];
  if (input.expectedLeaseOwner) {
    conditions.push(
      eq(
        orderPaymentObligations.initializationLeaseOwner,
        input.expectedLeaseOwner,
      ),
    );
  }
  if (input.expectedStateVersion !== undefined) {
    conditions.push(
      eq(
        orderPaymentObligations.initializationStateVersion,
        input.expectedStateVersion,
      ),
    );
  }
  await getPrivateDb().transaction(async (tx) => {
    const now = new Date();
    const [updated] = await tx
      .update(orderPaymentObligations)
      .set({
        providerInvoiceId: input.helcimInvoiceId,
        providerInvoiceNumber: input.helcimInvoiceNumber,
        providerCheckoutId: input.checkoutToken,
        checkoutTokenHash: hashCheckoutToken(input.checkoutToken),
        secretTokenCiphertext: encryptCheckoutSecret(input.secretToken),
        initializationStatus: "ready",
        initializationOutcome: "succeeded",
        initializationLeaseOwner: null,
        initializationLeaseExpiresAt: null,
        initializationLastError: null,
        initializationStateVersion: sql`${orderPaymentObligations.initializationStateVersion} + 1`,
        updatedAt: now,
      })
      .where(and(...conditions))
      .returning({
        id: orderPaymentObligations.id,
        orderId: orderPaymentObligations.orderId,
        purpose: orderPaymentObligations.purpose,
      });
    if (!updated) throw new Error("Payment obligation could not be finalized");
    if (updated.purpose === "primary") {
      const [order] = await tx
        .update(checkoutOrders)
        .set({
          checkoutTokenHash: hashCheckoutToken(input.checkoutToken),
          secretTokenCiphertext: encryptCheckoutSecret(input.secretToken),
          helcimInvoiceId: input.helcimInvoiceId,
          helcimInvoiceNumber: input.helcimInvoiceNumber,
          initializationStatus: "ready",
          initializationError: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(checkoutOrders.id, updated.orderId),
            eq(checkoutOrders.initializationStatus, "initializing"),
          ),
        )
        .returning({ id: checkoutOrders.id });
      if (!order)
        throw new Error("Primary checkout order could not be finalized");
    }
  });
}

export async function recordPaymentObligationInitializationInvoice(input: {
  obligationId: string;
  helcimInvoiceId: number;
  helcimInvoiceNumber: string;
  expectedLeaseOwner: string;
  expectedStateVersion: number;
}): Promise<number> {
  const [updated] = await getPrivateDb()
    .update(orderPaymentObligations)
    .set({
      providerInvoiceId: input.helcimInvoiceId,
      providerInvoiceNumber: input.helcimInvoiceNumber,
      initializationStateVersion: sql`${orderPaymentObligations.initializationStateVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(orderPaymentObligations.id, input.obligationId),
        eq(orderPaymentObligations.status, "pending"),
        eq(orderPaymentObligations.initializationStatus, "initializing"),
        eq(orderPaymentObligations.initializationOutcome, "claimed"),
        eq(
          orderPaymentObligations.initializationLeaseOwner,
          input.expectedLeaseOwner,
        ),
        eq(
          orderPaymentObligations.initializationStateVersion,
          input.expectedStateVersion,
        ),
        isNull(orderPaymentObligations.quarantinedAt),
      ),
    )
    .returning({
      stateVersion: orderPaymentObligations.initializationStateVersion,
    });
  if (!updated) {
    throw new Error("Payment obligation invoice evidence lost its lease");
  }
  return updated.stateVersion;
}

export async function markPaymentObligationInitializationFailed(input: {
  obligationId: string;
  expectedLeaseOwner?: string;
  expectedStateVersion?: number;
  outcome?: "failed" | "outcome_unknown" | "manual_review";
  error?: string;
}): Promise<void> {
  const conditions = [
    eq(orderPaymentObligations.id, input.obligationId),
    eq(orderPaymentObligations.status, "pending"),
    eq(orderPaymentObligations.initializationStatus, "initializing"),
    isNull(orderPaymentObligations.quarantinedAt),
  ];
  if (input.expectedLeaseOwner) {
    conditions.push(
      eq(
        orderPaymentObligations.initializationLeaseOwner,
        input.expectedLeaseOwner,
      ),
    );
  }
  if (input.expectedStateVersion !== undefined) {
    conditions.push(
      eq(
        orderPaymentObligations.initializationStateVersion,
        input.expectedStateVersion,
      ),
    );
  }
  await getPrivateDb()
    .update(orderPaymentObligations)
    .set({
      initializationStatus: "failed",
      initializationOutcome: input.outcome ?? "failed",
      initializationLastError: input.error?.slice(0, 500),
      initializationLeaseOwner: null,
      initializationLeaseExpiresAt: null,
      initializationStateVersion: sql`${orderPaymentObligations.initializationStateVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(and(...conditions));
}

export async function markProductOrderInitializationFailed(
  orderId: string,
  error: string,
): Promise<void> {
  await getPrivateDb().transaction(async (tx) => {
    const now = new Date();
    const [order] = await tx
      .update(checkoutOrders)
      .set({
        initializationStatus: "failed",
        initializationError: error.slice(0, 1_000),
        failedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(checkoutOrders.orderId, orderId),
          eq(checkoutOrders.initializationStatus, "initializing"),
        ),
      )
      .returning({ id: checkoutOrders.id });
    if (order) {
      await tx
        .update(orderPaymentObligations)
        .set({
          status: "cancelled",
          initializationStatus: "failed",
          initializationOutcome: "failed",
          initializationLastError: error.slice(0, 500),
          updatedAt: now,
        })
        .where(
          and(
            eq(orderPaymentObligations.orderId, order.id),
            eq(orderPaymentObligations.purpose, "primary"),
            eq(orderPaymentObligations.status, "pending"),
          ),
        );
      await tx
        .update(productShipments)
        .set({
          status: "abandoned",
          updatedAt: now,
        })
        .where(
          and(
            eq(productShipments.orderId, order.id),
            eq(productShipments.status, "payment_pending"),
          ),
        );
    }
  });
}

export async function createPendingSquareInvoiceOrder(
  input: CreatePendingSquareInvoiceOrderInput,
): Promise<PendingOrderRecord> {
  return defaultOrderStore.createPendingSquareInvoiceOrder(input);
}

/**
 * Reserve a pending primary-training order paid through the embedded Square
 * card flow. The generated public `orderId` is also the payment reference; the
 * order is finalized to paid by {@link finalizeSquareTrainingCardPayment} after
 * the Square authorization is captured.
 */
export async function createPendingSquareTrainingCardOrder(
  input: CreatePendingSquareTrainingCardOrderInput,
): Promise<PendingSquareTrainingCardOrderRecord> {
  const db = getPrivateDb();
  const orderId = `lh-${nanoid(12)}`;
  const providerMetadata: SquareCardProviderMetadata = {
    amountCents: input.amountCents,
    correlationId: orderId,
    currency: "CAD",
    finalizationStatus: "pending",
    flow: "training_square_card",
    programSlug: input.programSlug,
  };

  const [order] = await db
    .insert(checkoutOrders)
    .values({
      orderId,
      status: "pending",
      checkoutTokenHash: null,
      secretTokenCiphertext: null,
      helcimInvoiceId: null,
      helcimInvoiceNumber: null,
      customerName: input.customerName,
      customerEmail: input.customerEmail,
      purpose: "training",
      amountCents: input.amountCents,
      merchandiseAmountCents: input.merchandiseAmountCents,
      shippingAmountCents: 0,
      taxAmountCents: input.taxAmountCents,
      promotionCode: input.cart.promotionCode ?? null,
      promotionDiscountCents: toCents(input.cart.promotionDiscountAmount ?? 0),
      manualDiscountCents: toCents(input.cart.manualDiscountAmount ?? 0),
      currency: "CAD",
      lineItems: toOrderLineItemSnapshots(input.cart),
      paymentProvider: "square",
      providerStatus: "pending",
      providerMetadata,
    })
    .returning({ id: checkoutOrders.id });
  if (!order) {
    throw new Error("Square training order could not be created");
  }

  return { databaseId: order.id, orderId };
}

export async function markOrderPaid(
  orderId: string,
  helcimTransactionId: string,
): Promise<HelcimPurchaseTransitionResult> {
  return defaultOrderStore.markOrderPaid(orderId, helcimTransactionId);
}

export async function markOrderVerificationFailed(
  orderId: string,
): Promise<void> {
  await defaultOrderStore.markOrderVerificationFailed(orderId);
}

export async function markProductOrderConfirmationEmailSent(
  orderId: string,
  now?: Date,
): Promise<void> {
  await defaultOrderStore.markProductOrderConfirmationEmailSent(orderId, now);
}

export async function recordProductOrderConfirmationEmailFailure(
  input: ProductOrderConfirmationEmailFailureInput,
): Promise<void> {
  await defaultOrderStore.recordProductOrderConfirmationEmailFailure(input);
}

export async function recordSquareInvoicePublication(
  orderId: string,
  invoiceId: string,
  publicUrl: string,
  version: number,
): Promise<void> {
  await defaultOrderStore.recordSquareInvoicePublication(
    orderId,
    invoiceId,
    publicUrl,
    version,
  );
}

export async function markSquareInvoicePaid(
  orderId: string,
  paymentId: string,
): Promise<void> {
  await defaultOrderStore.markSquareInvoicePaid(orderId, paymentId);
}

export async function markSquareInvoiceFinalizationFailed(
  orderId: string,
  error: string,
  retryable: boolean,
): Promise<void> {
  await defaultOrderStore.markSquareInvoiceFinalizationFailed(
    orderId,
    error,
    retryable,
  );
}

export async function findOrderBySquareInvoiceId(
  invoiceId: string,
): Promise<CheckoutOrderRow | null> {
  return defaultOrderStore.findOrderBySquareInvoiceId(invoiceId);
}

export async function claimProductOrderConfirmationEmail(
  input: ClaimProductOrderConfirmationEmailInput,
): Promise<ProductOrderConfirmationEmailRecord | null> {
  return defaultOrderStore.claimProductOrderConfirmationEmail(input);
}

export async function findOrderByCorrelationId(
  correlationId: string,
): Promise<CheckoutOrderRow | null> {
  return defaultOrderStore.findOrderByCorrelationId(correlationId);
}

export async function getPendingOrderByCheckoutToken(
  checkoutToken: string,
): Promise<PendingOrderRecord | null> {
  return defaultOrderStore.getPendingOrderByCheckoutToken(checkoutToken);
}

export async function recordHelcimWebhookEvent(
  input: HelcimWebhookEventInput,
): Promise<boolean> {
  return defaultOrderStore.recordHelcimWebhookEvent(input);
}

export async function recordHelcimWebhookEventWithOrder(
  input: HelcimWebhookEventInput,
): Promise<HelcimWebhookEventRecordResult> {
  return defaultOrderStore.recordHelcimWebhookEventWithOrder(input);
}

export async function markHelcimWebhookEventProcessingStatus(input: {
  eventId: string;
  status: "processed" | "review_required" | "retryable_failed";
  message?: string;
  reasonCode?: string;
}): Promise<void> {
  await getPrivateDb().transaction(async (tx) => {
    const [event] = await tx
      .update(checkoutPaymentEvents)
      .set({
        processingStatus: input.status,
        message: input.message?.slice(0, 500),
        processedAt: input.status === "processed" ? new Date() : null,
      })
      .where(
        and(
          eq(checkoutPaymentEvents.paymentProvider, "helcim"),
          eq(checkoutPaymentEvents.idempotencyKey, input.eventId),
        ),
      )
      .returning({ id: checkoutPaymentEvents.id });
    if (input.status === "review_required" && event) {
      await tx
        .insert(fulfillmentDataQuarantine)
        .values({
          entityType: "checkout_payment_event",
          entityId: event.id,
          reasonCode: input.reasonCode ?? "UNMATCHED_APPROVED_HELCIM_REFUND",
          evidence: {
            providerEventId: input.eventId,
            message: input.message?.slice(0, 500) ?? null,
          },
        })
        .onConflictDoNothing();
    }
  });
}

export async function claimSquareInvoiceWebhookEvent(
  input: SquareInvoiceWebhookEventInput,
): Promise<SquareInvoiceWebhookEventClaimResult> {
  return defaultOrderStore.claimSquareInvoiceWebhookEvent(input);
}

export async function recordSquareInvoiceWebhookEventProcessed(
  input: SquareInvoiceWebhookEventInput,
): Promise<void> {
  await defaultOrderStore.recordSquareInvoiceWebhookEventProcessed(input);
}

async function recordHelcimWebhookEventWithOrderInternal(
  repository: CheckoutOrderRepository,
  input: HelcimWebhookEventInput,
): Promise<HelcimWebhookEventRecordResult> {
  const obligationMatch =
    await repository.findPaymentObligationForWebhook?.(input);
  const order =
    obligationMatch?.order ?? (await repository.findOrderForWebhook(input));
  const amountCents = input.amount === undefined ? null : toCents(input.amount);
  const createdEvent = await repository.createWebhookEvent({
    orderId: order?.id ?? null,
    eventType: input.eventType,
    helcimTransactionId: input.helcimTransactionId,
    status: input.status,
    amountCents,
    currency: input.currency?.toUpperCase(),
    idempotencyKey: input.eventId,
    payloadRedacted: input.payloadRedacted,
    processingStatus:
      classifyHelcimTransaction(input).kind === "unknown"
        ? "review_required"
        : "received",
  });

  const paid = await reconcileWebhookPaidOrder({
    amountCents,
    input,
    order,
    repository,
  });

  return {
    matchedOrder: order
      ? {
          ...toMatchedCheckoutOrderRecord(order),
          ...(obligationMatch
            ? { paymentObligationId: obligationMatch.obligationId }
            : {}),
        }
      : null,
    paid,
    recorded: createdEvent !== null,
  };
}

async function reconcileWebhookPaidOrder(input: {
  amountCents: number | null;
  input: HelcimWebhookEventInput;
  order: CheckoutOrderRow | null;
  repository: CheckoutOrderRepository;
}): Promise<boolean> {
  if (input.order === null) {
    return false;
  }

  // Product purchases are finalized exclusively by finalizeProductPayment so
  // payment, obligation, transaction, and risk state change atomically.
  if (input.order.purpose === "product") return false;

  const classification = classifyHelcimTransaction(input.input);
  if (
    classification.kind !== "purchase" ||
    !classification.successful ||
    !input.input.helcimTransactionId
  ) {
    return false;
  }

  if (input.order.status === "paid") {
    return input.order.helcimTransactionId === input.input.helcimTransactionId;
  }
  if (["cancelled", "refunded"].includes(input.order.status)) return false;

  const expectedAmountMatches =
    input.amountCents !== null && input.amountCents === input.order.amountCents;
  const expectedCurrencyMatches =
    input.input.currency !== undefined &&
    input.input.currency.toUpperCase() === input.order.currency;

  if (!expectedAmountMatches || !expectedCurrencyMatches) {
    return false;
  }

  const transition = await input.repository.markOrderPaid(
    input.order.orderId,
    input.input.helcimTransactionId,
  );
  return transition === "applied" || transition === "already_applied";
}

function toMatchedCheckoutOrderRecord(
  order: CheckoutOrderRow,
): MatchedCheckoutOrderRecord {
  const currency = order.currency.toUpperCase();

  if (currency !== "CAD") {
    throw new Error("Unsupported checkout order currency");
  }

  return {
    _id: order.id,
    amount: centsToCad(order.amountCents),
    currency,
    helcimInvoiceId: order.helcimInvoiceId,
    helcimInvoiceNumber: order.helcimInvoiceNumber,
    orderId: order.orderId,
    purpose: order.purpose,
    paymentProvider: order.paymentProvider,
  };
}

function toProductOrderConfirmationEmailRecord(
  order: CheckoutOrderRow,
): ProductOrderConfirmationEmailRecord {
  const currency = order.currency.toUpperCase();

  if (currency !== "CAD") {
    throw new Error("Unsupported checkout order currency");
  }

  return {
    orderDatabaseId: order.id,
    currency,
    customerEmail: order.customerEmail,
    customerName: order.customerName,
    lineItems: order.lineItems,
    merchandiseAmount: centsToCad(
      order.merchandiseAmountCents ??
        Math.max(0, order.amountCents - order.shippingAmountCents),
    ),
    orderId: order.orderId,
    shippingAmount: centsToCad(order.shippingAmountCents),
    shippingAddress: order.shippingAddress ?? null,
    totalAmount: centsToCad(order.amountCents),
    paymentRiskStatus: order.paymentRiskStatus,
    promotionCode: order.promotionCode,
    promotionDiscount: centsToCad(order.promotionDiscountCents),
    manualDiscount: centsToCad(order.manualDiscountCents),
    taxAmount: centsToCad(order.taxAmountCents),
    fulfillmentMode: order.fulfillmentMode,
    manualFulfillmentStatus: order.manualFulfillmentStatus,
    cancellationPolicySnapshot: order.cancellationPolicySnapshot,
    usImportDisclosure: order.usImportDisclosureSnapshot,
    termsSnapshot: order.termsSnapshot,
  };
}

export async function enqueuePaidProductOrderConfirmationEmail(input: {
  orderId: string;
  now?: Date;
}): Promise<ProductOrderConfirmationEmailRecord | null> {
  const now = input.now ?? new Date();
  return getPrivateDb().transaction(async (tx) => {
    const [claimedOrder] = await tx
      .update(checkoutOrders)
      .set({
        productConfirmationEmailClaimedUntil: new Date(
          now.getTime() + EMAIL_CLAIM_DURATION_MS,
        ),
        productConfirmationEmailLastError: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(checkoutOrders.orderId, input.orderId),
          eq(checkoutOrders.status, "paid"),
          eq(checkoutOrders.purpose, "product"),
          isNull(checkoutOrders.productConfirmationEmailSentAt),
          or(
            isNull(checkoutOrders.productConfirmationEmailClaimedUntil),
            lte(checkoutOrders.productConfirmationEmailClaimedUntil, now),
          ),
        ),
      )
      .returning();
    if (!claimedOrder) return null;
    const payload = toProductOrderConfirmationEmailRecord(claimedOrder);
    await enqueueCustomerEmail(
      {
        kind: "product_order_confirmation",
        orderDatabaseId: claimedOrder.id,
        payload,
        providerIdempotencyKey: `product-confirmation:${claimedOrder.orderId}`,
        recipient: claimedOrder.customerEmail,
        now,
      },
      tx,
    );
    return payload;
  });
}

export async function listPaidProductOrdersMissingConfirmationOutbox(
  input: {
    limit?: number;
  } = {},
): Promise<string[]> {
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
  const rows = await getPrivateDb()
    .select({ orderId: checkoutOrders.orderId })
    .from(checkoutOrders)
    .where(
      and(
        eq(checkoutOrders.status, "paid"),
        eq(checkoutOrders.purpose, "product"),
        isNull(checkoutOrders.productConfirmationEmailSentAt),
      ),
    )
    .orderBy(checkoutOrders.updatedAt)
    .limit(limit);
  return rows.map((row) => row.orderId);
}

function createTrainingInvoiceLineItems(
  input: CreatePendingSquareInvoiceOrderInput,
): CheckoutOrderLineItemSnapshot[] {
  return [
    {
      description: `Training program: ${input.programSlug}`,
      productId: input.programSlug,
      quantity: 1,
      sku: `TRAINING-${input.programSlug.toUpperCase()}`,
      totalCents: input.amountCents,
      unitPriceCents: input.amountCents,
    },
  ];
}

function toOrderLineItemSnapshots(
  cart: ValidatedCart,
): CheckoutOrderLineItemSnapshot[] {
  const promotionDiscountCents =
    cart.promotionDiscountAmount === undefined
      ? undefined
      : toCents(cart.promotionDiscountAmount);
  return cart.lineItems.map((lineItem) => ({
    productId: lineItem.productId,
    ...(lineItem.variantId ? { variantId: lineItem.variantId } : {}),
    sku: lineItem.sku,
    description: lineItem.description,
    productTitle: lineItem.productTitle,
    ...(lineItem.variantTitle ? { variantTitle: lineItem.variantTitle } : {}),
    ...(lineItem.selectedOptions?.length
      ? { selectedOptions: lineItem.selectedOptions }
      : {}),
    ...(lineItem.checkoutMode
      ? { fulfillmentMode: lineItem.checkoutMode }
      : {}),
    quantity: lineItem.quantity,
    unitPriceCents: toCents(lineItem.price),
    ...(lineItem.originalPrice !== undefined
      ? { originalUnitPriceCents: toCents(lineItem.originalPrice) }
      : {}),
    ...(lineItem.manualDiscount !== undefined
      ? { manualDiscountCents: toCents(lineItem.manualDiscount) }
      : {}),
    ...(cart.promotionCode ? { promotionCode: cart.promotionCode } : {}),
    ...(promotionDiscountCents !== undefined && cart.lineItems.length === 1
      ? { promotionDiscountCents }
      : {}),
    totalCents: toCents(lineItem.total),
    ...(lineItem.originalTotal !== undefined
      ? { originalTotalCents: toCents(lineItem.originalTotal) }
      : {}),
  }));
}

function createSquareInvoiceProviderMetadata(
  input: CreatePendingSquareInvoiceOrderInput,
): SquareInvoiceProviderMetadata {
  return {
    amountCents: input.amountCents,
    correlationId: input.correlationId,
    currency: "CAD",
    finalizationStatus: "pending",
    flow: "training_square_invoice",
    programSlug: input.programSlug,
    squareCustomerId: input.squareCustomerId,
    squareInvoicePublicUrl: input.squareInvoicePublicUrl ?? null,
    squareInvoiceVersion: input.squareInvoiceVersion ?? null,
  };
}

function toSquareInvoiceWebhookEventInsert(
  input: SquareInvoiceWebhookEventInput,
  processingStatus: PaymentEventProcessingStatus,
): typeof checkoutPaymentEvents.$inferInsert {
  return {
    eventType: input.eventType,
    orderId: input.orderDatabaseId,
    paymentProvider: "square",
    payloadHash: input.payloadSanitized
      ? hashPayload(input.payloadSanitized)
      : undefined,
    payloadSanitized: input.payloadSanitized,
    processedAt: processingStatus === "processed" ? new Date() : undefined,
    processingStatus,
    providerCheckoutId: input.providerCheckoutId,
    providerEventId: input.eventId,
    providerOrderId: input.providerOrderId,
    providerPaymentId: input.providerPaymentId,
    status: input.status,
  };
}

function toSquareInvoiceWebhookEventUpdate(
  input: SquareInvoiceWebhookEventInput,
  processingStatus: PaymentEventProcessingStatus,
): Partial<typeof checkoutPaymentEvents.$inferInsert> {
  return {
    eventType: input.eventType,
    orderId: input.orderDatabaseId,
    payloadHash: input.payloadSanitized
      ? hashPayload(input.payloadSanitized)
      : undefined,
    payloadSanitized: input.payloadSanitized,
    processedAt: processingStatus === "processed" ? new Date() : undefined,
    processingStatus,
    providerCheckoutId: input.providerCheckoutId,
    providerOrderId: input.providerOrderId,
    providerPaymentId: input.providerPaymentId,
    status: input.status,
  };
}

function mergeProviderMetadata(metadata: CheckoutProviderMetadata) {
  return sql`coalesce(${checkoutOrders.providerMetadata}, '{}'::jsonb) || ${JSON.stringify(metadata)}::jsonb`;
}

function createDrizzleCheckoutOrderRepository(): CheckoutOrderRepository {
  return {
    async createCheckoutOrder(values) {
      const [createdOrder] = await getPrivateDb()
        .insert(checkoutOrders)
        .values(values)
        .returning({ id: checkoutOrders.id });

      return createdOrder;
    },

    async createSquareInvoiceWebhookEvent(values) {
      const [createdEvent] = await getPrivateDb()
        .insert(checkoutPaymentEvents)
        .values(toSquareInvoiceWebhookEventInsert(values, "received"))
        .onConflictDoNothing({
          target: [
            checkoutPaymentEvents.paymentProvider,
            checkoutPaymentEvents.providerEventId,
          ],
        })
        .returning({ id: checkoutPaymentEvents.id });

      return createdEvent ?? null;
    },

    async createWebhookEvent(values) {
      const [createdEvent] = await getPrivateDb()
        .insert(checkoutPaymentEvents)
        .values(values)
        .onConflictDoNothing({ target: checkoutPaymentEvents.idempotencyKey })
        .returning({ id: checkoutPaymentEvents.id });

      return createdEvent ?? null;
    },

    async claimProductOrderConfirmationEmail(input) {
      const [claimedOrder] = await getPrivateDb()
        .update(checkoutOrders)
        .set({
          productConfirmationEmailClaimedUntil: input.claimUntil,
          productConfirmationEmailLastError: null,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(checkoutOrders.orderId, input.orderId),
            eq(checkoutOrders.status, "paid"),
            eq(checkoutOrders.purpose, "product"),
            isNull(checkoutOrders.productConfirmationEmailSentAt),
            or(
              isNull(checkoutOrders.productConfirmationEmailClaimedUntil),
              lte(
                checkoutOrders.productConfirmationEmailClaimedUntil,
                input.now,
              ),
            ),
          ),
        )
        .returning();

      return claimedOrder ?? null;
    },

    async findSquareInvoiceWebhookEventClaim(eventId) {
      const [event] = await getPrivateDb()
        .select({ processingStatus: checkoutPaymentEvents.processingStatus })
        .from(checkoutPaymentEvents)
        .where(
          and(
            eq(checkoutPaymentEvents.paymentProvider, "square"),
            eq(checkoutPaymentEvents.providerEventId, eventId),
          ),
        )
        .limit(1);

      return {
        duplicate: true,
        processingStatus: event?.processingStatus ?? "received",
      };
    },

    async findOrderForWebhook(input) {
      return findOrderForWebhook(input);
    },

    async findPaymentObligationForWebhook(input) {
      if (
        input.helcimInvoiceId === undefined &&
        input.helcimInvoiceNumber === undefined
      ) {
        return null;
      }
      const conditions = [
        input.helcimInvoiceId === undefined
          ? undefined
          : eq(
              orderPaymentObligations.providerInvoiceId,
              input.helcimInvoiceId,
            ),
        input.helcimInvoiceNumber === undefined
          ? undefined
          : eq(
              orderPaymentObligations.providerInvoiceNumber,
              input.helcimInvoiceNumber,
            ),
      ].filter((condition) => condition !== undefined);
      const [match] = await getPrivateDb()
        .select({
          order: checkoutOrders,
          obligationId: orderPaymentObligations.id,
        })
        .from(orderPaymentObligations)
        .innerJoin(
          checkoutOrders,
          eq(orderPaymentObligations.orderId, checkoutOrders.id),
        )
        .where(
          and(
            eq(orderPaymentObligations.paymentProvider, "helcim"),
            eq(orderPaymentObligations.initializationStatus, "ready"),
            isNull(orderPaymentObligations.quarantinedAt),
            isNull(checkoutOrders.fulfillmentQuarantinedAt),
            ...conditions,
          ),
        )
        .limit(1);
      return match ?? null;
    },

    async findCheckoutOrderByCheckoutTokenHash(checkoutTokenHash) {
      const [order] = await getPrivateDb()
        .select()
        .from(checkoutOrders)
        .where(
          and(
            eq(checkoutOrders.checkoutTokenHash, checkoutTokenHash),
            inArray(checkoutOrders.status, [
              "pending",
              "paid",
              "cancelled",
              "refunded",
            ]),
          ),
        )
        .limit(1);

      return order ?? null;
    },

    async findPaymentObligationByCheckoutTokenHash(checkoutTokenHash) {
      const [match] = await getPrivateDb()
        .select({
          order: checkoutOrders,
          obligation: orderPaymentObligations,
        })
        .from(orderPaymentObligations)
        .innerJoin(
          checkoutOrders,
          eq(orderPaymentObligations.orderId, checkoutOrders.id),
        )
        .where(
          and(
            eq(orderPaymentObligations.checkoutTokenHash, checkoutTokenHash),
            eq(orderPaymentObligations.paymentProvider, "helcim"),
            isNull(orderPaymentObligations.quarantinedAt),
            isNull(checkoutOrders.fulfillmentQuarantinedAt),
          ),
        )
        .limit(1);
      return match ?? null;
    },

    async findOrderBySquareInvoiceId(invoiceId) {
      const [order] = await getPrivateDb()
        .select()
        .from(checkoutOrders)
        .where(
          and(
            eq(checkoutOrders.paymentProvider, "square"),
            eq(checkoutOrders.providerCheckoutId, invoiceId),
          ),
        )
        .limit(1);

      return order ?? null;
    },

    async findOrderByCorrelationId(correlationId) {
      const [order] = await getPrivateDb()
        .select()
        .from(checkoutOrders)
        .where(
          and(
            eq(checkoutOrders.paymentProvider, "square"),
            sql`${checkoutOrders.providerMetadata}->>'correlationId' = ${correlationId}`,
          ),
        )
        .limit(1);

      return order ?? null;
    },

    async markOrderPaid(orderId, helcimTransactionId) {
      const now = new Date();
      const [updated] = await getPrivateDb()
        .update(checkoutOrders)
        .set({
          status: "paid",
          helcimTransactionId,
          providerPaymentId: helcimTransactionId,
          paidAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(checkoutOrders.orderId, orderId),
            eq(checkoutOrders.paymentProvider, "helcim"),
            inArray(checkoutOrders.status, ["pending", "verification_failed"]),
            isNull(checkoutOrders.helcimTransactionId),
          ),
        )
        .returning({ id: checkoutOrders.id });
      if (updated) return "applied";
      const [existing] = await getPrivateDb()
        .select({
          status: checkoutOrders.status,
          transactionId: checkoutOrders.helcimTransactionId,
        })
        .from(checkoutOrders)
        .where(eq(checkoutOrders.orderId, orderId))
        .limit(1);
      if (!existing) return "not_found";
      if (
        existing.status === "paid" &&
        existing.transactionId === helcimTransactionId
      )
        return "already_applied";
      if (existing.status === "paid" && existing.transactionId)
        return "transaction_conflict";
      return "state_conflict";
    },

    async markOrderVerificationFailed(orderId) {
      await getPrivateDb()
        .update(checkoutOrders)
        .set({
          status: "verification_failed",
          failedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(checkoutOrders.orderId, orderId));
    },

    async markProductOrderConfirmationEmailSent(orderId, now) {
      await getPrivateDb()
        .update(checkoutOrders)
        .set({
          productConfirmationEmailClaimedUntil: null,
          productConfirmationEmailLastError: null,
          productConfirmationEmailSentAt: now,
          updatedAt: now,
        })
        .where(eq(checkoutOrders.orderId, orderId));
    },

    async recordProductOrderConfirmationEmailFailure(orderId, error, now) {
      await getPrivateDb()
        .update(checkoutOrders)
        .set({
          productConfirmationEmailClaimedUntil: null,
          productConfirmationEmailLastError: error,
          updatedAt: now,
        })
        .where(eq(checkoutOrders.orderId, orderId));
    },

    async recordSquareInvoicePublication(
      orderId,
      invoiceId,
      publicUrl,
      version,
    ) {
      await getPrivateDb()
        .update(checkoutOrders)
        .set({
          providerCheckoutId: invoiceId,
          providerMetadata: mergeProviderMetadata({
            squareInvoicePublicUrl: publicUrl,
            squareInvoiceVersion: version,
          }),
          providerStatus: "published",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(checkoutOrders.orderId, orderId),
            eq(checkoutOrders.paymentProvider, "square"),
          ),
        );
    },

    async markSquareInvoicePaid(orderId, paymentId) {
      await getPrivateDb()
        .update(checkoutOrders)
        .set({
          paidAt: sql`coalesce(${checkoutOrders.paidAt}, now())`,
          providerMetadata: mergeProviderMetadata({
            finalizationStatus: "paid",
          }),
          providerPaymentId: paymentId,
          providerStatus: "paid",
          status: "paid",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(checkoutOrders.orderId, orderId),
            eq(checkoutOrders.paymentProvider, "square"),
          ),
        );
    },

    async markSquareInvoiceFinalizationFailed(orderId, error, retryable) {
      await getPrivateDb()
        .update(checkoutOrders)
        .set({
          failedAt: sql`coalesce(${checkoutOrders.failedAt}, now())`,
          providerMetadata: mergeProviderMetadata({
            finalizationError: error,
            finalizationRetryable: retryable,
            finalizationStatus: "failed",
          }),
          providerStatus: "finalization_failed",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(checkoutOrders.orderId, orderId),
            eq(checkoutOrders.paymentProvider, "square"),
          ),
        );
    },

    async updateSquareInvoiceWebhookEvent(values, processingStatus) {
      await getPrivateDb()
        .update(checkoutPaymentEvents)
        .set(toSquareInvoiceWebhookEventUpdate(values, processingStatus))
        .where(
          and(
            eq(checkoutPaymentEvents.paymentProvider, "square"),
            eq(checkoutPaymentEvents.providerEventId, values.eventId),
          ),
        );
    },
  };
}

function toPendingOrderRecord(
  pendingOrder: CheckoutOrderRow,
): PendingOrderRecord {
  const currency = pendingOrder.currency.toUpperCase();

  if (currency !== "CAD") {
    throw new Error("Unsupported checkout order currency");
  }

  if (!pendingOrder.secretTokenCiphertext) {
    throw new Error("Checkout order is not ready for payment validation");
  }

  return {
    _id: pendingOrder.id,
    orderId: pendingOrder.orderId,
    secretToken: decryptCheckoutSecret(pendingOrder.secretTokenCiphertext),
    helcimInvoiceId: pendingOrder.helcimInvoiceId,
    helcimInvoiceNumber: pendingOrder.helcimInvoiceNumber,
    amount: centsToCad(pendingOrder.amountCents),
    currency,
    customerEmail: pendingOrder.customerEmail,
    customerName: pendingOrder.customerName,
    lineItems: pendingOrder.lineItems,
    paymentProvider: pendingOrder.paymentProvider,
    purpose: pendingOrder.purpose,
    shippingAddress: pendingOrder.shippingAddress ?? null,
  };
}

async function findOrderForWebhook(
  input: HelcimWebhookEventInput,
): Promise<CheckoutOrderRow | null> {
  if (
    input.helcimInvoiceId === undefined &&
    input.helcimInvoiceNumber === undefined
  ) {
    return null;
  }

  const invoiceConditions = [
    input.helcimInvoiceId === undefined
      ? undefined
      : eq(checkoutOrders.helcimInvoiceId, input.helcimInvoiceId),
    input.helcimInvoiceNumber === undefined
      ? undefined
      : eq(checkoutOrders.helcimInvoiceNumber, input.helcimInvoiceNumber),
  ].filter((condition) => condition !== undefined);

  const [order] = await getPrivateDb()
    .select()
    .from(checkoutOrders)
    .where(
      and(
        eq(checkoutOrders.paymentProvider, "helcim"),
        isNull(checkoutOrders.fulfillmentQuarantinedAt),
        ...invoiceConditions,
      ),
    )
    .limit(1);

  return order ?? null;
}

function hashCheckoutToken(checkoutToken: string): string {
  return createHmac("sha256", getCheckoutSecretEncryptionKey())
    .update(checkoutToken, "utf8")
    .digest("hex");
}

function toCents(value: number | string): number {
  return Math.round(parseCad(value) * 100);
}

function centsToCad(cents: number): number {
  return cents / 100;
}

function hashPayload(payload: CheckoutPaymentEventPayload): string {
  return createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex");
}

function isCheckoutTokenValidationEligible(order: CheckoutOrderRow): boolean {
  if (
    order.paymentProvider !== "helcim" ||
    order.fulfillmentQuarantinedAt !== null
  ) {
    return false;
  }

  if (order.status === "pending") {
    return true;
  }

  // Helcim webhooks can commit a product purchase before the browser callback.
  // The checkout token and response hash still authenticate the browser path;
  // finalizers enforce immutable provider transaction identity on replay.
  return (
    (order.status === "paid" &&
      (order.purpose === "product" || isAppointmentPurpose(order.purpose))) ||
    (["cancelled", "refunded"].includes(order.status) &&
      order.purpose === "product")
  );
}

function isAppointmentPurpose(purpose: CheckoutOrderPurpose): boolean {
  return (
    purpose === "appointment_deposit" ||
    purpose === "appointment_full" ||
    purpose === "appointment_custom_partial"
  );
}

function isValidUsImportDisclosure(
  value: UsImportDisclosureSnapshot | undefined,
): value is UsImportDisclosureSnapshot {
  return Boolean(
    value &&
    value.terms === "DDU" &&
    value.version.trim() &&
    value.text.trim() &&
    !Number.isNaN(value.presentedAt.getTime()),
  );
}

function toStoredUsImportDisclosure(value: UsImportDisclosureSnapshot) {
  return {
    terms: value.terms,
    version: value.version.trim(),
    text: value.text.trim(),
    presentedAt: value.presentedAt.toISOString(),
  };
}

export function hashManualCancellationPolicyText(text: string): string {
  return createHash("sha256").update(text.trim(), "utf8").digest("hex");
}
