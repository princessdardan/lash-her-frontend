import "server-only";

import { createHash, createHmac } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

import type {
  CheckoutOrderLineItemSnapshot,
  CheckoutProviderMetadata,
  CheckoutOrderPurpose,
  CheckoutPaymentEventPayload,
  CheckoutOrderShippingAddressSnapshot,
  PaymentEventProcessingStatus,
  PaymentProvider,
} from "@/lib/private-db/schema";
import { getCheckoutSecretEncryptionKey } from "@/sanity/env";
import {
  checkoutOrders,
  checkoutPaymentEvents,
} from "@/lib/private-db/schema";
import { getPrivateDb } from "@/lib/private-db/client";

import type { ValidatedCart } from "./cart";
import { decryptCheckoutSecret, encryptCheckoutSecret } from "./checkout-secret";
import { parseCad } from "./money";

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
  payloadRedacted?: Record<string, unknown>;
  status?: string;
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
type CheckoutOrderInsert = HelcimCheckoutOrderInsert | SquareInvoiceCheckoutOrderInsert;
type CheckoutPaymentEventInsert = {
  amountCents: number | null;
  currency: string | undefined;
  eventType: string;
  helcimTransactionId: string | undefined;
  idempotencyKey: string;
  orderId: string | null;
  payloadRedacted: Record<string, unknown> | undefined;
  status: string | undefined;
};

export interface CheckoutOrderRepository {
  createCheckoutOrder(values: CheckoutOrderInsert): Promise<{ id: string }>;
  createSquareInvoiceWebhookEvent(values: SquareInvoiceWebhookEventInput): Promise<{ id: string } | null>;
  createWebhookEvent(values: CheckoutPaymentEventInsert): Promise<{ id: string } | null>;
  findSquareInvoiceWebhookEventClaim(eventId: string): Promise<SquareInvoiceWebhookEventClaimResult>;
  findOrderForWebhook(input: HelcimWebhookEventInput): Promise<CheckoutOrderRow | null>;
  findCheckoutOrderByCheckoutTokenHash(checkoutTokenHash: string): Promise<CheckoutOrderRow | null>;
  findOrderByCorrelationId(correlationId: string): Promise<CheckoutOrderRow | null>;
  findOrderBySquareInvoiceId(invoiceId: string): Promise<CheckoutOrderRow | null>;
  markOrderPaid(orderId: string, helcimTransactionId: string): Promise<void>;
  markOrderVerificationFailed(orderId: string): Promise<void>;
  markSquareInvoiceFinalizationFailed(orderId: string, error: string, retryable: boolean): Promise<void>;
  markSquareInvoicePaid(orderId: string, paymentId: string): Promise<void>;
  recordSquareInvoicePublication(orderId: string, invoiceId: string, publicUrl: string, version: number): Promise<void>;
  updateSquareInvoiceWebhookEvent(
    values: SquareInvoiceWebhookEventInput,
    processingStatus: PaymentEventProcessingStatus,
  ): Promise<void>;
}

export interface CheckoutOrderStore {
  createPendingOrder(input: CreatePendingOrderInput): Promise<PendingOrderRecord>;
  createPendingSquareInvoiceOrder(input: CreatePendingSquareInvoiceOrderInput): Promise<PendingOrderRecord>;
  findOrderByCorrelationId(correlationId: string): Promise<CheckoutOrderRow | null>;
  findOrderBySquareInvoiceId(invoiceId: string): Promise<CheckoutOrderRow | null>;
  getPendingOrderByCheckoutToken(checkoutToken: string): Promise<PendingOrderRecord | null>;
  markOrderPaid(orderId: string, helcimTransactionId: string): Promise<void>;
  markOrderVerificationFailed(orderId: string): Promise<void>;
  markSquareInvoiceFinalizationFailed(orderId: string, error: string, retryable: boolean): Promise<void>;
  markSquareInvoicePaid(orderId: string, paymentId: string): Promise<void>;
  recordSquareInvoicePublication(orderId: string, invoiceId: string, publicUrl: string, version: number): Promise<void>;
  recordHelcimWebhookEvent(input: HelcimWebhookEventInput): Promise<boolean>;
  recordHelcimWebhookEventWithOrder(input: HelcimWebhookEventInput): Promise<HelcimWebhookEventRecordResult>;
  claimSquareInvoiceWebhookEvent(input: SquareInvoiceWebhookEventInput): Promise<SquareInvoiceWebhookEventClaimResult>;
  recordSquareInvoiceWebhookEventProcessed(input: SquareInvoiceWebhookEventInput): Promise<void>;
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
      const promotionDiscountCents = input.cart.promotionDiscountAmount === undefined
        ? undefined
        : toCents(input.cart.promotionDiscountAmount);
      const lineItems = input.cart.lineItems.map((lineItem) => ({
        productId: lineItem.productId,
        ...(lineItem.variantId ? { variantId: lineItem.variantId } : {}),
        sku: lineItem.sku,
        description: lineItem.description,
        quantity: lineItem.quantity,
        unitPriceCents: toCents(lineItem.price),
        ...(lineItem.originalPrice !== undefined ? { originalUnitPriceCents: toCents(lineItem.originalPrice) } : {}),
        ...(lineItem.manualDiscount !== undefined ? { manualDiscountCents: toCents(lineItem.manualDiscount) } : {}),
        ...(input.cart.promotionCode ? { promotionCode: input.cart.promotionCode } : {}),
        ...(promotionDiscountCents !== undefined ? { promotionDiscountCents } : {}),
        totalCents: toCents(lineItem.total),
        ...(lineItem.originalTotal !== undefined ? { originalTotalCents: toCents(lineItem.originalTotal) } : {}),
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
        currency: input.cart.currency,
        lineItems,
        paymentProvider: "helcim",
        ...(input.shippingAddress ? { shippingAddress: input.shippingAddress } : {}),
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
      const existingByInvoice = await repository.findOrderBySquareInvoiceId(input.squareInvoiceId);

      if (existingByInvoice) {
        return toPendingOrderRecord(existingByInvoice);
      }

      const existingByCorrelation = await repository.findOrderByCorrelationId(input.correlationId);

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

    async recordSquareInvoicePublication(orderId, invoiceId, publicUrl, version) {
      await repository.recordSquareInvoicePublication(orderId, invoiceId, publicUrl, version);
    },

    async markSquareInvoicePaid(orderId, paymentId) {
      await repository.markSquareInvoicePaid(orderId, paymentId);
    },

    async markSquareInvoiceFinalizationFailed(orderId, error, retryable) {
      await repository.markSquareInvoiceFinalizationFailed(orderId, error, retryable);
    },

    async findOrderBySquareInvoiceId(invoiceId) {
      return repository.findOrderBySquareInvoiceId(invoiceId);
    },

    async findOrderByCorrelationId(correlationId) {
      return repository.findOrderByCorrelationId(correlationId);
    },

    async markOrderPaid(orderId, helcimTransactionId) {
      await repository.markOrderPaid(orderId, helcimTransactionId);
    },

    async markOrderVerificationFailed(orderId) {
      await repository.markOrderVerificationFailed(orderId);
    },

    async getPendingOrderByCheckoutToken(checkoutToken) {
      const order = await repository.findCheckoutOrderByCheckoutTokenHash(
        hashCheckoutToken(checkoutToken),
      );

      if (!order || !isCheckoutTokenValidationEligible(order)) {
        return null;
      }

      return toPendingOrderRecord(order);
    },

    async recordHelcimWebhookEvent(input) {
      const result = await recordHelcimWebhookEventWithOrderInternal(repository, input);
      return result.recorded;
    },

    async recordHelcimWebhookEventWithOrder(input) {
      return recordHelcimWebhookEventWithOrderInternal(repository, input);
    },

    async claimSquareInvoiceWebhookEvent(input) {
      const createdEvent = await repository.createSquareInvoiceWebhookEvent(input);

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

const defaultOrderStore = createCheckoutOrderStore(createDrizzleCheckoutOrderRepository());

export async function createPendingOrder(
  input: CreatePendingOrderInput,
): Promise<PendingOrderRecord> {
  return defaultOrderStore.createPendingOrder(input);
}

export async function createPendingSquareInvoiceOrder(
  input: CreatePendingSquareInvoiceOrderInput,
): Promise<PendingOrderRecord> {
  return defaultOrderStore.createPendingSquareInvoiceOrder(input);
}

export async function markOrderPaid(
  orderId: string,
  helcimTransactionId: string,
): Promise<void> {
  await defaultOrderStore.markOrderPaid(orderId, helcimTransactionId);
}

export async function markOrderVerificationFailed(orderId: string): Promise<void> {
  await defaultOrderStore.markOrderVerificationFailed(orderId);
}

export async function recordSquareInvoicePublication(
  orderId: string,
  invoiceId: string,
  publicUrl: string,
  version: number,
): Promise<void> {
  await defaultOrderStore.recordSquareInvoicePublication(orderId, invoiceId, publicUrl, version);
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
  await defaultOrderStore.markSquareInvoiceFinalizationFailed(orderId, error, retryable);
}

export async function findOrderBySquareInvoiceId(
  invoiceId: string,
): Promise<CheckoutOrderRow | null> {
  return defaultOrderStore.findOrderBySquareInvoiceId(invoiceId);
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
  const order = await repository.findOrderForWebhook(input);
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
  });

  const paid = await reconcileWebhookPaidOrder({
    amountCents,
    input,
    order,
    repository,
  });

  return {
    matchedOrder: order ? toMatchedCheckoutOrderRecord(order) : null,
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

  if (input.order.status === "paid") {
    return true;
  }

  if (!input.input.helcimTransactionId || !isApprovedStatus(input.input.status)) {
    return false;
  }

  const expectedAmountMatches = input.amountCents !== null && input.amountCents === input.order.amountCents;
  const expectedCurrencyMatches = input.input.currency !== undefined &&
    input.input.currency.toUpperCase() === input.order.currency;

  if (!expectedAmountMatches || !expectedCurrencyMatches) {
    return false;
  }

  await input.repository.markOrderPaid(input.order.orderId, input.input.helcimTransactionId);
  return true;
}

function toMatchedCheckoutOrderRecord(order: CheckoutOrderRow): MatchedCheckoutOrderRecord {
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
    payloadHash: input.payloadSanitized ? hashPayload(input.payloadSanitized) : undefined,
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
    payloadHash: input.payloadSanitized ? hashPayload(input.payloadSanitized) : undefined,
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
        .onConflictDoNothing({ target: [checkoutPaymentEvents.paymentProvider, checkoutPaymentEvents.providerEventId] })
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

    async findCheckoutOrderByCheckoutTokenHash(checkoutTokenHash) {
      const [order] = await getPrivateDb()
        .select()
        .from(checkoutOrders)
        .where(
          and(
            eq(checkoutOrders.checkoutTokenHash, checkoutTokenHash),
            inArray(checkoutOrders.status, ["pending", "paid"]),
          ),
        )
        .limit(1);

      return order ?? null;
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
      await getPrivateDb()
        .update(checkoutOrders)
        .set({
          status: "paid",
          helcimTransactionId,
          paidAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(checkoutOrders.orderId, orderId));
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

    async recordSquareInvoicePublication(orderId, invoiceId, publicUrl, version) {
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

function toPendingOrderRecord(pendingOrder: CheckoutOrderRow): PendingOrderRecord {
  const currency = pendingOrder.currency.toUpperCase();

  if (currency !== "CAD") {
    throw new Error("Unsupported checkout order currency");
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

async function findOrderForWebhook(input: HelcimWebhookEventInput): Promise<CheckoutOrderRow | null> {
  if (input.helcimInvoiceId === undefined && input.helcimInvoiceNumber === undefined) {
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
    .where(and(eq(checkoutOrders.paymentProvider, "helcim"), ...invoiceConditions))
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
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

function isApprovedStatus(status: string | undefined): boolean {
  return status !== undefined && ["approved", "completed", "success", "succeeded", "true"].includes(
    status.trim().toLowerCase(),
  );
}

function isCheckoutTokenValidationEligible(order: CheckoutOrderRow): boolean {
  if (order.paymentProvider !== "helcim") {
    return false;
  }

  if (order.status === "pending") {
    return true;
  }

  return order.status === "paid" && isAppointmentPurpose(order.purpose);
}

function isAppointmentPurpose(purpose: CheckoutOrderPurpose): boolean {
  return purpose === "appointment_deposit" ||
    purpose === "appointment_full" ||
    purpose === "appointment_custom_partial";
}
