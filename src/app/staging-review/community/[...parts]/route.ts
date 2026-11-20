import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getGatewayTransport } from "@/lib/api-integration/gateway-transport";
import { mintApplicationToken } from "@/lib/api-integration/application-jwt";
import { readSameOriginJson } from "@/lib/api-integration/same-origin-json";
import { IntegrationServiceError } from "@/lib/api-integration/service-errors";
import { reviewDiscussionMutation } from "@/lib/staging-review/discussions";
import { getReviewSubject, reviewSameOrigin, reviewSettings } from "@/lib/staging-review/session";
import { reviewMediaSignature } from "../../../../../ops/gateway/staging-review-media.mjs";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const upload = z.object({
  id: z.string().regex(uuid),
  type: z.enum(["image/jpeg", "image/png", "image/webp"]),
  bytes: z.number().int().min(1).max(10 * 1024 * 1024),
  checksum: z.string().regex(/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/u),
}).strict();
const empty = z.object({}).strict();
const headers = { "cache-control": "private, no-store" };

function failure(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status, headers });
}

export function GET(request: Request, context: { params: Promise<{ parts: string[] }> }) {
  return media(request, context, "GET");
}

export function POST(request: Request, context: { params: Promise<{ parts: string[] }> }) {
  return media(request, context, "POST");
}

export function DELETE(request: Request, context: { params: Promise<{ parts: string[] }> }) {
  return media(request, context, "DELETE");
}

async function media(
  request: Request,
  context: { params: Promise<{ parts: string[] }> },
  method: "GET" | "POST" | "DELETE",
) {
  const { parts } = await context.params;
  const [area, id, operation] = parts;
  if (area === "posts") {
    const subject = await getReviewSubject();
    if (!subject) return failure(401, "sign_in_required", "Sign in to the staging review first.");
    return reviewDiscussionMutation(request, method, parts, subject);
  }
  const config = reviewSettings();
  const { STAGING_REVIEW_MEDIA_POST: post, STAGING_REVIEW_MEDIA_KEY: key } = process.env;
  if (!config || !post || !uuid.test(post) || !key || !/^[0-9a-f]{64}$/u.test(key))
    return failure(404, "feature_disabled", "Staging image access is unavailable.");
  const subject = await getReviewSubject();
  if (!subject) return failure(401, "sign_in_required", "Sign in to the staging review first.");
  const list = area === "discussions" && id === post && operation === "media" && parts.length === 3;
  const asset = area === "media" && id && uuid.test(id) && (
    (parts.length === 2 && method === "DELETE") ||
    (parts.length === 3 && ((method === "GET" && operation === "view") || (method === "POST" && operation === "complete")))
  );
  if (!(list && method !== "DELETE") && !asset)
    return failure(404, "not_found", "This image or discussion is unavailable.");

  try {
    let body: string | undefined;
    if (method !== "GET") {
      if (!reviewSameOrigin(request)) return failure(403, "forbidden", "Use the staging review to change images.");
      const input = await readSameOriginJson(request, new URL(request.url).origin, 1024);
      const parsed = (list ? upload : empty).safeParse(input);
      if (!parsed.success) return failure(400, "invalid_request", "The image request is invalid.");
      body = method === "DELETE" ? undefined : JSON.stringify(parsed.data);
    }
    const transport = getGatewayTransport();
    const token = mintApplicationToken({ profile: "community-member", customerId: subject });
    function send(verb: "GET" | "POST" | "DELETE", path: string, payload?: string) {
      const nonce = randomUUID();
      const expires = Math.min(config!.end, Math.floor(Date.now() / 1000) + 30);
      const signature = reviewMediaSignature(key!, { method: verb, target: "/community" + path,
        body: payload ?? "", token, expires, nonce });
      return transport({ method: verb, service: "community", path, body: payload,
        applicationToken: token, stagingReviewMediaProof: `1.${expires}.${nonce}.${signature}` });
    }
    const listPath = `/v1/discussions/${post}/media`;
    if (asset) {
      const response = await send("GET", listPath);
      if (!response.ok) return failure(response.status, "media_unavailable", "The discussion images are unavailable.");
      const data = await response.json() as { images?: { id?: string }[] };
      if (!Array.isArray(data.images) || !data.images.some((image) => image.id === id))
        return failure(404, "not_found", "This image is unavailable.");
    }
    const path = list ? listPath : `/v1/media/${id}${operation ? "/" + operation : ""}`;
    const response = await send(method, path, body);
    return new Response(response.body, {
      status: response.status,
      headers: { ...headers, "content-type": "application/json", "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff" },
    });
  } catch (error) {
    if (error instanceof IntegrationServiceError)
      return failure(error.status, error.code, "Use the staging review to submit a valid image request.");
    return failure(503, "media_unavailable", "Community image storage is temporarily unavailable.");
  }
}
