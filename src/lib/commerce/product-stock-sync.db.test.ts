import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run product stock sync tests";

// Coverage for the Sanity set-point sync against a real Postgres: initial seed,
// no-op on an unchanged republish, absolute reset on a changed set-point, the
// reserved-aware clamp, and untracking when the value is cleared.
const scenario = String.raw`
  import assert from "node:assert/strict";
  import crypto from "node:crypto";
  import { and, eq, isNull } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import { productStock } from "./src/lib/private-db/schema.ts";
  import { syncProductStockFromProduct } from "./src/lib/commerce/product-stock-sync.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL.includes("?")
    ? process.env.TEST_DATABASE_URL + "&sslmode=disable"
    : process.env.TEST_DATABASE_URL + "?sslmode=disable";

  const db = getPrivateDb();
  const productId = "stock-sync-" + crypto.randomUUID();

  function makeProduct(stockQuantity) {
    return {
      _id: productId,
      title: "Sync Test Product",
      description: "desc",
      slug: "sync-test",
      price: 100,
      currency: "CAD",
      isAvailable: true,
      stockQuantity,
    };
  }

  async function readRow() {
    const [row] = await db
      .select({
        onHand: productStock.onHand,
        reserved: productStock.reserved,
        sanitySeedQuantity: productStock.sanitySeedQuantity,
      })
      .from(productStock)
      .where(and(eq(productStock.productId, productId), isNull(productStock.variantKey)))
      .limit(1);
    return row;
  }

  try {
    // Initial seed from the authored set-point.
    await syncProductStockFromProduct(makeProduct(5));
    let row = await readRow();
    assert.equal(row.onHand, 5, "initial seed sets onHand");
    assert.equal(row.sanitySeedQuantity, 5);

    // Simulate three sales' worth of decrement, then an unchanged republish:
    // the live count must be left alone.
    await db
      .update(productStock)
      .set({ onHand: 2 })
      .where(and(eq(productStock.productId, productId), isNull(productStock.variantKey)));
    await syncProductStockFromProduct(makeProduct(5));
    row = await readRow();
    assert.equal(row.onHand, 2, "unchanged set-point does not disturb the live count");

    // A changed set-point is an absolute restock reset.
    await syncProductStockFromProduct(makeProduct(8));
    row = await readRow();
    assert.equal(row.onHand, 8, "changed set-point resets onHand");
    assert.equal(row.sanitySeedQuantity, 8);

    // Lowering below the reserved units clamps onHand to reserved (never below).
    await db
      .update(productStock)
      .set({ reserved: 3 })
      .where(and(eq(productStock.productId, productId), isNull(productStock.variantKey)));
    await syncProductStockFromProduct(makeProduct(1));
    row = await readRow();
    assert.equal(row.onHand, 3, "reset clamps onHand up to reserved");
    assert.equal(row.sanitySeedQuantity, 1, "records the authored set-point even when clamped");

    // Clearing the set-point untracks the item once nothing is reserved.
    await db
      .update(productStock)
      .set({ reserved: 0 })
      .where(and(eq(productStock.productId, productId), isNull(productStock.variantKey)));
    await syncProductStockFromProduct(makeProduct(undefined));
    row = await readRow();
    assert.equal(row, undefined, "clearing the set-point deletes the untracked row");
  } finally {
    await db.delete(productStock).where(eq(productStock.productId, productId));
    await closePrivateDbPool();
  }
`;

test(
  "product stock sync applies Sanity set-points without clobbering live counts",
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
