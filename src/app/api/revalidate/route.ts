import type { NextRequest } from "next/server";

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
  product: "product",
  service: "service",
  globalSettings: "global",
  mainMenu: "menu",
  bookingSettings: "bookingSettings",
  bookingOffering: "bookingOffering",
};

interface RevalidateWebhookDependencies {
  getWebhookSecret: () => string;
  parseBody: <T>(
    req: NextRequest,
    secret: string,
  ) => Promise<{ body: T | null; isValidSignature: boolean | null }>;
  revalidateTag: (tag: string, profile: { expire: 0 }) => void;
}

export async function POST(req: NextRequest): Promise<Response> {
  const [{ revalidateTag }, { parseBody }, { getWebhookSecret }] = await Promise.all([
    import("next/cache"),
    import("next-sanity/webhook"),
    import("@/sanity/env"),
  ]);

  return createRevalidatePostHandler({
    getWebhookSecret,
    parseBody,
    revalidateTag,
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
      console.warn("[revalidate] Missing webhook secret");
      return new Response(null, { status: 401 });
    }

    if (!webhookSecret) {
      console.warn("[revalidate] Missing webhook secret");
      return new Response(null, { status: 401 });
    }

    // parseBody reads raw body text, verifies HMAC-SHA256, then JSON.parses
    // Do NOT call req.json() before this — it would consume the stream
    const { body, isValidSignature } = await dependencies.parseBody<{ _type: string }>(
      req,
      webhookSecret,
    );

    // Per D-08: HTTP status codes only, no detail in response body
    // Per Pitfall 4: isValidSignature is null when no secret — treat as failure
    if (isValidSignature !== true) {
      console.warn("[revalidate] Invalid webhook signature");
      return new Response(null, { status: 401 });
    }

    if (!body?._type) {
      console.warn("[revalidate] Webhook body missing _type");
      return new Response(null, { status: 400 });
    }

    const tag = TYPE_TAG_MAP[body._type];

    if (!tag) {
      // Unknown type — not an error, just nothing to revalidate (per D-09)
      console.log(`[revalidate] Unhandled _type: ${body._type} — no-op`);
      return new Response(null, { status: 200 });
    }

    // Per research: Next.js 16 requires { expire: 0 } for immediate expiry
    // Single-arg revalidateTag(tag) is deprecated in Next.js 16
    dependencies.revalidateTag(tag, { expire: 0 });
    console.log(`[revalidate] tag='${tag}' _type='${body._type}'`);

    return new Response(null, { status: 200 });
  };
}
