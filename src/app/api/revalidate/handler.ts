import type { NextRequest } from "next/server";

import { log } from "@/lib/logging/logger";

// Map Sanity document _type to cache tag (per D-01, D-05, D-06, D-07)
const TYPE_TAG_MAP: Record<string, string> = {
  homePage: "homePage",
  contactPage: "contactPage",
  galleryPage: "galleryPage",
  trainingPage: "trainingPage",
  trainingProgramsPage: "trainingProgramsPage",
  trainingProgram: "trainingProgram",
  productsPage: "productsPage",
  productCollection: "productCollection",
  promotionCode: "promotionCode",
  policyPage: "policyPage",
  product: "product",
  service: "service",
  globalSettings: "global",
  mainMenu: "menu",
  bookingSettings: "bookingSettings",
};

interface RevalidateWebhookDependencies {
  getWebhookSecret: () => string;
  parseBody: <T>(
    req: NextRequest,
    secret: string,
    waitForContentLakeEventualConsistency?: boolean,
  ) => Promise<{ body: T | null; isValidSignature: boolean | null }>;
  revalidateTag: (tag: string, profile: { expire: 0 }) => void;
  /**
   * Optional fold-in: reconcile a product's Postgres stock when it publishes.
   * Fire-and-forget from the handler's perspective; the real wiring runs it
   * after the response so it can never fail cache revalidation.
   */
  syncProductStock?: (id: string) => void;
}

export async function POST(req: NextRequest): Promise<Response> {
  const [
    { revalidateTag },
    { after },
    { parseBody },
    { getWebhookSecret },
    { syncProductStockForPublishedId },
  ] = await Promise.all([
    import("next/cache"),
    import("next/server"),
    import("next-sanity/webhook"),
    import("@/sanity/env"),
    import("@/lib/commerce/product-stock-sync"),
  ]);

  return createRevalidatePostHandler({
    getWebhookSecret,
    parseBody,
    revalidateTag,
    // The stock sync is a set-point detector, so an unchanged stock number is a
    // no-op — a plain product edit never resets the live count. Runs after the
    // response so a DB hiccup cannot break revalidation.
    syncProductStock: (id) =>
      after(async () => {
        try {
          await syncProductStockForPublishedId(id);
        } catch (error) {
          log("error", "[revalidate] product stock sync failed", {
            error: error instanceof Error ? error.message : "unknown",
          });
        }
      }),
  })(req);
}

export function createRevalidatePostHandler(
  dependencies: RevalidateWebhookDependencies,
): (req: NextRequest) => Promise<Response> {
  return async function postRevalidate(req: NextRequest): Promise<Response> {
    let webhookSecret: string;

    try {
      webhookSecret = dependencies.getWebhookSecret();
    } catch {
      log("warn", "[revalidate] Missing webhook secret");
      return new Response(null, { status: 401 });
    }

    if (!webhookSecret) {
      log("warn", "[revalidate] Missing webhook secret");
      return new Response(null, { status: 401 });
    }

    // parseBody reads raw body text, verifies HMAC-SHA256, then JSON.parses
    // Do NOT call req.json() before this — it would consume the stream
    const { body, isValidSignature } = await dependencies.parseBody<{
      _id?: string;
      _type: string;
    }>(req, webhookSecret, true);

    // Per D-08: HTTP status codes only, no detail in response body
    // Per Pitfall 4: isValidSignature is null when no secret — treat as failure
    if (isValidSignature !== true) {
      log("warn", "[revalidate] Invalid webhook signature");
      return new Response(null, { status: 401 });
    }

    if (!body?._type) {
      log("warn", "[revalidate] Webhook body missing _type");
      return new Response(null, { status: 400 });
    }

    const tag = TYPE_TAG_MAP[body._type];

    if (!tag) {
      // Unknown type — not an error, just nothing to revalidate (per D-09)
      log("info", `[revalidate] Unhandled _type: ${body._type} — no-op`);
      return new Response(null, { status: 200 });
    }

    // Per research: Next.js 16 requires { expire: 0 } for immediate expiry
    // Single-arg revalidateTag(tag) is deprecated in Next.js 16
    dependencies.revalidateTag(tag, { expire: 0 });
    log("info", `[revalidate] tag='${tag}' _type='${body._type}'`);

    // Fold-in: a product publish also reconciles that product's stock. Only a
    // changed set-point resets the live count, so ordinary edits are no-ops.
    if (body._type === "product" && body._id) {
      dependencies.syncProductStock?.(body._id);
    }

    return new Response(null, { status: 200 });
  };
}
