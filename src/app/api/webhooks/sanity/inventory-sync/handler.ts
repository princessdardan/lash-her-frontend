import type { NextRequest } from "next/server";

import { log } from "@/lib/logging/logger";
import type { TProduct } from "@/types";

interface InventorySyncWebhookDependencies {
  getWebhookSecret: () => string;
  parseBody: <T>(
    req: NextRequest,
    secret: string,
    waitForContentLakeEventualConsistency?: boolean,
  ) => Promise<{ body: T | null; isValidSignature: boolean | null }>;
  getProductForStockSync: (id: string) => Promise<TProduct | null>;
  syncProductStockFromProduct: (product: TProduct) => Promise<unknown>;
  untrackProductStock: (id: string) => Promise<unknown>;
}

export async function POST(req: NextRequest): Promise<Response> {
  const [{ parseBody }, { getWebhookSecret }, { loaders }, sync] =
    await Promise.all([
      import("next-sanity/webhook"),
      import("@/sanity/env"),
      import("@/data/loaders"),
      import("@/lib/commerce/product-stock-sync"),
    ]);

  return createInventorySyncPostHandler({
    getWebhookSecret,
    parseBody,
    getProductForStockSync: loaders.getProductForStockSync,
    syncProductStockFromProduct: sync.syncProductStockFromProduct,
    untrackProductStock: sync.untrackProductStock,
  })(req);
}

export function createInventorySyncPostHandler(
  dependencies: InventorySyncWebhookDependencies,
): (req: NextRequest) => Promise<Response> {
  return async function postInventorySync(req: NextRequest): Promise<Response> {
    let webhookSecret: string;
    try {
      webhookSecret = dependencies.getWebhookSecret();
    } catch {
      log("warn", "[inventory-sync] Missing webhook secret");
      return new Response(null, { status: 401 });
    }
    if (!webhookSecret) {
      log("warn", "[inventory-sync] Missing webhook secret");
      return new Response(null, { status: 401 });
    }

    // Verifies HMAC before parsing; the third arg waits for content-lake
    // consistency so the follow-up fetch sees the just-published document.
    const { body, isValidSignature } = await dependencies.parseBody<{
      _id?: string;
      _type?: string;
    }>(req, webhookSecret, true);

    if (isValidSignature !== true) {
      log("warn", "[inventory-sync] Invalid webhook signature");
      return new Response(null, { status: 401 });
    }
    if (!body?._type) {
      return new Response(null, { status: 400 });
    }
    if (body._type !== "product") {
      // Only products carry stock; anything else is a harmless no-op.
      return new Response(null, { status: 200 });
    }

    const id = typeof body._id === "string" ? body._id : "";
    if (!id) {
      return new Response(null, { status: 400 });
    }

    try {
      const product = await dependencies.getProductForStockSync(id);
      if (product) {
        // Present (published) -> seed/reset from the authored set-point.
        await dependencies.syncProductStockFromProduct(product);
      } else {
        // Deleted or unpublished -> untrack so it stops gating checkout.
        await dependencies.untrackProductStock(id);
      }
    } catch (error) {
      log("error", "[inventory-sync] Stock sync failed", {
        error: error instanceof Error ? error.message : "unknown",
      });
      return new Response(null, { status: 500 });
    }

    return new Response(null, { status: 200 });
  };
}
