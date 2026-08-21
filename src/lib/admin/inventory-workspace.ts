import "server-only";

import { loaders } from "@/data/loaders";
import { LOW_STOCK_THRESHOLD } from "@/lib/commerce/product-stock-availability";
import { getPrivateDb } from "@/lib/private-db/client";
import { productStock } from "@/lib/private-db/schema";

import { requirePermission } from "./auth";
import {
  getAdminWorkspacePagination,
  normalizeAdminWorkspaceSearch,
} from "./operations-workspaces-presentation";

export type AdminStockStatus = "in_stock" | "low_stock" | "sold_out";

export interface AdminProductStockRow {
  productId: string;
  variantKey: string | null;
  productTitle: string;
  variantLabel: string | null;
  productSlug: string | null;
  onHand: number;
  reserved: number;
  available: number;
  /** Last restock set-point authored in Sanity; null when never seeded that way. */
  restockSetPoint: number | null;
  status: AdminStockStatus;
  updatedAt: Date;
}

export interface AdminProductStockPage {
  rows: AdminProductStockRow[];
  page: number;
  pageCount: number;
  pageSize: number;
  total: number;
  search: string;
  lowStockThreshold: number;
}

function publishedId(id: string): string {
  return id.replace(/^drafts\./, "");
}

function statusFor(available: number): AdminStockStatus {
  if (available <= 0) return "sold_out";
  if (available <= LOW_STOCK_THRESHOLD) return "low_stock";
  return "in_stock";
}

/**
 * Read-only live inventory for the admin screen. Postgres is the source of truth
 * for counts; product/variant titles are joined from Sanity. The tracked-row set
 * is small (one per opted-in product/variant), so the join, search, sort, and
 * pagination are done in memory rather than across two stores in SQL.
 */
export async function listAdminProductStock(
  input: { page?: number; search?: string } = {},
): Promise<AdminProductStockPage> {
  await requirePermission("inventory:view");

  const search = normalizeAdminWorkspaceSearch(input.search);
  const needle = search.toLowerCase();

  const stockRows = await getPrivateDb()
    .select({
      productId: productStock.productId,
      variantKey: productStock.variantKey,
      onHand: productStock.onHand,
      reserved: productStock.reserved,
      sanitySeedQuantity: productStock.sanitySeedQuantity,
      updatedAt: productStock.updatedAt,
    })
    .from(productStock);

  const productIds = [...new Set(stockRows.map((row) => row.productId))];
  const products =
    productIds.length > 0 ? await loaders.getProductsByIds(productIds) : [];
  const productById = new Map(
    products.map((product) => [publishedId(product._id), product]),
  );

  const enriched: AdminProductStockRow[] = stockRows.map((row) => {
    const product = productById.get(row.productId);
    const variantLabel = row.variantKey
      ? (product?.variants?.find((variant) => variant._key === row.variantKey)
          ?.title ?? row.variantKey)
      : null;
    const available = Math.max(0, row.onHand - row.reserved);

    return {
      productId: row.productId,
      variantKey: row.variantKey,
      productTitle: product?.title ?? row.productId,
      variantLabel,
      productSlug: product?.slug ?? null,
      onHand: row.onHand,
      reserved: row.reserved,
      available,
      restockSetPoint: row.sanitySeedQuantity,
      status: statusFor(available),
      updatedAt: row.updatedAt,
    };
  });

  const filtered = needle
    ? enriched.filter(
        (row) =>
          row.productTitle.toLowerCase().includes(needle) ||
          (row.variantLabel?.toLowerCase().includes(needle) ?? false),
      )
    : enriched;

  // Most urgent first: lowest available, then alphabetical for a stable order.
  filtered.sort(
    (left, right) =>
      left.available - right.available ||
      left.productTitle.localeCompare(right.productTitle) ||
      (left.variantLabel ?? "").localeCompare(right.variantLabel ?? ""),
  );

  const total = filtered.length;
  const pagination = getAdminWorkspacePagination(input.page, total);
  const rows = filtered.slice(
    pagination.offset,
    pagination.offset + pagination.pageSize,
  );

  return {
    rows,
    page: pagination.page,
    pageCount: pagination.pageCount,
    pageSize: pagination.pageSize,
    total,
    search,
    lowStockThreshold: LOW_STOCK_THRESHOLD,
  };
}
