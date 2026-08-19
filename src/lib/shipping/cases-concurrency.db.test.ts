import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run shipping-case concurrency tests";

const scenario = String.raw`
  import assert from "node:assert/strict";
  import { eq } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import {
    adminUsers,
    checkoutOrders,
    productShippingCases,
  } from "./src/lib/private-db/schema.ts";
  import { updateProductShippingCase } from "./src/lib/shipping/cases.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  const db = getPrivateDb();
  const fixture = crypto.randomUUID();
  const ownerEmail = "case-concurrency-" + fixture + "@example.invalid";
  process.env.ADMIN_OWNER_EMAILS = ownerEmail;
  let ownerId;
  let orderId;
  let caseId;

  try {
    const [owner] = await db.insert(adminUsers).values({
      providerUserId: "case-concurrency-owner-" + fixture,
      email: ownerEmail,
      emailNormalized: ownerEmail,
      role: "owner",
      status: "active",
    }).returning({ id: adminUsers.id });
    ownerId = owner.id;
    const [order] = await db.insert(checkoutOrders).values({
      orderId: "lh-case-concurrency-" + fixture,
      purpose: "product",
      status: "paid",
      customerName: "Case Concurrency Test",
      customerEmail: ownerEmail,
      amountCents: 1000,
      merchandiseAmountCents: 1000,
      shippingAmountCents: 0,
      currency: "CAD",
      lineItems: [],
      paymentProvider: "helcim",
      paymentRiskStatus: "cleared",
      fulfillmentMode: "automated_shipping",
      paidAt: new Date(),
    }).returning({ id: checkoutOrders.id });
    orderId = order.id;
    const [shippingCase] = await db.insert(productShippingCases).values({
      orderId,
      type: "delay",
      status: "open",
    }).returning({ id: productShippingCases.id });
    caseId = shippingCase.id;

    const concurrent = await Promise.allSettled([
      updateProductShippingCase({
        caseId,
        actorAdminUserId: ownerId,
        expectedStateVersion: 1,
        action: "acknowledge",
      }),
      updateProductShippingCase({
        caseId,
        actorAdminUserId: ownerId,
        expectedStateVersion: 1,
        action: "inspect",
      }),
    ]);
    assert.equal(
      concurrent.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      concurrent.filter((result) => result.status === "rejected").length,
      1,
    );
    await assert.rejects(
      updateProductShippingCase({
        caseId,
        actorAdminUserId: ownerId,
        expectedStateVersion: 1,
        action: "claim",
      }),
      /changed; refresh/,
    );
    const afterStale = (await db.select().from(productShippingCases).where(eq(productShippingCases.id, caseId)))[0];
    assert.ok(["open", "remedy_pending"].includes(afterStale.status));
    assert.equal(afterStale.stateVersion, 2);

    const resolved = await updateProductShippingCase({
      caseId,
      actorAdminUserId: ownerId,
      expectedStateVersion: 2,
      action: "resolve",
    });
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.stateVersion, 3);
    await assert.rejects(
      updateProductShippingCase({
        caseId,
        actorAdminUserId: ownerId,
        expectedStateVersion: 3,
        action: "inspect",
      }),
      /cannot transition from resolved/,
    );
  } finally {
    if (caseId) await db.delete(productShippingCases).where(eq(productShippingCases.id, caseId));
    if (orderId) await db.delete(checkoutOrders).where(eq(checkoutOrders.id, orderId));
    if (ownerId) {
      await db.delete(adminUsers).where(eq(adminUsers.id, ownerId));
    }
    await closePrivateDbPool();
  }
`;

test(
  "shipping-case updates reject stale versions and terminal-state reopening",
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
