import "server-only";

import { nanoid } from "nanoid";

import { writeClient } from "@/sanity/lib/write-client";

import type { ValidatedCart } from "./cart";
import { decryptCheckoutSecret, encryptCheckoutSecret } from "./checkout-secret";

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

interface CheckoutOrderDocument {
  _type: "checkoutOrder";
  orderId: string;
  status: "pending";
  checkoutToken: string;
  secretTokenCiphertext: string;
  helcimInvoiceId: number;
  helcimInvoiceNumber: string;
  customerName: string;
  customerEmail: string;
  amount: number;
  currency: ValidatedCart["currency"];
  lineItems: ValidatedCart["lineItems"];
}

const PENDING_ORDER_BY_CHECKOUT_TOKEN_QUERY = `*[
  _type == "checkoutOrder" &&
  status == "pending" &&
  checkoutToken == $checkoutToken
][0]{
  _id,
  orderId,
  secretTokenCiphertext,
  helcimInvoiceId,
  helcimInvoiceNumber,
  amount,
  currency
}`;

const ORDER_BY_ORDER_ID_QUERY = `*[_type == "checkoutOrder" && orderId == $orderId]`;

export async function createPendingOrder(
  input: CreatePendingOrderInput,
): Promise<PendingOrderRecord> {
  const orderId = `lh-${nanoid(12)}`;
  const secretTokenCiphertext = encryptCheckoutSecret(input.secretToken);
  const document: CheckoutOrderDocument = {
    _type: "checkoutOrder",
    orderId,
    status: "pending",
    checkoutToken: input.checkoutToken,
    secretTokenCiphertext,
    helcimInvoiceId: input.helcimInvoiceId,
    helcimInvoiceNumber: input.helcimInvoiceNumber,
    customerName: input.customerName,
    customerEmail: input.customerEmail,
    amount: input.cart.amount,
    currency: input.cart.currency,
    lineItems: input.cart.lineItems,
  };

  const createdOrder = await writeClient.create(document, {
    autoGenerateArrayKeys: true,
  });

  return {
    _id: createdOrder._id,
    orderId,
    secretToken: input.secretToken,
    helcimInvoiceId: input.helcimInvoiceId,
    helcimInvoiceNumber: input.helcimInvoiceNumber,
    amount: input.cart.amount,
    currency: input.cart.currency,
  };
}

export async function markOrderPaid(
  orderId: string,
  helcimTransactionId: string,
): Promise<void> {
  await writeClient
    .patch({ query: ORDER_BY_ORDER_ID_QUERY, params: { orderId } })
    .set({ status: "paid", helcimTransactionId })
    .commit();
}

export async function markOrderVerificationFailed(orderId: string): Promise<void> {
  await writeClient
    .patch({ query: ORDER_BY_ORDER_ID_QUERY, params: { orderId } })
    .set({ status: "verification_failed" })
    .commit();
}

interface PendingOrderCiphertextRecord {
  _id: string;
  orderId: string;
  secretTokenCiphertext: string;
  helcimInvoiceId: number;
  helcimInvoiceNumber: string;
  amount: number;
  currency: ValidatedCart["currency"];
}

export async function getPendingOrderByCheckoutToken(
  checkoutToken: string,
): Promise<PendingOrderRecord | null> {
  const pendingOrder = await writeClient.fetch<PendingOrderCiphertextRecord | null>(
    PENDING_ORDER_BY_CHECKOUT_TOKEN_QUERY,
    { checkoutToken },
  );

  if (pendingOrder === null) {
    return null;
  }

  return {
    _id: pendingOrder._id,
    orderId: pendingOrder.orderId,
    secretToken: decryptCheckoutSecret(pendingOrder.secretTokenCiphertext),
    helcimInvoiceId: pendingOrder.helcimInvoiceId,
    helcimInvoiceNumber: pendingOrder.helcimInvoiceNumber,
    amount: pendingOrder.amount,
    currency: pendingOrder.currency,
  };
}
