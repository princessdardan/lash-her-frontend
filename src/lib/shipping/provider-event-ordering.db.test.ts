import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run provider event ordering tests";

const scenario = String.raw`
  import assert from "node:assert/strict";
  import { eq } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import { checkoutOrders, productShipmentJobs, productShipments } from "./src/lib/private-db/schema.ts";
  import { processClaimedShipmentOperation } from "./src/lib/shipping/operation-worker.ts";
  import { claimShipmentOperationJobs, enqueueShipmentOperation, listShipmentsDueForPolling } from "./src/lib/shipping/shipment-store.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL.includes("?")
    ? process.env.TEST_DATABASE_URL + "&sslmode=disable"
    : process.env.TEST_DATABASE_URL + "?sslmode=disable";

  const db = getPrivateDb();
  const prefix = "lh-provider-event-ordering-" + crypto.randomUUID();
  let orderId;
  let shipmentId;
  const observedAt = new Date("2026-08-15T13:00:00.000Z");

  function clientWith(shipment) {
    return {
      async getShipment() { return shipment; },
      async createShipment() { throw new Error("unexpected create"); },
      async findShipments() { return []; },
      async refreshShipment() { throw new Error("unexpected refresh"); },
      async buyShipment() { throw new Error("unexpected buy"); },
      async deleteShipment() { throw new Error("unexpected delete"); },
      async refundShipment() { throw new Error("unexpected refund"); },
      async listReturns() { return []; },
    };
  }

  try {
    const [order] = await db.insert(checkoutOrders).values({
      orderId: prefix + "-order",
      purpose: "product",
      status: "paid",
      customerName: "Test Customer",
      customerEmail: "customer@example.invalid",
      amountCents: 1_200,
      merchandiseAmountCents: 1_000,
      shippingAmountCents: 200,
      lineItems: [],
      paymentRiskStatus: "cleared",
    }).returning();
    orderId = order.id;
    const [shipment] = await db.insert(productShipments).values({
      orderId: order.id,
      publicReference: prefix + "-shipment",
      quoteTokenHash: prefix + "-token",
      quoteFingerprint: prefix + "-fingerprint",
      providerShipmentId: prefix + "-provider",
      providerStatus: "in_transit",
      providerEventAt: new Date("2026-08-15T10:00:00.000Z"),
      status: "in_transit",
      destination: {
        name: "Test Customer", email: "customer@example.invalid", phone: "+14165550100",
        line1: "100 Test Street", city: "Toronto", province: "ON", postalCode: "M5V 1A1",
        country: "Canada", countryCode: "CA",
      },
      packageSnapshot: {
        profileId: "profile", profileSlug: "profile", packageType: "parcel",
        lengthCm: 10, widthCm: 10, heightCm: 10, tareWeightGrams: 10, totalWeightGrams: 100,
      },
      customsLines: [],
      rates: [],
      quotedShippingCents: 200,
      acceptedEmailSentAt: observedAt,
      deliveredEmailSentAt: observedAt,
      quoteExpiresAt: new Date("2026-08-16T00:00:00.000Z"),
    }).returning();
    shipmentId = shipment.id;
    const first = await enqueueShipmentOperation({
      shipmentId: shipment.id,
      type: "tracking",
      idempotencyKey: prefix + "-delivered",
      availableAt: observedAt,
      payload: { expectedShipmentStateVersion: shipment.stateVersion },
    });
      const [claimedFirst] = (await claimShipmentOperationJobs({
        workerId: "event-worker-1", types: ["tracking"], now: observedAt,
    })).filter((job) => job.id === first.id);
    assert.ok(claimedFirst);
    assert.equal(await processClaimedShipmentOperation(claimedFirst, {
      client: clientWith({
        id: shipment.providerShipmentId,
        status: "delivered",
        purchase_amount: "2.00",
        tracking_events: [{ status: "delivered", created_at: "2026-08-15T12:00:00.000Z" }],
      }),
      workerId: "event-worker-1",
      now: () => observedAt,
    }), "succeeded");
    const delivered = await db.query.productShipments.findFirst({ where: eq(productShipments.id, shipment.id) });
    assert.equal(delivered.status, "delivered");
    assert.equal(delivered.providerEventAt.toISOString(), "2026-08-15T12:00:00.000Z");

    const second = await enqueueShipmentOperation({
      shipmentId: shipment.id,
      type: "tracking",
      idempotencyKey: prefix + "-late-in-transit",
      availableAt: observedAt,
      payload: { expectedShipmentStateVersion: delivered.stateVersion },
    });
      const [claimedSecond] = (await claimShipmentOperationJobs({
        workerId: "event-worker-2", types: ["tracking"], now: new Date(observedAt.getTime() + 1_000),
    })).filter((job) => job.id === second.id);
    assert.ok(claimedSecond);
    assert.equal(await processClaimedShipmentOperation(claimedSecond, {
      client: clientWith({
        id: shipment.providerShipmentId,
        status: "in_transit",
        purchase_amount: "2.00",
        tracking_events: [{ status: "in_transit", created_at: "2026-08-15T11:00:00.000Z" }],
      }),
      workerId: "event-worker-2",
      now: () => observedAt,
    }), "succeeded");
    const afterLatePoll = await db.query.productShipments.findFirst({ where: eq(productShipments.id, shipment.id) });
    assert.equal(afterLatePoll.status, "delivered");
    assert.equal(afterLatePoll.providerEventAt.toISOString(), "2026-08-15T12:00:00.000Z");

    const pollNow = new Date();
    const [overdue] = await db.insert(productShipments).values({
      orderId: order.id,
      sequence: 1,
      publicReference: prefix + "-overdue",
      quoteTokenHash: prefix + "-overdue-token",
      quoteFingerprint: prefix + "-overdue-fingerprint",
      providerShipmentId: prefix + "-overdue-provider",
      status: "label_ready",
      lastPolledAt: new Date(pollNow.getTime() - 60 * 60_000),
      updatedAt: pollNow,
      destination: shipment.destination,
      packageSnapshot: shipment.packageSnapshot,
      customsLines: [], rates: [],
      quoteExpiresAt: new Date(pollNow.getTime() + 60 * 60_000),
    }).returning();
    const due = await listShipmentsDueForPolling(pollNow);
    assert.ok(
      due.some((candidate) => candidate.id === overdue.id),
      "a recent local updated_at write must not postpone overdue provider polling",
    );
  } finally {
    if (orderId) {
      const shipments = await db.select({ id: productShipments.id }).from(productShipments).where(
        eq(productShipments.orderId, orderId),
      );
      for (const shipment of shipments) {
        await db.delete(productShipmentJobs).where(eq(productShipmentJobs.shipmentId, shipment.id));
        await db.delete(productShipments).where(eq(productShipments.id, shipment.id));
      }
    }
    if (orderId) await db.delete(checkoutOrders).where(eq(checkoutOrders.id, orderId));
    await closePrivateDbPool();
  }
`;

test(
  "late provider polling cannot regress a delivered shipment",
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
