import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { mintApplicationToken } from "@/lib/api-integration/application-jwt";
import { getGatewayTransport } from "@/lib/api-integration/gateway-transport";
import { readSameOriginJson } from "@/lib/api-integration/same-origin-json";
import { IntegrationServiceError, integrationErrorResponse, upstreamIntegrationError } from "@/lib/api-integration/service-errors";
import { REVIEW_DISCUSSIONS_BODY_LIMIT, reviewDiscussionsSignature } from "../../../ops/gateway/staging-review-community.mjs";
import { reviewCourse, reviewSameOrigin, reviewSettings } from "./session";

const uuid = z.string().uuid();
const inputText = z.string().trim().min(1).max(4000);
const postInput = z.object({ body: inputText }).strict();
const replyInput = postInput.extend({ replyId: uuid }).strict();
const item = z.object({ id: uuid, body: z.string(), author: z.string(), mine: z.boolean() });
const thread = z.object({
  space: z.object({ courseId: uuid, title: z.string() }),
  post: item.extend({ locked: z.boolean() }),
  comments: z.array(item).max(20),
});
const outcome = z.object({ id: uuid }).strict();

export function reviewDiscussionSettings() {
  const config = reviewSettings();
  const key = process.env.STAGING_REVIEW_DISCUSSIONS_KEY;
  return config && key && /^[a-f0-9]{64}$/u.test(key) ? { ...config, key } : null;
}

async function send(
  scope: NonNullable<ReturnType<typeof reviewDiscussionSettings>>,
  subject: string,
  method: "GET" | "POST",
  path: string,
  input?: z.infer<typeof replyInput> | z.infer<typeof postInput>,
) {
  if (subject !== scope.subject) throw new IntegrationServiceError("forbidden", 403);
  const body = input === undefined ? undefined : JSON.stringify(input);
  const token = mintApplicationToken({ profile: "community-member", customerId: subject });
  const nonce = randomUUID();
  const expires = Math.min(scope.end, Math.floor(Date.now() / 1000) + 30);
  const signed = reviewDiscussionsSignature(scope.key, {
    method, target: "/community" + path, body: body ?? "", token, expires, nonce,
  });
  const response = await getGatewayTransport()({
    method, service: "community", path, body, applicationToken: token,
    stagingReviewDiscussionsProof: `1.${expires}.${nonce}.${signed}`,
  });
  const data: unknown = await response.json();
  if (!response.ok) {
    const result = z.object({ error: z.object({ code: z.string() }) }).safeParse(data);
    throw upstreamIntegrationError(response.status, result.data?.error.code ?? "",
      response.headers.get("x-request-id"), response.headers.get("retry-after"));
  }
  return { data, status: response.status };
}

export async function getReviewDiscussion(
  scope: NonNullable<ReturnType<typeof reviewDiscussionSettings>>,
  subject: string,
  postId: string,
) {
  if (!uuid.safeParse(postId).success) throw new IntegrationServiceError("not_found", 404);
  const { data } = await send(scope, subject, "GET", `/v1/discussions/${postId}`);
  const result = thread.parse(data);
  if (result.space.courseId !== reviewCourse || result.post.id !== postId || !result.post.mine)
    throw new IntegrationServiceError("not_found", 404);
  return result;
}

export async function reviewDiscussionMutation(request: Request, method: string, parts: string[], subject: string) {
  try {
    const config = reviewDiscussionSettings();
    const create = parts.length === 1;
    const postId = parts[1];
    const reply = parts.length === 3 && parts[2] === "replies" && uuid.safeParse(postId).success;
    if (!config || method !== "POST" || new URL(request.url).search || (!create && !reply))
      throw new IntegrationServiceError("not_found", 404);
    if (!reviewSameOrigin(request)) throw new IntegrationServiceError("forbidden", 403);
    const body = await readSameOriginJson(request, new URL(request.url).origin, REVIEW_DISCUSSIONS_BODY_LIMIT);
    const parsed = (create ? postInput : replyInput).safeParse(body);
    if (!parsed.success) throw new IntegrationServiceError("invalid_request", 400);
    const path = create ? `/v1/spaces/${reviewCourse}/posts` : `/v1/discussions/${postId}/comments`;
    if (reply) {
      const discussion = await getReviewDiscussion(config, subject, postId);
      if (discussion.post.locked) throw new IntegrationServiceError("conflict", 409);
    }
    const result = await send(config, subject, "POST", path, parsed.data);
    if (result.status !== 201) throw new IntegrationServiceError("service_unavailable", 503);
    return Response.json(outcome.parse(result.data), {
      status: 201, headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
    });
  } catch (error) {
    return integrationErrorResponse(error);
  }
}
