import { revalidateTag } from "next/cache";
import type { NextRequest } from "next/server";
import { parseBody } from "next-sanity/webhook";
import { getWebhookSecret } from "@/sanity/env";

// Map Sanity document _type to cache tag (per D-01, D-05, D-06, D-07)
const TYPE_TAG_MAP: Record<string, string> = {
  homePage: "homePage",
  contactPage: "contactPage",
  galleryPage: "galleryPage",
  trainingPage: "trainingPage",
  trainingProgram: "trainingProgram",
  globalSettings: "global",
  mainMenu: "menu",
};

export async function POST(req: NextRequest): Promise<Response> {
  // parseBody reads raw body text, verifies HMAC-SHA256, then JSON.parses
  // Do NOT call req.json() before this — it would consume the stream
  const { body, isValidSignature } = await parseBody<{ _type: string }>(
    req,
    getWebhookSecret(),
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
  revalidateTag(tag, { expire: 0 });
  console.log(`[revalidate] tag='${tag}' _type='${body._type}'`);

  return new Response(null, { status: 200 });
}
