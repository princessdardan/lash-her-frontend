/**
 * Pure stock-status classification, safe to import from both server and client
 * code (no `server-only`, no DB access). The server availability join and the
 * client purchase controls both key off this.
 */

/** At or below this many units available, the storefront shows a low-stock hint. */
export const LOW_STOCK_THRESHOLD = 5;

export type StockStatus = "in_stock" | "low_stock" | "sold_out" | "untracked";

/**
 * Classify an available count for display. `null`/`undefined` available means
 * the item is untracked (unlimited), which reads as ordinary availability.
 */
export function stockStatusFor(
  available: number | null | undefined,
  threshold: number = LOW_STOCK_THRESHOLD,
): StockStatus {
  if (available === null || available === undefined) return "untracked";
  if (available <= 0) return "sold_out";
  if (available <= threshold) return "low_stock";
  return "in_stock";
}
