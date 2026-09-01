import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run customer email outbox DB tests";

const scenario = String.raw`
  import assert from "node:assert/strict";
  import { eq, inArray } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import { checkoutOrders, customerEmailOutbox, marketingContactSubmissions } from "./src/lib/private-db/schema.ts";
  import {
    claimCustomerEmailById,
    claimCustomerEmails,
    completeCustomerEmail,
    enqueueCustomerEmail,
    enqueueCustomerEmailWithResult,
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
  const createdSubmissionIds = [];
  const errorChainMatches = (error, pattern) => {
    let current = error;
    while (current instanceof Error) {
      if (pattern.test(current.message)) return true;
      current = current.cause;
    }
    return false;
  };
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

    const offerNow = new Date("2026-08-15T12:00:00.000Z");
    const [submission] = await db.insert(marketingContactSubmissions).values({
      submissionType: "contact_popup",
      email: "offer@example.invalid",
      emailNormalized: "offer@example.invalid",
      source: "contact_popup",
      sourcePath: "/",
      consentChoice: "opted_in",
      consentText: "Email me news and offers.",
      payload: { variant: "emailOnly" },
      submittedAt: offerNow,
    }).returning();
    createdSubmissionIds.push(submission.id);
    const offerPayload = {
      submissionId: submission.id,
      recipientEmail: "offer@example.invalid",
      variant: "emailOnly",
      promotionId: "promotion-1",
      promotionRevision: "revision-1",
      promotionCode: "WELCOME20",
      discountType: "percentage",
      discountAmount: 20,
      appliesTo: "all",
      offerLabel: "Welcome offer",
      offerTerms: "Valid on eligible purchases.",
      ctaLabel: "Shop now",
      ctaUrl: "https://lashher.com/products",
      resolvedAt: offerNow.toISOString(),
    };
    const offerKey = prefix + ":contact-popup-offer";
    createdOutboxKeys.push(offerKey);
    const offerEnqueue = await enqueueCustomerEmailWithResult({
      kind: "contact_popup_offer",
      submissionDatabaseId: submission.id,
      payload: offerPayload,
      providerIdempotencyKey: offerKey,
      recipient: "Offer@Example.invalid",
      now: offerNow,
    });
    assert.equal(offerEnqueue.inserted, true);
    assert.ok(offerEnqueue.id);
    const [storedOffer] = await db.select().from(customerEmailOutbox).where(
      eq(customerEmailOutbox.id, offerEnqueue.id),
    );
    assert.equal(storedOffer.orderId, null);
    assert.equal(storedOffer.submissionId, submission.id);
    assert.equal(storedOffer.recipientEmailNormalized, "offer@example.invalid");
    assert.equal(
      storedOffer.redactionDueAt.toISOString(),
      "2027-08-15T12:00:00.000Z",
      "the offer outbox retains PII for no more than 365 days",
    );
    assert.deepEqual(await enqueueCustomerEmailWithResult({
      kind: "contact_popup_offer",
      submissionDatabaseId: submission.id,
      payload: offerPayload,
      providerIdempotencyKey: offerKey,
      recipient: "offer@example.invalid",
      now: offerNow,
    }), { id: null, inserted: false });
    await assert.rejects(
      enqueueCustomerEmailWithResult({
        kind: "contact_popup_offer",
        submissionDatabaseId: submission.id,
        payload: { ...offerPayload, recipientEmail: "other@example.invalid" },
        providerIdempotencyKey: prefix + ":wrong-recipient",
        recipient: "other@example.invalid",
        now: offerNow,
      }),
      /recipient does not match its linked submission/,
    );
    const [nonOptedInSubmission] = await db.insert(marketingContactSubmissions).values({
      submissionType: "contact_popup",
      email: "declined@example.invalid",
      emailNormalized: "declined@example.invalid",
      source: "contact_popup",
      consentChoice: "not_opted_in",
      payload: { variant: "emailOnly" },
      submittedAt: offerNow,
    }).returning();
    createdSubmissionIds.push(nonOptedInSubmission.id);
    await assert.rejects(
      enqueueCustomerEmailWithResult({
        kind: "contact_popup_offer",
        submissionDatabaseId: nonOptedInSubmission.id,
        payload: {
          ...offerPayload,
          submissionId: nonOptedInSubmission.id,
          recipientEmail: "declined@example.invalid",
        },
        providerIdempotencyKey: prefix + ":not-opted-in",
        recipient: "declined@example.invalid",
        now: offerNow,
      }),
      /requires a linked opted-in contact popup submission/,
    );
    const [wrongTypeSubmission] = await db.insert(marketingContactSubmissions).values({
      submissionType: "general_inquiry",
      email: "inquiry@example.invalid",
      emailNormalized: "inquiry@example.invalid",
      source: "general_inquiry",
      consentChoice: "opted_in",
      payload: { subject: "Question" },
      submittedAt: offerNow,
    }).returning();
    createdSubmissionIds.push(wrongTypeSubmission.id);
    await assert.rejects(
      enqueueCustomerEmailWithResult({
        kind: "contact_popup_offer",
        submissionDatabaseId: wrongTypeSubmission.id,
        payload: {
          ...offerPayload,
          submissionId: wrongTypeSubmission.id,
          recipientEmail: "inquiry@example.invalid",
        },
        providerIdempotencyKey: prefix + ":wrong-submission-type",
        recipient: "inquiry@example.invalid",
        now: offerNow,
      }),
      /requires a linked opted-in contact popup submission/,
    );
    await assert.rejects(
      db.insert(customerEmailOutbox).values({
        kind: "contact_popup_offer",
        submissionId: submission.id,
        recipientCiphertext: "opaque",
        recipientEmailNormalized: "other@example.invalid",
        templateDataCiphertext: "opaque",
        providerIdempotencyKey: prefix + ":trigger-wrong-recipient",
        status: "queued",
        availableAt: offerNow,
        redactionDueAt: new Date("2027-08-15T12:00:00.000Z"),
      }),
      (error) => errorChainMatches(error, /recipient does not match submission/),
    );
    const targetedOffer = await claimCustomerEmailById({
      id: offerEnqueue.id,
      leaseOwner: "offer-worker",
      now: offerNow,
    });
    assert.equal(targetedOffer?.id, offerEnqueue.id);
    const [unrelatedPolicyAlert] = await db.select().from(customerEmailOutbox).where(
      eq(customerEmailOutbox.providerIdempotencyKey, policyAlertKey),
    );
    assert.equal(unrelatedPolicyAlert.status, "queued", "targeted claim does not claim unrelated jobs");
    assert.equal(await completeCustomerEmail({
      id: offerEnqueue.id,
      leaseOwner: "offer-worker",
      providerMessageId: "offer-message-1",
      now: offerNow,
    }), true);
      await assert.rejects(
        db.delete(marketingContactSubmissions).where(
          eq(marketingContactSubmissions.id, submission.id),
        ),
        (error) => errorChainMatches(error, /requires a submission link/),
        "an active offer prevents its linked submission from being deleted",
      );
    await db.update(customerEmailOutbox).set({
      recipientCiphertext: "[redacted]",
      templateDataCiphertext: "[redacted]",
      redactedAt: new Date("2027-08-15T12:00:00.000Z"),
    }).where(eq(customerEmailOutbox.id, offerEnqueue.id));
    const [redactedOffer] = await db.select().from(customerEmailOutbox).where(
      eq(customerEmailOutbox.id, offerEnqueue.id),
    );
    assert.equal(redactedOffer.recipientEmailNormalized, null);
    await db.delete(marketingContactSubmissions).where(
      eq(marketingContactSubmissions.id, submission.id),
    );
    const [unlinkedRedactedOffer] = await db.select().from(customerEmailOutbox).where(
      eq(customerEmailOutbox.id, offerEnqueue.id),
    );
    assert.equal(unlinkedRedactedOffer.submissionId, null);

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
    if (createdSubmissionIds.length) {
      await db.delete(marketingContactSubmissions).where(
        inArray(marketingContactSubmissions.id, createdSubmissionIds),
      );
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
