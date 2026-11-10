import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { inArray } from "drizzle-orm";
import { closePrivateDbPool, getPrivateDb } from "@/lib/private-db/client";
import { checkoutOrders } from "@/lib/private-db/schema";
import { withWriterOperationContext } from "@/lib/writer-admission/context";
import {
  createPendingSquareInvoiceOrder,
  findCheckoutOrderByOrderId,
  markSquareInvoicePaid,
  recordSquareInvoicePublication,
} from "./order-store";

test("invoice publication requires a write receipt or the same verified paid invoice", {
  skip: !process.env.TEST_DATABASE_URL && "set TEST_DATABASE_URL to an owned loopback database",
}, async () => {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  assert.match(url.pathname, /^\/lash_her_[a-z0-9_]+$/u);
  assert.ok(!url.searchParams.has("host") && !url.searchParams.has("port"));
  if (!url.port) url.port = "5432";
  process.env.DATABASE_URL = url.href;
  process.env.CHECKOUT_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

  const orderIds: string[] = [];
  async function createOrder() {
    const reference = randomUUID();
    const invoiceId = `owned-invoice-${reference}`;
    const order = await createPendingSquareInvoiceOrder({
      amountCents: 10000,
      checkoutToken: reference,
      correlationId: reference,
      customerEmail: "owned@example.invalid",
      customerName: "Fixture Learner",
      programSlug: "owned-training",
      secretToken: reference,
      squareCustomerId: `owned-customer-${reference}`,
      squareInvoiceId: invoiceId,
      squareInvoiceVersion: 1,
      squareOrderId: `owned-order-${reference}`,
    });
    assert.ok(order.orderId);
    orderIds.push(order.orderId);
    return { orderId: order.orderId, invoiceId };
  }

  const publicUrl = "https://invoice.example.invalid/owned";
  const publish = (orderId: string, invoiceId: string) =>
    withWriterOperationContext(() =>
      recordSquareInvoicePublication(orderId, invoiceId, publicUrl, 2),
    );
  try {
    const pending = await createOrder();
    await assert.rejects(publish(pending.orderId, "unmatched"), /WRITER_OPERATION_REQUIRES_REVIEW/u);
    const unchanged = await findCheckoutOrderByOrderId(pending.orderId);
    assert.equal(unchanged?.providerCheckoutId, pending.invoiceId);
    assert.equal(unchanged?.providerStatus, "draft");

    await publish(pending.orderId, pending.invoiceId);
    await publish(pending.orderId, pending.invoiceId);
    const published = await findCheckoutOrderByOrderId(pending.orderId);
    assert.equal(published?.providerStatus, "published");
    assert.equal(published?.providerMetadata?.squareInvoicePublicUrl, publicUrl);

    const paid = await createOrder();
    await markSquareInvoicePaid(paid.orderId, "owned-payment");
    await publish(paid.orderId, paid.invoiceId);
    await assert.rejects(publish(paid.orderId, pending.invoiceId), /WRITER_OPERATION_REQUIRES_REVIEW/u);
    const verified = await findCheckoutOrderByOrderId(paid.orderId);
    assert.equal(verified?.status, "paid");
    assert.equal(verified?.providerStatus, "paid");
    assert.equal(verified?.providerCheckoutId, paid.invoiceId);
    assert.equal(verified?.providerPaymentId, "owned-payment");
  } finally {
    try {
      if (orderIds.length) {
        await getPrivateDb().delete(checkoutOrders).where(inArray(checkoutOrders.orderId, orderIds));
      }
    } finally {
      await closePrivateDbPool();
    }
  }
});
