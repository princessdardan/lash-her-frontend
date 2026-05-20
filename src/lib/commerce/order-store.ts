import "server-only";

import { createHmac } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";

import type {
  CheckoutOrderLineItemSnapshot,
  CheckoutOrderPurpose,
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
}

export interface PendingOrderRecord {
  _id: string;
  orderId: string;
  secretToken: string;
  helcimInvoiceId: number;
  helcimInvoiceNumber: string;
  amount: number;
  currency: ValidatedCart["currency"];
  customerEmail: string;
  customerName: string;
  lineItems: CheckoutOrderLineItemSnapshot[];
  purpose: CheckoutOrderPurpose;
}


export interface MatchedCheckoutOrderRecord {
  _id: string;
  amount: number;
  currency: ValidatedCart["currency"];
  helcimInvoiceId: number;
  helcimInvoiceNumber: string;
  orderId: string;
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

export type CheckoutOrderRow = typeof checkoutOrders.$inferSelect;
type CheckoutOrderInsert = {
  amountCents: number;
  checkoutTokenHash: string;
  currency: ValidatedCart["currency"];
  customerEmail: string;
  customerName: string;
  helcimInvoiceId: number;
  helcimInvoiceNumber: string;
  lineItems: CheckoutOrderLineItemSnapshot[];
  orderId: string;
  purpose: CheckoutOrderPurpose;
  secretTokenCiphertext: string;
  status: "pending";
};
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
  createWebhookEvent(values: CheckoutPaymentEventInsert): Promise<{ id: string } | null>;
  findOrderForWebhook(input: HelcimWebhookEventInput): Promise<CheckoutOrderRow | null>;
  findCheckoutOrderByCheckoutTokenHash(checkoutTokenHash: string): Promise<CheckoutOrderRow | null>;
  markOrderPaid(orderId: string, helcimTransactionId: string): Promise<void>;
  markOrderVerificationFailed(orderId: string): Promise<void>;
}

export interface CheckoutOrderStore {
  createPendingOrder(input: CreatePendingOrderInput): Promise<PendingOrderRecord>;
  getPendingOrderByCheckoutToken(checkoutToken: string): Promise<PendingOrderRecord | null>;
  markOrderPaid(orderId: string, helcimTransactionId: string): Promise<void>;
  markOrderVerificationFailed(orderId: string): Promise<void>;
  recordHelcimWebhookEvent(input: HelcimWebhookEventInput): Promise<boolean>;
  recordHelcimWebhookEventWithOrder(input: HelcimWebhookEventInput): Promise<HelcimWebhookEventRecordResult>;
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
      const lineItems = input.cart.lineItems.map((lineItem) => ({
        productId: lineItem.productId,
        ...(lineItem.variantId ? { variantId: lineItem.variantId } : {}),
        sku: lineItem.sku,
        description: lineItem.description,
        quantity: lineItem.quantity,
        unitPriceCents: toCents(lineItem.price),
        totalCents: toCents(lineItem.total),
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
        purpose: input.purpose ?? "product",
      };
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
  };
}

const defaultOrderStore = createCheckoutOrderStore(createDrizzleCheckoutOrderRepository());

export async function createPendingOrder(
  input: CreatePendingOrderInput,
): Promise<PendingOrderRecord> {
  return defaultOrderStore.createPendingOrder(input);
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
  };
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

    async createWebhookEvent(values) {
      const [createdEvent] = await getPrivateDb()
        .insert(checkoutPaymentEvents)
        .values(values)
        .onConflictDoNothing({ target: checkoutPaymentEvents.idempotencyKey })
        .returning({ id: checkoutPaymentEvents.id });

      return createdEvent ?? null;
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
    purpose: pendingOrder.purpose,
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
    .where(and(...invoiceConditions))
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

function isApprovedStatus(status: string | undefined): boolean {
  return status !== undefined && ["approved", "completed", "success", "succeeded", "true"].includes(
    status.trim().toLowerCase(),
  );
}

function isCheckoutTokenValidationEligible(order: CheckoutOrderRow): boolean {
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
