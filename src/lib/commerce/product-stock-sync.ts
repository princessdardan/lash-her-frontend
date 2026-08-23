import "server-only";

import { eq } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import { productStock } from "@/lib/private-db/schema";
import type { TProduct } from "@/types";

import { normalizeProductVariantModel } from "./product-variant-model";

type DbTransaction = Parameters<
  Parameters<ReturnType<typeof getPrivateDb>["transaction"]>[0]
>[0];

/**
 * Applies the Sanity-authored stock set-point to the authoritative Postgres
 * inventory. The Sanity number is an INPUT (what staff set on restock), never a
 * live readout: it resets `onHand` only when the authored value actually
 * changes (tracked via `sanitySeedQuantity`), so an ordinary republish never
 * disturbs a count that has been decrementing through sales. A blank value
 * untracks the item (unlimited) by deleting its row when nothing is reserved.
 */
export interface ProductStockSyncResult {
  productId: string;
  /** Rows newly created (first time this target became tracked). */
  tracked: number;
  /** Rows whose on-hand was reset because the Sanity set-point changed. */
  reset: number;
  /** Rows deleted because the item is no longer tracked in Sanity. */
  untracked: number;
  /** Rows left untouched (set-point unchanged, or held reservation blocks untrack). */
  unchanged: number;
}

interface DesiredTarget {
  variantKey: string | null;
  quantity: number;
}

function publishedProductId(id: string): string {
  return id.replace(/^drafts\./, "");
}

// Blank/invalid -> untracked (null); an authored 0 is a real set-point.
function toStockQuantity(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.floor(value);
}

/**
 * The tracked targets a product declares: one per derived variant that carries a
 * stock set-point, or a single product-level target for a product with no
 * options. Products with options ignore the product-level field — stock is
 * authored per combination on the variant override.
 */
function desiredTargets(product: TProduct): DesiredTarget[] {
  const normalized = normalizeProductVariantModel(product);
  const targets: DesiredTarget[] = [];

  if (normalized.variants && normalized.variants.length > 0) {
    for (const variant of normalized.variants) {
      const quantity = toStockQuantity(variant.stockQuantity);
      if (quantity !== null && variant._key) {
        targets.push({ variantKey: variant._key, quantity });
      }
    }
    return targets;
  }

  const quantity = toStockQuantity(product.stockQuantity);
  if (quantity !== null) targets.push({ variantKey: null, quantity });
  return targets;
}

export async function syncProductStockFromProduct(
  product: TProduct,
): Promise<ProductStockSyncResult> {
  const productId = publishedProductId(product._id);
  const targets = desiredTargets(product);
  return getPrivateDb().transaction((tx) =>
    applyTargets(tx, productId, targets),
  );
}

async function applyTargets(
  tx: DbTransaction,
  productId: string,
  targets: DesiredTarget[],
): Promise<ProductStockSyncResult> {
  const now = new Date();
  const existing = await tx
    .select({
      id: productStock.id,
      variantKey: productStock.variantKey,
      onHand: productStock.onHand,
      reserved: productStock.reserved,
      sanitySeedQuantity: productStock.sanitySeedQuantity,
    })
    .from(productStock)
    .where(eq(productStock.productId, productId))
    .for("update");

  const existingByKey = new Map(
    existing.map((row) => [row.variantKey ?? "", row]),
  );
  const desiredByKey = new Map(
    targets.map((target) => [target.variantKey ?? "", target]),
  );

  const result: ProductStockSyncResult = {
    productId,
    tracked: 0,
    reset: 0,
    untracked: 0,
    unchanged: 0,
  };

  // Untrack rows Sanity no longer declares. A row with an outstanding
  // reservation is left in place (a later sync removes it once released) so we
  // never orphan an in-flight order's hold.
  for (const row of existing) {
    if (desiredByKey.has(row.variantKey ?? "")) continue;
    if (row.reserved === 0) {
      await tx.delete(productStock).where(eq(productStock.id, row.id));
      result.untracked += 1;
    } else {
      result.unchanged += 1;
    }
  }

  for (const target of targets) {
    const row = existingByKey.get(target.variantKey ?? "");

    if (!row) {
      // onConflictDoNothing: two concurrent inventory-sync webhooks for a
      // brand-new product both see no row and both attempt this seed insert;
      // the loser would otherwise hit a partial-unique violation → 500 → retry.
      // Only count a row we actually inserted.
      const inserted = await tx
        .insert(productStock)
        .values({
          productId,
          variantKey: target.variantKey,
          onHand: target.quantity,
          reserved: 0,
          sanitySeedQuantity: target.quantity,
        })
        .onConflictDoNothing()
        .returning({ id: productStock.id });
      if (inserted.length > 0) {
        result.tracked += 1;
      }
      continue;
    }

    // Set-point unchanged -> leave the live count alone.
    if (row.sanitySeedQuantity === target.quantity) {
      result.unchanged += 1;
      continue;
    }

    // A deliberate restock: absolute reset of on-hand, but never below the units
    // already reserved by in-flight orders (that would strand those holds and
    // violate the reserved<=onHand invariant). Record the authored set-point so
    // an unchanged republish is a no-op even when the count was clamped up.
    await tx
      .update(productStock)
      .set({
        onHand: Math.max(target.quantity, row.reserved),
        sanitySeedQuantity: target.quantity,
        updatedAt: now,
      })
      .where(eq(productStock.id, row.id));
    result.reset += 1;
  }

  return result;
}

/**
 * Fetch a product by its published id and reconcile its stock: sync from the
 * authored set-points when it exists, or untrack it when it's gone
 * (deleted/unpublished). This is the shared entry point for both the dedicated
 * inventory-sync webhook and the fold-in on the revalidate webhook. `loaders` is
 * imported dynamically so this module stays importable by DB tests without
 * pulling in the Sanity read-env at module load.
 */
export async function syncProductStockForPublishedId(
  id: string,
): Promise<void> {
  const { loaders } = await import("@/data/loaders");
  const product = await loaders.getProductForStockSync(id);
  if (product) {
    await syncProductStockFromProduct(product);
  } else {
    await untrackProductStock(id);
  }
}

/**
 * Untrack every stock row for a product (deleted/unpublished in Sanity). Rows
 * with an outstanding reservation are kept until released.
 */
export async function untrackProductStock(
  productId: string,
): Promise<{ productId: string; untracked: number; unchanged: number }> {
  const resolvedId = publishedProductId(productId);
  return getPrivateDb().transaction(async (tx) => {
    const rows = await tx
      .select({ id: productStock.id, reserved: productStock.reserved })
      .from(productStock)
      .where(eq(productStock.productId, resolvedId))
      .for("update");

    let untracked = 0;
    let unchanged = 0;
    for (const row of rows) {
      if (row.reserved === 0) {
        await tx.delete(productStock).where(eq(productStock.id, row.id));
        untracked += 1;
      } else {
        unchanged += 1;
      }
    }
    return { productId: resolvedId, untracked, unchanged };
  });
}

/**
 * Backfill: sync stock for a batch of products. Used once after deploy and
 * available for a periodic reconcile. Each product is synced independently so
 * one failure does not abort the rest.
 */
export async function reconcileProductStock(
  products: readonly TProduct[],
): Promise<ProductStockSyncResult[]> {
  const results: ProductStockSyncResult[] = [];
  for (const product of products) {
    results.push(await syncProductStockFromProduct(product));
  }
  return results;
}
