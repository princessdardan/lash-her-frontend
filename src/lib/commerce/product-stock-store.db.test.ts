import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run product stock store tests";

// End-to-end coverage for the reserve/commit/release inventory primitives
// against a real Postgres: the atomic oversell guard, exactly-once commit and
// release, and untracked-line passthrough.
const scenario = String.raw`
  import assert from "node:assert/strict";
  import crypto from "node:crypto";
  import { and, eq, isNull } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import { productStock, productStockMovements } from "./src/lib/private-db/schema.ts";
  import {
    reserveProductStockInTransaction,
    commitProductStockForOrderInTransaction,
    releaseProductStockForOrderInTransaction,
    InsufficientStockError,
    getProductStockLevels,
    stockLevelKey,
  } from "./src/lib/commerce/product-stock-store.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL.includes("?")
    ? process.env.TEST_DATABASE_URL + "&sslmode=disable"
    : process.env.TEST_DATABASE_URL + "?sslmode=disable";

  const db = getPrivateDb();
  const productId = "stock-test-" + crypto.randomUUID();

  async function readRow() {
    const [row] = await db
      .select({ onHand: productStock.onHand, reserved: productStock.reserved })
      .from(productStock)
      .where(and(eq(productStock.productId, productId), isNull(productStock.variantKey)))
      .limit(1);
    return row;
  }

  try {
    // Seed a tracked product-level row with 5 on hand, none reserved.
    await db.insert(productStock).values({
      productId,
      variantKey: null,
      onHand: 5,
      reserved: 0,
      sanitySeedQuantity: 5,
    });

    const orderA = "stock-order-" + crypto.randomUUID();
    const lines = [{ productId, quantity: 2 }];

    // Reserve holds units: reserved rises, onHand unchanged.
    await db.transaction((tx) => reserveProductStockInTransaction(tx, orderA, lines));
    let row = await readRow();
    assert.equal(row.onHand, 5, "onHand unchanged by reserve");
    assert.equal(row.reserved, 2, "reserve increments reserved");

    // Available (onHand - reserved) is surfaced by the read helper.
    const levels = await getProductStockLevels([productId]);
    assert.equal(levels.get(stockLevelKey(productId, null)).available, 3);

    // Oversell: a second reservation beyond available throws and rolls back.
    const orderB = "stock-order-" + crypto.randomUUID();
    await assert.rejects(
      db.transaction((tx) =>
        reserveProductStockInTransaction(tx, orderB, [{ productId, quantity: 4 }]),
      ),
      (error) => error instanceof InsufficientStockError,
      "reserving beyond available must throw InsufficientStockError",
    );
    row = await readRow();
    assert.equal(row.reserved, 2, "failed reservation left reserved untouched");

    // Commit converts the hold into sold units exactly once.
    await db.transaction((tx) => commitProductStockForOrderInTransaction(tx, orderA));
    row = await readRow();
    assert.equal(row.onHand, 3, "commit decrements onHand");
    assert.equal(row.reserved, 0, "commit decrements reserved");

    // Commit again is a no-op (idempotent under webhook replay).
    await db.transaction((tx) => commitProductStockForOrderInTransaction(tx, orderA));
    row = await readRow();
    assert.equal(row.onHand, 3, "second commit does not double-decrement");
    assert.equal(row.reserved, 0);

    // Release returns a fresh order's hold to available, exactly once.
    const orderC = "stock-order-" + crypto.randomUUID();
    await db.transaction((tx) => reserveProductStockInTransaction(tx, orderC, [{ productId, quantity: 1 }]));
    row = await readRow();
    assert.equal(row.reserved, 1, "second order reserves a unit");

    await db.transaction((tx) => releaseProductStockForOrderInTransaction(tx, orderC));
    row = await readRow();
    assert.equal(row.onHand, 3, "release leaves onHand untouched");
    assert.equal(row.reserved, 0, "release returns the hold");

    await db.transaction((tx) => releaseProductStockForOrderInTransaction(tx, orderC));
    row = await readRow();
    assert.equal(row.reserved, 0, "second release does not go negative");

    // A committed order cannot then be released (settled rows are skipped).
    await db.transaction((tx) => releaseProductStockForOrderInTransaction(tx, orderA));
    row = await readRow();
    assert.equal(row.onHand, 3, "release after commit is a no-op");

    // Untracked line (no row) never throws and records no movement.
    const untrackedProductId = "stock-untracked-" + crypto.randomUUID();
    const orderD = "stock-order-" + crypto.randomUUID();
    await db.transaction((tx) =>
      reserveProductStockInTransaction(tx, orderD, [{ productId: untrackedProductId, quantity: 9 }]),
    );
    const untrackedRows = await db
      .select({ id: productStockMovements.id })
      .from(productStockMovements)
      .where(eq(productStockMovements.orderId, orderD));
    assert.equal(untrackedRows.length, 0, "untracked line records no movement");
  } finally {
    await db.delete(productStock).where(eq(productStock.productId, productId));
    await closePrivateDbPool();
  }
`;

test(
  "product stock store reserves, commits, and releases with exactly-once semantics",
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
