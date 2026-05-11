import "server-only";

import { createHmac } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import type { CheckoutOrderLineItemSnapshot } from "@/lib/private-db/schema";
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
  findPendingOrderByCheckoutTokenHash(checkoutTokenHash: string): Promise<CheckoutOrderRow | null>;
  markOrderPaid(orderId: string, helcimTransactionId: string): Promise<void>;
  markOrderVerificationFailed(orderId: string): Promise<void>;
}

export interface CheckoutOrderStore {
  createPendingOrder(input: CreatePendingOrderInput): Promise<PendingOrderRecord>;
  getPendingOrderByCheckoutToken(checkoutToken: string): Promise<PendingOrderRecord | null>;
  markOrderPaid(orderId: string, helcimTransactionId: string): Promise<void>;
  markOrderVerificationFailed(orderId: string): Promise<void>;
  recordHelcimWebhookEvent(input: HelcimWebhookEventInput): Promise<boolean>;
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
      };
    },

    async markOrderPaid(orderId, helcimTransactionId) {
      await repository.markOrderPaid(orderId, helcimTransactionId);
    },

    async markOrderVerificationFailed(orderId) {
      await repository.markOrderVerificationFailed(orderId);
    },

    async getPendingOrderByCheckoutToken(checkoutToken) {
      const pendingOrder = await repository.findPendingOrderByCheckoutTokenHash(
        hashCheckoutToken(checkoutToken),
      );

      if (!pendingOrder) {
        return null;
      }

      return toPendingOrderRecord(pendingOrder);
    },

    async recordHelcimWebhookEvent(input) {
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

      if (!createdEvent) {
        return false;
      }

      if (order && input.helcimTransactionId && isApprovedStatus(input.status)) {
        const expectedAmountMatches = amountCents !== null && amountCents === order.amountCents;
        const expectedCurrencyMatches = input.currency !== undefined && input.currency.toUpperCase() === order.currency;

        if (expectedAmountMatches && expectedCurrencyMatches) {
          await repository.markOrderPaid(order.orderId, input.helcimTransactionId);
        }
      }

      return true;
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

    async findPendingOrderByCheckoutTokenHash(checkoutTokenHash) {
      const [pendingOrder] = await getPrivateDb()
        .select()
        .from(checkoutOrders)
        .where(
          and(
            eq(checkoutOrders.checkoutTokenHash, checkoutTokenHash),
            eq(checkoutOrders.status, "pending"),
          ),
        )
        .limit(1);

      return pendingOrder ?? null;
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
