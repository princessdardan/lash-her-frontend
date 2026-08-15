import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run case refund-remedy tests";

const scenario = String.raw`
  import assert from "node:assert/strict";
  import { eq } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import { encryptCheckoutIp } from "./src/lib/commerce/checkout-pii.ts";
  import {
    adminUsers,
    checkoutOrders,
    orderPaymentObligations,
    orderPaymentTransactions,
    productOrderAdjustments,
    productOrderRefunds,
    productShippingCases,
    shippingPolicyAssignments,
  } from "./src/lib/private-db/schema.ts";
  import { processProductOrderRefund } from "./src/lib/shipping/customer-refunds.ts";
  import { queueInventoryUnavailableRefund, resolveSettledInventoryUnavailableRefundCases } from "./src/lib/shipping/cases.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.CHECKOUT_PII_ENCRYPTION_KEY = Buffer.alloc(32, 29).toString("base64");
  const db = getPrivateDb();
  const fixture = crypto.randomUUID();
  let ownerId;
  let orderId;
  let caseId;

  function gateway(providerRefundId, originalTransactionId, amountCents) {
    return {
      createInvoice: async () => { throw new Error("unused"); },
      initializePay: async () => { throw new Error("unused"); },
      getCardTransaction: async () => { throw new Error("unused"); },
      refundPayment: async () => ({
        transactionId: providerRefundId,
        originalTransactionId,
        amount: (amountCents / 100).toFixed(2),
        currency: "CAD",
        status: "APPROVED",
        transactionType: "REFUND",
      }),
    };
  }

  try {
    const [owner] = await db.insert(adminUsers).values({
      providerUserId: "case-refund-owner-" + fixture,
      email: "case-refund-" + fixture + "@example.invalid",
      emailNormalized: "case-refund-" + fixture + "@example.invalid",
      role: "owner",
      status: "active",
    }).returning({ id: adminUsers.id, email: adminUsers.email });
    ownerId = owner.id;
    process.env.ADMIN_OWNER_EMAILS = owner.email;
    await db.insert(shippingPolicyAssignments).values([
      "business_owner",
      "operations_lead",
      "finance_owner",
      "payment_fraud_owner",
      "privacy_owner",
      "security_owner",
    ].map((duty) => ({
      duty,
      adminUserId: owner.id,
      assignedByAdminUserId: owner.id,
    })));
    const encryptedIp = encryptCheckoutIp("192.0.2.73");
    const [order] = await db.insert(checkoutOrders).values({
      orderId: "lh-case-refund-" + fixture,
      purpose: "product",
      status: "paid",
      customerName: "Case Refund Test",
      customerEmail: "case-refund@example.invalid",
      amountCents: 11500,
      merchandiseAmountCents: 10000,
      shippingAmountCents: 1500,
      currency: "CAD",
      lineItems: [],
      paymentProvider: "helcim",
      helcimTransactionId: "971001",
      refundOriginIpCiphertext: encryptedIp,
      paymentRiskStatus: "cleared",
      fulfillmentMode: "automated_shipping",
      paidAt: new Date(),
    }).returning({ id: checkoutOrders.id });
    orderId = order.id;
    const [shippingCase] = await db.insert(productShippingCases).values({
      orderId,
      type: "loss",
      status: "waiting_customer",
      cause: "Provider confirmed inventory replacement is unavailable",
    }).returning({ id: productShippingCases.id });
    caseId = shippingCase.id;
    const captures = [
      { purpose: "primary", providerId: "971001", merchandise: 10000, shipping: 500 },
      { purpose: "manual_shipping", providerId: "971002", merchandise: 0, shipping: 700 },
      { purpose: "address_increase", providerId: "971003", merchandise: 0, shipping: 300 },
    ];
    for (let index = 0; index < captures.length; index += 1) {
      const capture = captures[index];
      const total = capture.merchandise + capture.shipping;
      const [obligation] = await db.insert(orderPaymentObligations).values({
        orderId,
        purpose: capture.purpose,
        status: "paid",
        merchandiseAmountCents: capture.merchandise,
        shippingAmountCents: capture.shipping,
        taxAmountCents: 0,
        totalAmountCents: total,
        currency: "CAD",
        sourceWorkflow: "case_refund_test",
        taxPolicyVersion: "case-tax-v1",
        policyVersion: "case-policy-v1",
        initializationStatus: "ready",
        idempotencyKey: "case-refund/" + fixture + "/" + index,
        paidAt: new Date(),
      }).returning({ id: orderPaymentObligations.id });
      await db.insert(orderPaymentTransactions).values({
        obligationId: obligation.id,
        provider: "helcim",
        providerTransactionId: capture.providerId,
        amountCents: total,
        currency: "CAD",
        originatingIpCiphertext: encryptedIp,
        providerType: "PURCHASE",
        providerStatus: "APPROVED",
        riskStatus: "cleared",
        riskReasonCodes: [],
        capturedAt: new Date(),
      });
    }
    const result = await queueInventoryUnavailableRefund({
      caseId,
      requestedByAdminUserId: ownerId,
    });
    const rows = await db.select({
      refund: productOrderRefunds,
      component: productOrderAdjustments.component,
    }).from(productOrderRefunds).innerJoin(
      productOrderAdjustments,
      eq(productOrderRefunds.adjustmentId, productOrderAdjustments.id),
    ).where(eq(productOrderRefunds.caseId, caseId));
    assert.equal(result.refundOperationIds.length, 4);
    assert.deepEqual(
      rows.map((row) => [row.component, row.refund.amountCents]).sort(),
      [["merchandise", 10000], ["outbound_shipping", 300], ["outbound_shipping", 500], ["outbound_shipping", 700]].sort(),
    );
    assert.equal((await db.select({ status: productShippingCases.status }).from(productShippingCases).where(eq(productShippingCases.id, caseId)))[0].status, "remedy_pending");
    for (let index = 0; index < rows.length - 1; index += 1) {
      const row = rows[index];
      await processProductOrderRefund(
        row.refund.id,
        gateway("99710" + index, row.refund.originalTransactionId, row.refund.amountCents),
      );
    }
    assert.equal(await resolveSettledInventoryUnavailableRefundCases(), 0);
    assert.equal((await db.select({ status: productShippingCases.status }).from(productShippingCases).where(eq(productShippingCases.id, caseId)))[0].status, "remedy_pending");
    const final = rows[rows.length - 1];
    await processProductOrderRefund(
      final.refund.id,
      gateway("997199", final.refund.originalTransactionId, final.refund.amountCents),
    );
    assert.equal((await db.select({ status: checkoutOrders.status }).from(checkoutOrders).where(eq(checkoutOrders.id, orderId)))[0].status, "refunded");
    assert.equal(await resolveSettledInventoryUnavailableRefundCases(), 1);
    assert.equal((await db.select({ status: productShippingCases.status }).from(productShippingCases).where(eq(productShippingCases.id, caseId)))[0].status, "resolved");
  } finally {
    if (orderId) {
      await db.delete(productOrderRefunds).where(eq(productOrderRefunds.orderId, orderId));
      await db.delete(productOrderAdjustments).where(eq(productOrderAdjustments.orderId, orderId));
      if (caseId) await db.delete(productShippingCases).where(eq(productShippingCases.id, caseId));
      const obligations = await db.select({ id: orderPaymentObligations.id }).from(orderPaymentObligations).where(eq(orderPaymentObligations.orderId, orderId));
      for (const obligation of obligations) await db.delete(orderPaymentTransactions).where(eq(orderPaymentTransactions.obligationId, obligation.id));
      await db.delete(orderPaymentObligations).where(eq(orderPaymentObligations.orderId, orderId));
      await db.delete(checkoutOrders).where(eq(checkoutOrders.id, orderId));
    }
    if (ownerId) {
      await db.delete(shippingPolicyAssignments).where(
        eq(shippingPolicyAssignments.adminUserId, ownerId),
      );
      await db.delete(adminUsers).where(eq(adminUsers.id, ownerId));
    }
    await closePrivateDbPool();
  }
`;

test(
  "inventory-unavailable remedy reserves every primary/manual/address component and resolves after settlement",
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
      { cwd: process.cwd(), env: process.env, stdio: "inherit" },
    );
  },
);
