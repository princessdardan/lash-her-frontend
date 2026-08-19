import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run customer email outbox DB tests";

const scenario = String.raw`
  import assert from "node:assert/strict";
  import { eq, inArray } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import { checkoutOrders, customerEmailOutbox } from "./src/lib/private-db/schema.ts";
  import {
    claimCustomerEmails,
    completeCustomerEmail,
    enqueueCustomerEmail,
    failCustomerEmail,
    requeueDeadLetterCustomerEmail,
  } from "./src/lib/commerce/customer-email-outbox.ts";
  import { enqueuePaidProductOrderConfirmationEmail } from "./src/lib/commerce/order-store.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL.includes("?")
    ? process.env.TEST_DATABASE_URL + "&sslmode=disable"
    : process.env.TEST_DATABASE_URL + "?sslmode=disable";
  process.env.CHECKOUT_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

  const db = getPrivateDb();
  const prefix = "email-outbox-db-test-" + crypto.randomUUID();
  const createdOrderIds = [];
  const createdOutboxKeys = [];
  try {
    const orderPrivacyDeadline = new Date("2026-09-01T12:00:00.000Z");
    const [order] = await db.insert(checkoutOrders).values({
      orderId: prefix,
      purpose: "product",
      status: "paid",
      customerName: "Outbox Customer",
      customerEmail: "outbox@example.invalid",
      amountCents: 1000,
      merchandiseAmountCents: 1000,
      lineItems: [],
      paymentRiskStatus: "cleared",
      fulfillmentMode: "manual_pickup",
      manualFulfillmentStatus: "paid_pending_dispatch",
      piiRedactionDueAt: orderPrivacyDeadline,
    }).returning();
    createdOrderIds.push(order.id);

    const queued = await enqueuePaidProductOrderConfirmationEmail({
      orderId: order.orderId,
      now: new Date("2026-08-15T12:00:00.000Z"),
    });
    assert.equal(queued?.orderDatabaseId, order.id);
    const [stored] = await db.select().from(customerEmailOutbox).where(
      eq(customerEmailOutbox.providerIdempotencyKey, "product-confirmation:" + order.orderId),
    );
    assert.equal(stored.orderId, order.id, "the durable email keeps its order FK");
    assert.equal(
      stored.redactionDueAt.toISOString(),
      orderPrivacyDeadline.toISOString(),
      "the email cannot outlive the linked order privacy deadline",
    );
    assert.equal(await enqueueCustomerEmail({
      kind: "product_order_confirmation",
      orderDatabaseId: order.id,
      payload: queued,
      providerIdempotencyKey: "product-confirmation:" + order.orderId,
      recipient: order.customerEmail,
    }), false, "the provider idempotency key prevents duplicate enqueue");
    await assert.rejects(
      enqueueCustomerEmail({
        kind: "shipping_customer_update",
        payload: { orderReference: order.orderId },
        providerIdempotencyKey: prefix + ":unlinked-rejected",
        recipient: order.customerEmail,
        now: new Date("2026-08-15T12:00:00.000Z"),
      }),
      /requires an active linked product order/,
    );
    const policyAlertKey = prefix + ":policy-alert";
    createdOutboxKeys.push(policyAlertKey);
    assert.equal(await enqueueCustomerEmail({
      kind: "shipping_policy_alert",
      payload: { subject: "Owner alert" },
      providerIdempotencyKey: policyAlertKey,
      recipient: "owner@example.invalid",
      now: new Date("2026-08-15T12:00:00.000Z"),
    }), true, "non-customer policy alerts remain intentionally unlinked");

    const pastDeadlineKey = prefix + ":past-deadline";
    createdOutboxKeys.push(pastDeadlineKey);
    await db.insert(customerEmailOutbox).values({
      orderId: order.id,
      kind: "shipping_customer_update",
      recipientCiphertext: "expired-recipient-ciphertext",
      templateDataCiphertext: "expired-template-ciphertext",
      providerIdempotencyKey: pastDeadlineKey,
      status: "queued",
      availableAt: new Date("2026-08-15T11:00:00.000Z"),
      redactionDueAt: new Date("2026-08-15T12:00:30.000Z"),
    });

    const firstNow = new Date("2026-08-15T12:01:00.000Z");
    const first = await claimCustomerEmails({ leaseOwner: "worker-a", now: firstNow });
    assert.equal(
      first.some((entry) => entry.providerIdempotencyKey === pastDeadlineKey),
      false,
      "delivery never starts after the row privacy deadline",
    );
    const claimedA = first.find((entry) => entry.id === stored.id);
    assert.ok(claimedA);
    const beforeExpiry = await claimCustomerEmails({
      leaseOwner: "worker-b",
      now: new Date(firstNow.getTime() + 4 * 60_000),
    });
    assert.equal(beforeExpiry.some((entry) => entry.id === stored.id), false);
    const afterExpiry = await claimCustomerEmails({
      leaseOwner: "worker-b",
      now: new Date(firstNow.getTime() + 6 * 60_000),
    });
    assert.ok(afterExpiry.some((entry) => entry.id === stored.id));
    assert.equal(await completeCustomerEmail({
      id: stored.id,
      leaseOwner: "worker-a",
      providerMessageId: "stale",
    }), false, "a stale worker cannot complete another worker's lease");
    assert.equal(await completeCustomerEmail({
      id: stored.id,
      leaseOwner: "worker-b",
      providerMessageId: "provider-message-1",
    }), true);

    const malformedKey = prefix + ":malformed";
    createdOutboxKeys.push(malformedKey);
    await db.insert(customerEmailOutbox).values({
      orderId: order.id,
      kind: "shipping_customer_update",
      recipientCiphertext: "not-ciphertext",
      templateDataCiphertext: "not-ciphertext",
      providerIdempotencyKey: malformedKey,
      status: "queued",
      availableAt: firstNow,
      redactionDueAt: orderPrivacyDeadline,
    });
    const malformed = await claimCustomerEmails({
      leaseOwner: "worker-c",
      now: new Date("2026-08-15T12:10:00.000Z"),
    });
    const decoded = malformed.find((entry) => entry.providerIdempotencyKey === malformedKey);
    assert.ok(decoded);
    assert.match(decoded?.decodeError ?? "", /ciphertext|decrypt/i);
    assert.equal(await failCustomerEmail({
      id: decoded.id,
      leaseOwner: "worker-c",
      error: decoded.decodeError,
      now: new Date("2026-08-15T12:10:00.000Z"),
    }), true);
    await db.update(customerEmailOutbox).set({
      status: "sending",
      attemptCount: 7,
      leaseOwner: "worker-d",
      leaseExpiresAt: new Date("2026-08-15T12:20:00.000Z"),
    }).where(eq(customerEmailOutbox.id, decoded.id));
    const deadLetterAt = new Date("2026-08-15T12:15:00.000Z");
    assert.equal(await failCustomerEmail({
      id: decoded.id,
      leaseOwner: "worker-d",
      error: "poison payload",
      now: deadLetterAt,
    }), true);
    const [deadLetter] = await db.select().from(customerEmailOutbox).where(
      eq(customerEmailOutbox.id, decoded.id),
    );
    assert.equal(deadLetter.status, "dead_letter");
    assert.equal(deadLetter.attemptCount, 8);
    const futureClaims = await claimCustomerEmails({
      leaseOwner: "worker-e",
      now: new Date("2027-08-15T12:15:00.000Z"),
    });
    assert.equal(futureClaims.some((entry) => entry.id === decoded.id), false);
    assert.equal(await requeueDeadLetterCustomerEmail({
      id: decoded.id,
      expectedUpdatedAt: new Date(deadLetter.updatedAt.getTime() - 1),
      now: new Date("2026-08-15T12:16:00.000Z"),
    }), false, "stale owner actions cannot requeue a dead letter");
    assert.equal(await requeueDeadLetterCustomerEmail({
      id: decoded.id,
      expectedUpdatedAt: deadLetter.updatedAt,
      now: new Date("2026-08-15T12:16:00.000Z"),
    }), true);
    const requeued = await claimCustomerEmails({
      leaseOwner: "worker-f",
      now: new Date("2026-08-15T12:16:00.000Z"),
    });
    assert.ok(requeued.some((entry) => entry.id === decoded.id));
  } finally {
    if (createdOutboxKeys.length) {
      await db.delete(customerEmailOutbox).where(
        inArray(customerEmailOutbox.providerIdempotencyKey, createdOutboxKeys),
      );
    }
    if (createdOrderIds.length) {
      await db.delete(customerEmailOutbox).where(inArray(customerEmailOutbox.orderId, createdOrderIds));
      await db.delete(checkoutOrders).where(inArray(checkoutOrders.id, createdOrderIds));
    }
    await closePrivateDbPool();
  }
`;

test(
  "customer email outbox is atomic, idempotent, lease-fenced, and fail-closed on malformed ciphertext",
  { skip: dbTestSkipReason },
  () => {
    execFileSync(
      process.execPath,
      [
        "--conditions=react-server",
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        scenario,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NEXT_PUBLIC_SANITY_DATASET:
            process.env.NEXT_PUBLIC_SANITY_DATASET ?? "test-dataset",
          NEXT_PUBLIC_SANITY_PROJECT_ID:
            process.env.NEXT_PUBLIC_SANITY_PROJECT_ID ?? "test-project",
        },
        stdio: "inherit",
      },
    );
  },
);
