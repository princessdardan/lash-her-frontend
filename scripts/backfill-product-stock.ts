import "dotenv/config";

import { loaders } from "../src/data/loaders";
import { closePrivateDbPool } from "../src/lib/private-db/client";
import { reconcileProductStock } from "../src/lib/commerce/product-stock-sync";

/**
 * One-time (or occasional) reconcile of Postgres product inventory from the
 * Sanity stock set-points. The per-product `inventory-sync` webhook keeps stock
 * current on publish; this backfills products that were authored before the
 * webhook existed, or replays any that were missed. Idempotent — the sync only
 * resets on-hand when a set-point actually changed.
 *
 * Dry run by default; pass --execute to write. Run with the react-server
 * condition so the server-only Sanity read path resolves:
 *   tsx --conditions=react-server scripts/backfill-product-stock.ts --execute
 */
async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const products = await loaders.getAllProductsForStockSync();

  const authored = products.filter((product) => {
    const hasProductLevel = typeof product.stockQuantity === "number";
    const hasVariantLevel = (product.variants ?? []).some(
      (variant) => typeof variant.stockQuantity === "number",
    );
    return hasProductLevel || hasVariantLevel;
  });

  console.log(`[stock-backfill] ${products.length} products found`);
  console.log(
    `[stock-backfill] ${authored.length} have a stock set-point authored in Sanity`,
  );

  if (!execute) {
    console.log(
      "[stock-backfill] Dry run only. Re-run with --execute to sync into Postgres.",
    );
    return;
  }

  const results = await reconcileProductStock(products);
  const totals = results.reduce(
    (acc, result) => ({
      tracked: acc.tracked + result.tracked,
      reset: acc.reset + result.reset,
      untracked: acc.untracked + result.untracked,
      unchanged: acc.unchanged + result.unchanged,
    }),
    { tracked: 0, reset: 0, untracked: 0, unchanged: 0 },
  );

  console.log(
    `[stock-backfill] Synced ${results.length} products — ` +
      `${totals.tracked} newly tracked, ${totals.reset} reset, ` +
      `${totals.untracked} untracked, ${totals.unchanged} unchanged`,
  );
}

main()
  .catch((error: unknown) => {
    console.error("[stock-backfill] Failed", error);
    process.exitCode = 1;
  })
  .finally(() => closePrivateDbPool());
