import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { getPrivateDb } from "@/lib/private-db/client";
import { checkoutOrders } from "@/lib/private-db/schema";
import type { HelcimPayloadValue } from "@/lib/commerce/helcim-types";

const MISMATCH_VALUES = new Set([
  "n",
  "no",
  "no_match",
  "mismatch",
  "not_matched",
  "failed",
  "declined",
]);

export async function classifyProductOrderPaymentRisk(
  orderReference: string,
  data: Record<string, HelcimPayloadValue>,
): Promise<string[]> {
  const flags: string[] = [];
  if (isMismatch(data.avsResponse ?? data.avsResult ?? data.avs))
    flags.push("avs_mismatch");
  if (isMismatch(data.cvvResponse ?? data.cvvResult ?? data.cvv))
    flags.push("cvv_mismatch");
  if (!flags.length) return flags;
  await getPrivateDb()
    .update(checkoutOrders)
    .set({
      fraudClassification: "high",
      fraudClearedAt: null,
      fraudRiskReasons: sql`${checkoutOrders.fraudRiskReasons} || ${JSON.stringify(flags)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(checkoutOrders.orderId, orderReference),
        eq(checkoutOrders.purpose, "product"),
      ),
    );
  return flags;
}

function isMismatch(value: HelcimPayloadValue | undefined): boolean {
  if (value === null || value === undefined) return false;
  return MISMATCH_VALUES.has(
    String(value).trim().toLowerCase().replace(/\s+/g, "_"),
  );
}
