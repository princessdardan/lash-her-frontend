import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run payment initialization reconciliation tests";

const scenario = String.raw`
  import assert from "node:assert/strict";
  import { eq, inArray, like } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import {
    adminAuditLogs,
    adminUsers,
    checkoutOrders,
    fulfillmentOwnerActions,
    orderPaymentObligations,
  } from "./src/lib/private-db/schema.ts";
  import {
    preparePaymentObligationInitializationReconciliation,
    reconcilePaymentObligationInitialization,
  } from "./src/lib/commerce/product-payment-obligation-reconciliation.ts";
  import { buildPaymentObligationInvoicePlan } from "./src/lib/commerce/product-payment-invoice-plan.ts";
  import { paymentObligationInitializationProviderPhase } from "./src/lib/commerce/product-payment-obligation-initialization-plan.ts";

  void (async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL.includes("?")
    ? process.env.TEST_DATABASE_URL + "&sslmode=disable"
    : process.env.TEST_DATABASE_URL + "?sslmode=disable";
  const db = getPrivateDb();
  const fixture = crypto.randomUUID();
  const prefix = "lh-payment-init-reconcile-" + fixture;
  let ownerId;

  async function seed(suffix, providerInvoice) {
    const [order] = await db.insert(checkoutOrders).values({
      orderId: prefix + "-" + suffix,
      purpose: "product",
      status: "pending",
      customerName: "Payment Reconciliation Test",
      customerEmail: "payment-reconciliation@example.invalid",
      amountCents: 12345,
      merchandiseAmountCents: 10000,
      shippingAmountCents: 2345,
      currency: "CAD",
      lineItems: [{
        productId: "product-" + suffix,
        productName: "Payment reconciliation item",
        sku: "PAYMENT-RECONCILIATION",
        description: "Payment reconciliation item",
        quantity: 1,
        unitPriceCents: 10000,
        totalCents: 10000,
      }],
      paymentProvider: "helcim",
      paymentRiskStatus: "pending",
      fulfillmentMode: "manual_pickup",
    }).returning({ id: checkoutOrders.id, orderId: checkoutOrders.orderId });
    const [obligation] = await db.insert(orderPaymentObligations).values({
      orderId: order.id,
      purpose: "primary",
      status: "pending",
      merchandiseAmountCents: 10000,
      shippingAmountCents: 2345,
      taxAmountCents: 0,
      totalAmountCents: 12345,
      currency: "CAD",
      sourceWorkflow: "payment_initialization_reconciliation_test",
      taxPolicyVersion: "test-tax-v1",
      policyVersion: "test-policy-v1",
      initializationStatus: "failed",
      initializationOutcome: "outcome_unknown",
      initializationLastError: "provider outcome unknown",
      initializationPayloadHash: "v2:" + "a".repeat(64),
      providerInvoiceId: providerInvoice?.id,
      providerInvoiceNumber: providerInvoice?.number,
      idempotencyKey: "primary/" + order.orderId,
      updatedAt: new Date(Date.now() - 10 * 60_000),
    }).returning();
    return { order, obligation };
  }

  async function prepareAndCommit(fixture, input, gateway) {
    const prepared = await preparePaymentObligationInitializationReconciliation({
      ...input,
      gateway,
    });
    return reconcilePaymentObligationInitialization({
      ...input,
      actorAdminUserId: ownerId,
      evidenceReference: "helcim-api://lookup/" + fixture,
      providerEvidence: prepared.providerEvidence,
      rationale: "Certified Helcim API evidence matches the immutable payment obligation.",
      stepUpAuthenticatedAt: new Date(),
    });
  }

  try {
    const ownerEmail = "payment-init-owner-" + fixture + "@example.invalid";
    process.env.ADMIN_OWNER_EMAILS = ownerEmail;
    const [owner] = await db.insert(adminUsers).values({
      providerUserId: "payment-init-owner-" + fixture,
      email: ownerEmail,
      emailNormalized: ownerEmail,
      role: "owner",
      status: "active",
    }).returning({ id: adminUsers.id });
    ownerId = owner.id;

    const createUnknown = await seed("create-unknown", null);
    const recoveredCreate = await prepareAndCommit(fixture, {
      action: "confirm_no_payable_state_and_reissue",
      expectedStateVersion: createUnknown.obligation.initializationStateVersion,
      obligationId: createUnknown.obligation.id,
      orderReference: createUnknown.order.orderId,
    }, {
      getInvoicesByNumber: async () => [],
    });
    assert.equal(recoveredCreate.initializationStatus, "initializing");
    assert.equal(recoveredCreate.initializationOutcome, null);
    const [createQueued] = await db.select().from(orderPaymentObligations)
      .where(eq(orderPaymentObligations.id, createUnknown.obligation.id));
    assert.equal(paymentObligationInitializationProviderPhase(createQueued), "create_invoice");

    await assert.rejects(
      preparePaymentObligationInitializationReconciliation({
        action: "confirm_no_payable_state_and_reissue",
        expectedStateVersion: createUnknown.obligation.initializationStateVersion,
        obligationId: createUnknown.obligation.id,
        orderReference: createUnknown.order.orderId,
        gateway: { getInvoicesByNumber: async () => [] },
      }),
      /changed|reconciliation/,
    );

    const payUnknown = await seed("pay-unknown", { id: 41001, number: "INV-41001" });
    await assert.rejects(
      preparePaymentObligationInitializationReconciliation({
        action: "confirm_no_payable_state_and_reissue",
        expectedStateVersion: payUnknown.obligation.initializationStateVersion,
        obligationId: payUnknown.obligation.id,
        orderReference: payUnknown.order.orderId,
        gateway: { getInvoicesByNumber: async () => [] },
      }),
      /manual handoff/,
    );
    const payPrepared = await preparePaymentObligationInitializationReconciliation({
      action: "record_manual_handoff",
      expectedStateVersion: payUnknown.obligation.initializationStateVersion,
      obligationId: payUnknown.obligation.id,
      orderReference: payUnknown.order.orderId,
    });
    await reconcilePaymentObligationInitialization({
      action: "record_manual_handoff",
      actorAdminUserId: owner.id,
      evidenceReference: "helcim-case://pay-session-" + fixture,
      expectedStateVersion: payUnknown.obligation.initializationStateVersion,
      obligationId: payUnknown.obligation.id,
      orderReference: payUnknown.order.orderId,
      providerEvidence: payPrepared.providerEvidence,
      rationale: "Provider support must resolve the ambiguous HelcimPay session.",
      stepUpAuthenticatedAt: new Date(),
    });
    const [payQueued] = await db.select().from(orderPaymentObligations)
      .where(eq(orderPaymentObligations.id, payUnknown.obligation.id));
    assert.equal(payQueued.providerInvoiceId, 41001);
    assert.equal(payQueued.providerInvoiceNumber, "INV-41001");
    assert.equal(payQueued.initializationOutcome, "manual_review");

    const adopted = await seed("adopt", null);
    const adoptedPlan = buildPaymentObligationInvoicePlan(adopted.obligation, {
      lineItems: [{
        productId: "product-adopt",
        productName: "Payment reconciliation item",
        sku: "PAYMENT-RECONCILIATION",
        description: "Payment reconciliation item",
        quantity: 1,
        unitPriceCents: 10000,
        totalCents: 10000,
      }],
      promotionCode: null,
      promotionDiscountCents: 0,
      shippingAmountCents: 2345,
    });
    await prepareAndCommit(fixture, {
      action: "adopt_invoice",
      expectedStateVersion: adopted.obligation.initializationStateVersion,
      obligationId: adopted.obligation.id,
      orderReference: adopted.order.orderId,
      providerInvoiceId: 42001,
    }, {
      getInvoice: async () => ({
        amount: 123.45,
        currency: "CAD",
        invoiceId: 42001,
        invoiceNumber: "INV-42001",
        lineItems: adoptedPlan.lineItems,
        notes: adoptedPlan.notes,
        status: "DUE",
        type: "INVOICE",
      }),
    });
    const [adoptedQueued] = await db.select().from(orderPaymentObligations)
      .where(eq(orderPaymentObligations.id, adopted.obligation.id));
    assert.equal(paymentObligationInitializationProviderPhase(adoptedQueued), "initialize_pay");

    const handoff = await seed("manual", null);
    const manualPrepared = await preparePaymentObligationInitializationReconciliation({
      action: "record_manual_handoff",
      expectedStateVersion: handoff.obligation.initializationStateVersion,
      obligationId: handoff.obligation.id,
      orderReference: handoff.order.orderId,
    });
    const manual = await reconcilePaymentObligationInitialization({
      action: "record_manual_handoff",
      actorAdminUserId: owner.id,
      evidenceReference: "helcim-case://manual-review-" + fixture,
      expectedStateVersion: handoff.obligation.initializationStateVersion,
      obligationId: handoff.obligation.id,
      orderReference: handoff.order.orderId,
      providerEvidence: manualPrepared.providerEvidence,
      rationale: "Provider support must resolve the ambiguous mutation before any further payment setup.",
      stepUpAuthenticatedAt: new Date(),
    });
    assert.equal(manual.initializationStatus, "failed");
    assert.equal(manual.initializationOutcome, "manual_review");
    const audits = await db.select().from(adminAuditLogs).where(inArray(
      adminAuditLogs.targetId,
      [createUnknown.obligation.id, payUnknown.obligation.id, adopted.obligation.id, handoff.obligation.id],
    ));
    assert.equal(audits.length, 4);
    assert.ok(audits.every((row) => row.actorAdminUserId === owner.id));
    assert.ok(audits.every((row) => typeof row.metadata?.providerEvidenceHash === "string"));
    assert.ok(audits.every((row) => row.metadata?.evidenceReference === undefined));
    assert.ok(audits.every((row) => row.metadata?.rationale === undefined));
    const ownerActions = await db.select().from(fulfillmentOwnerActions).where(inArray(
      fulfillmentOwnerActions.targetId,
      [createUnknown.obligation.id, payUnknown.obligation.id, adopted.obligation.id, handoff.obligation.id],
    ));
    assert.equal(ownerActions.length, 4);
    assert.ok(ownerActions.every((row) => typeof row.evidence?.evidenceReference === "string"));
  } finally {
    if (ownerId) {
      await db.delete(fulfillmentOwnerActions).where(
        eq(fulfillmentOwnerActions.adminUserId, ownerId),
      );
    }
    if (ownerId) {
      await db.delete(adminAuditLogs).where(eq(adminAuditLogs.actorAdminUserId, ownerId));
    }
    await db.delete(orderPaymentObligations).where(inArray(
      orderPaymentObligations.orderId,
      db.select({ id: checkoutOrders.id }).from(checkoutOrders).where(like(checkoutOrders.orderId, prefix + "%")),
    ));
    await db.delete(checkoutOrders).where(like(checkoutOrders.orderId, prefix + "%"));
    if (ownerId) {
      await db.delete(adminUsers).where(eq(adminUsers.id, ownerId));
    }
    await closePrivateDbPool();
  }
  })();
`;

test(
  "owner reconciliation fences ambiguous invoice and initialize-pay recovery",
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
        env: process.env,
        stdio: "inherit",
      },
    );
  },
);
