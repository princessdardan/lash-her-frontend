/**
 * READ-ONLY production purchasability verification.
 *
 * Answers the question: "Are the published products actually buyable, or is
 * something at the environment level blocking checkout?" It re-confirms
 * per-product metadata completeness against the live catalog and checks the
 * three environment-level gates that product completeness alone cannot prove:
 *
 *   1. Shipping package profiles  — at least one ENABLED profile exists, and
 *      every automated product can actually be packed into one (this is what
 *      the "Get shipping rates" step does; a shallow box set silently makes
 *      some items un-shippable even after provisioning).
 *   2. Product stock backfill     — product_stock rows exist / available > 0
 *      (Sanity stockQuantity is only a set-point; the live count is Postgres).
 *   3. Square gateway flag         — /api/checkout/square/config returns 200
 *      (SQUARE_COMMERCE_ENABLED=true + DATABASE_URL) rather than 404.
 *
 * It performs ONLY SELECTs and GETs. It never writes.
 *
 * USAGE
 * -----
 *   # DB checks + catalog checks against production:
 *   DATABASE_URL='postgres://...prod...' \
 *   SANITY_DATASET=production \
 *   SITE_URL=https://lashher.com \
 *     npx tsx scripts/verify-prod-purchasability.ts
 *
 *   # Catalog + HTTP checks only (no DATABASE_URL): DB section is skipped.
 *
 * NOTE: the CHITCHATS_* checkout flags have no public endpoint. Verify them
 * separately with the Vercel CLI (see the runbook in the chat that shipped
 * this script), e.g.:
 *   vercel env pull .env.prod --environment=production && \
 *     grep -E 'CHITCHATS_(SHIPPING|CHECKOUT|US_SHIPPING)_ENABLED|SQUARE_COMMERCE_ENABLED|MANUAL_PRODUCT_CHECKOUT_ENABLED' .env.prod
 */

import { createClient } from "@sanity/client";
import { Pool } from "pg";

import { getProductCheckoutEligibility } from "@/lib/commerce/product-checkout-eligibility";
import { createPrivateDbPoolConfig } from "@/lib/private-db/pool-config";
import {
  selectSmallestPackage,
  type PackableLine,
} from "@/lib/shipping/packing";
import type { ShippingPackageProfile } from "@/lib/shipping/types";
import type { TProductShippingMetadata } from "@/types";

const SANITY_PROJECT_ID =
  process.env.NEXT_PUBLIC_SANITY_PROJECT_ID ?? "3auncj84";
const SANITY_DATASET =
  process.env.SANITY_DATASET ??
  process.env.NEXT_PUBLIC_SANITY_DATASET ??
  "production";
const SANITY_API_VERSION =
  process.env.NEXT_PUBLIC_SANITY_API_VERSION ?? "2026-03-24";
const SITE_URL = (process.env.SITE_URL ?? "https://lashher.com").replace(
  /\/$/,
  "",
);
const MAX_CART_LINE_QTY = 10; // matches the per-line cart cap

const ok = (s: string) => `[32m✓[0m ${s}`;
const bad = (s: string) => `[31m✗[0m ${s}`;
const warn = (s: string) => `[33m![0m ${s}`;

interface SanityProduct {
  _id: string;
  title: string;
  slug: string | null;
  isAvailable: boolean;
  stockQuantity: number | null;
  shipping?: TProductShippingMetadata;
  variantOverrides?: Array<{
    _key: string;
    isAvailable?: boolean;
    stockQuantity?: number | null;
    select?: Array<{ name?: string; value?: string }>;
    shipping?: TProductShippingMetadata;
  }>;
}

const failures: string[] = [];
const warnings: string[] = [];

async function fetchPublishedProducts(): Promise<SanityProduct[]> {
  const client = createClient({
    projectId: SANITY_PROJECT_ID,
    dataset: SANITY_DATASET,
    apiVersion: SANITY_API_VERSION,
    useCdn: false,
    perspective: "published",
  });
  return client.fetch<SanityProduct[]>(
    `*[_type == "product" && isAvailable == true] | order(title asc){
      _id, title, "slug": slug.current, isAvailable, stockQuantity, shipping,
      variantOverrides[]{ _key, isAvailable, stockQuantity, select[]{ name, value }, shipping }
    }`,
  );
}

function lineFrom(
  meta: TProductShippingMetadata | undefined,
  qty: number,
): PackableLine | null {
  if (
    !meta ||
    typeof meta.weightGrams !== "number" ||
    typeof meta.lengthCm !== "number" ||
    typeof meta.widthCm !== "number" ||
    typeof meta.heightCm !== "number"
  ) {
    return null;
  }
  return {
    quantity: qty,
    weightGrams: meta.weightGrams,
    lengthCm: meta.lengthCm,
    widthCm: meta.widthCm,
    heightCm: meta.heightCm,
    isRigid: meta.isRigid ?? true,
  };
}

/** Largest quantity of a single line that still packs into some enabled box. */
function maxQtyThatFits(
  meta: TProductShippingMetadata,
  profiles: ShippingPackageProfile[],
): number {
  let fits = 0;
  for (let qty = 1; qty <= MAX_CART_LINE_QTY; qty++) {
    const line = lineFrom(meta, qty);
    if (!line) break;
    try {
      selectSmallestPackage([line], profiles);
      fits = qty;
    } catch {
      break;
    }
  }
  return fits;
}

// ── Check A: per-product metadata completeness (live re-confirm) ──────────────
function checkMetadata(products: SanityProduct[]): void {
  console.log("\n── A. Product metadata completeness (live catalog) ──");
  let allComplete = true;
  for (const p of products) {
    const ca = getProductCheckoutEligibility(p.shipping);
    if (ca.status === "invalid") {
      allComplete = false;
      failures.push(`${p.title}: shipping metadata invalid (${ca.reason})`);
      console.log(bad(`${p.title} — CA eligibility INVALID (${ca.reason})`));
      continue;
    }
    if (p.shipping?.usShippingApproved) {
      const us = getProductCheckoutEligibility(p.shipping, "US");
      if (us.status === "invalid") {
        allComplete = false;
        failures.push(
          `${p.title}: US-approved but US metadata invalid (${us.reason})`,
        );
        console.log(bad(`${p.title} — US-approved but INVALID (${us.reason})`));
        continue;
      }
    }
    const mode = ca.status === "manual" ? `manual (${ca.reason})` : "automated";
    const us = p.shipping?.usShippingApproved ? "CA+US" : "CA only";
    console.log(ok(`${p.title} — ${mode}, ${us}`));
  }
  if (allComplete)
    console.log(
      ok("All published products pass the checkout-eligibility gate."),
    );
}

// ── Check B: shipping profiles + packing feasibility ──────────────────────────
async function checkShipping(
  pool: Pool,
  products: SanityProduct[],
): Promise<void> {
  console.log("\n── B. Shipping package profiles & packing feasibility ──");
  const { rows } = await pool.query<{
    id: string;
    slug: string;
    name: string;
    rank: number;
    package_type: string;
    length_cm: number;
    width_cm: number;
    height_cm: number;
    tare_weight_grams: number;
    max_weight_grams: number;
    accepts_rigid: boolean;
    enabled: boolean;
  }>(
    `SELECT id, slug, name, rank, package_type, length_cm, width_cm, height_cm,
            tare_weight_grams, max_weight_grams, accepts_rigid, enabled
       FROM shipping_package_profiles ORDER BY enabled DESC, rank ASC`,
  );
  const enabled = rows.filter((r) => r.enabled);
  if (enabled.length === 0) {
    failures.push(
      "No ENABLED shipping_package_profiles — every automated checkout will 422.",
    );
    console.log(
      bad(
        "0 enabled shipping profiles. Run: npm run shipping:provision-package-profiles",
      ),
    );
    return;
  }
  console.log(ok(`${enabled.length} enabled profile(s):`));
  for (const r of enabled) {
    console.log(
      `    • ${r.slug} ${r.length_cm}×${r.width_cm}×${r.height_cm}cm, ` +
        `max ${r.max_weight_grams}g, rigid=${r.accepts_rigid}`,
    );
  }

  const profiles: ShippingPackageProfile[] = enabled.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    rank: r.rank,
    packageType: r.package_type,
    lengthCm: r.length_cm,
    widthCm: r.width_cm,
    heightCm: r.height_cm,
    tareWeightGrams: r.tare_weight_grams,
    maxWeightGrams: r.max_weight_grams,
    acceptsRigid: r.accepts_rigid,
    enabled: r.enabled,
  }));

  console.log("  Packing feasibility (automated products, qty 1):");
  for (const p of products) {
    const meta = p.shipping;
    const elig = getProductCheckoutEligibility(meta);
    if (elig.status !== "automated") continue; // manual/hazmat don't pack
    const line = lineFrom(meta, 1);
    if (!line) continue;
    try {
      selectSmallestPackage([line], profiles);
      const cap = maxQtyThatFits(meta!, profiles);
      if (cap < MAX_CART_LINE_QTY) {
        warnings.push(
          `${p.title}: only up to ${cap} unit(s) fit any enabled box.`,
        );
        console.log(
          warn(
            `${p.title} — packs, but max ${cap}/line fits (box height ceiling)`,
          ),
        );
      } else {
        console.log(ok(`${p.title} — packs (up to ${cap}/line)`));
      }
    } catch {
      failures.push(
        `${p.title}: CANNOT be packed by any enabled box (automated checkout will 422).`,
      );
      console.log(bad(`${p.title} — UN-PACKABLE by any enabled box`));
    }
  }
}

// ── Check C: product stock backfill / live availability ───────────────────────
async function checkStock(
  pool: Pool,
  products: SanityProduct[],
): Promise<void> {
  console.log("\n── C. Product stock (Postgres is authoritative) ──");
  const { rows } = await pool.query<{
    product_id: string;
    rows: number;
    on_hand: number;
    reserved: number;
    available: number;
  }>(
    `SELECT product_id, count(*)::int AS rows,
            sum(on_hand)::int AS on_hand, sum(reserved)::int AS reserved,
            sum(on_hand - reserved)::int AS available
       FROM product_stock GROUP BY product_id`,
  );
  const byId = new Map(rows.map((r) => [r.product_id, r]));
  const totalRows = rows.reduce((n, r) => n + r.rows, 0);
  console.log(
    `  ${totalRows} product_stock row(s) across ${rows.length} product(s).`,
  );
  if (totalRows === 0) {
    warnings.push(
      "product_stock is EMPTY — every product sells as UNTRACKED (unlimited). Run npm run stock:backfill if stock control is expected.",
    );
    console.log(
      warn(
        "No stock rows: all products untracked → unlimited. Backfill may not have run.",
      ),
    );
  }
  for (const p of products) {
    const authoredSetPoint =
      typeof p.stockQuantity === "number" ||
      (p.variantOverrides ?? []).some(
        (v) => typeof v.stockQuantity === "number",
      );
    const s = byId.get(p._id);
    if (!s) {
      if (authoredSetPoint) {
        warnings.push(
          `${p.title}: has a Sanity stock set-point but NO product_stock row (untracked → unlimited).`,
        );
        console.log(
          warn(`${p.title} — set-point in Sanity but untracked in Postgres`),
        );
      } else {
        console.log(ok(`${p.title} — untracked (sells unlimited, by design)`));
      }
      continue;
    }
    if (s.available <= 0) {
      warnings.push(
        `${p.title}: 0 units available across all variants (fully sold out).`,
      );
      console.log(
        bad(
          `${p.title} — 0 available (on_hand ${s.on_hand}, reserved ${s.reserved})`,
        ),
      );
    } else {
      console.log(
        ok(`${p.title} — ${s.available} available (${s.rows} row(s))`),
      );
    }
  }
}

// ── Check D: Square gateway flag (HTTP, no secrets) ───────────────────────────
async function checkSquareFlag(): Promise<void> {
  console.log("\n── D. Square gateway flag (SQUARE_COMMERCE_ENABLED) ──");
  const url = `${SITE_URL}/api/checkout/square/config`;
  try {
    const res = await fetch(url, { method: "GET" });
    if (res.status === 200) {
      const body = (await res.json()) as { environment?: string };
      console.log(
        ok(
          `${url} → 200 (Square commerce enabled, env=${body.environment ?? "?"})`,
        ),
      );
    } else if (res.status === 404) {
      failures.push(
        "SQUARE_COMMERCE_ENABLED is OFF (config endpoint 404) — nothing is buyable.",
      );
      console.log(bad(`${url} → 404 (Square commerce DISABLED)`));
    } else {
      warnings.push(
        `Square config endpoint returned ${res.status} — inspect manually.`,
      );
      console.log(warn(`${url} → ${res.status} (unexpected)`));
    }
  } catch (e) {
    warnings.push(`Could not reach ${url}: ${(e as Error).message}`);
    console.log(warn(`Could not reach ${url}: ${(e as Error).message}`));
  }
}

async function main(): Promise<void> {
  console.log(
    `Verifying purchasability — dataset=${SANITY_DATASET}, site=${SITE_URL}`,
  );
  const products = await fetchPublishedProducts();
  console.log(
    ok(
      `Fetched ${products.length} published, available product(s) from Sanity.`,
    ),
  );

  checkMetadata(products);
  await checkSquareFlag();

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.log(
      "\n" +
        warn(
          "DATABASE_URL not set — skipping shipping-profile and stock checks.",
        ),
    );
    warnings.push("DB checks skipped (no DATABASE_URL).");
  } else {
    const pool = new Pool(createPrivateDbPoolConfig(dbUrl));
    try {
      await checkShipping(pool, products);
      await checkStock(pool, products);
    } finally {
      await pool.end();
    }
  }

  console.log("\n──────────── SUMMARY ────────────");
  if (failures.length === 0) console.log(ok("No blocking failures."));
  for (const f of failures) console.log(bad(f));
  for (const w of warnings) console.log(warn(w));
  console.log(
    failures.length === 0
      ? "\nResult: catalog + checked gates are GO (review any warnings above)."
      : "\nResult: NOT fully buyable — resolve the ✗ items above.",
  );
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(bad(`Verification crashed: ${(e as Error).stack ?? e}`));
  process.exitCode = 1;
});
