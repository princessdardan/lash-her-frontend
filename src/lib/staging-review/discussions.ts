import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { mintApplicationToken } from "@/lib/api-integration/application-jwt";
import { getGatewayTransport } from "@/lib/api-integration/gateway-transport";
import { readSameOriginJson } from "@/lib/api-integration/same-origin-json";
import { IntegrationServiceError, integrationErrorResponse, upstreamIntegrationError } from "@/lib/api-integration/service-errors";
import { isReviewDiscussionCursor, REVIEW_DISCUSSIONS_BODY_LIMIT, reviewDiscussionsSignature } from "../../../ops/gateway/staging-review-community.mjs";
import { reviewCourse, reviewSameOrigin, reviewSettings } from "./session";

export { isReviewDiscussionCursor };

const uuid = z.string().uuid();
const inputText = z.string().trim().min(1).max(4000);
const postInput = z.object({ body: inputText }).strict();
const profileInput = z.object({ displayName: z.string().trim().min(1).max(60) }).strict();
const ownProfile = z.object({ profile: profileInput.nullable() });
const reactionInput = z.object({ active: z.boolean() }).strict();
const replyInput = postInput.extend({ replyId: uuid }).strict();
const item = z.object({ id: uuid, body: z.string(), author: z.string(), mine: z.boolean() });
const thread = z.object({
  space: z.object({ courseId: uuid, title: z.string() }),
  post: item.extend({ locked: z.boolean(), reacted: z.boolean(), reactionCount: z.number().int().nonnegative() }),
  comments: z.array(item).max(20),
  next: z.string().refine(isReviewDiscussionCursor).nullable(),
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
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  input?: object,
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
  after?: string,
) {
  if (!uuid.safeParse(postId).success || (after !== undefined && !isReviewDiscussionCursor(after)))
    throw new IntegrationServiceError("not_found", 404);
  const { data } = await send(scope, subject, "GET", `/v1/discussions/${postId}${after ? `?after=${after}` : ""}`);
  const result = thread.parse(data);
  if (result.space.courseId !== reviewCourse || result.post.id !== postId || !result.post.mine)
    throw new IntegrationServiceError("not_found", 404);
  return result;
}

export async function reviewDiscussionMutation(request: Request, method: string, parts: string[], subject: string) {
  try {
    const config = reviewDiscussionSettings();
    const [, postId, segment, replyId] = parts;
    const create = method === "POST" && parts.length === 1;
    const reply = method === "POST" && parts.length === 3 && segment === "replies";
    const reaction = method === "PUT" && parts.length === 3 && segment === "reaction";
    const change = (method === "PATCH" || method === "DELETE") &&
      (parts.length === 2 || (parts.length === 4 && segment === "replies" && uuid.safeParse(replyId).success));
    const query = new URL(request.url).search;
    // An older reply is authorized against its page of the same owned thread.
    const after = change && replyId && query.startsWith("?after=") ? query.slice("?after=".length) : undefined;
    if (!config || (query && !isReviewDiscussionCursor(after)) ||
        (!create && !(uuid.safeParse(postId).success && (reply || change || reaction))))
      throw new IntegrationServiceError("not_found", 404);
    if (!reviewSameOrigin(request)) throw new IntegrationServiceError("forbidden", 403);
    const body = await readSameOriginJson(request, new URL(request.url).origin, REVIEW_DISCUSSIONS_BODY_LIMIT);
    const input = method === "DELETE" ? z.object({}).strict() : reaction ? reactionInput : reply ? replyInput : postInput;
    const parsed = input.safeParse(body);
    if (!parsed.success) throw new IntegrationServiceError("invalid_request", 400);

    let path = `/v1/spaces/${reviewCourse}/posts`;
    if (!create) {
      const discussion = await getReviewDiscussion(config, subject, postId, after);
      const removingReaction = reaction && "active" in parsed.data && parsed.data.active === false;
      if (method !== "DELETE" && !removingReaction && discussion.post.locked)
        throw new IntegrationServiceError("conflict", 409);
      if (reaction) {
        path = `/v1/discussions/${postId}/reaction`;
      } else if (reply) {
        path = `/v1/discussions/${postId}/comments`;
      } else {
        if (replyId && !discussion.comments.some((comment) => comment.id === replyId && comment.mine))
          throw new IntegrationServiceError("not_found", 404);
        if (!replyId && method === "DELETE" && postId === process.env.STAGING_REVIEW_MEDIA_POST)
          throw new IntegrationServiceError("forbidden", 403);
        path = `/v1/content/${replyId ?? postId}`;
      }
    }
    const verb = method === "DELETE" || method === "PATCH" || method === "PUT" ? method : "POST";
    const result = await send(config, subject, verb, path, verb === "DELETE" ? undefined : parsed.data);
    if (result.status !== (verb === "POST" ? 201 : 200)) throw new IntegrationServiceError("service_unavailable", 503);
    return Response.json(outcome.parse(result.data), {
      status: result.status, headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
    });
  } catch (error) {
    return integrationErrorResponse(error);
  }
}

export async function getReviewProfile(
  scope: NonNullable<ReturnType<typeof reviewDiscussionSettings>>,
  subject: string,
) {
  const { data } = await send(scope, subject, "GET", "/v1/profile");
  return ownProfile.parse(data);
}

export async function reviewProfileResource(request: Request, method: string, subject: string) {
  const headers = { "cache-control": "private, no-store" };
  try {
    const config = reviewDiscussionSettings();
    if (!config || new URL(request.url).search || (method !== "GET" && method !== "PUT"))
      throw new IntegrationServiceError("not_found", 404);
    if (method === "GET") return Response.json(await getReviewProfile(config, subject), { headers });
    if (!reviewSameOrigin(request)) throw new IntegrationServiceError("forbidden", 403);
    const input = await readSameOriginJson(request, new URL(request.url).origin, 1024);
    const parsed = profileInput.safeParse(input);
    if (!parsed.success) throw new IntegrationServiceError("invalid_request", 400);
    const result = await send(config, subject, "PUT", "/v1/profile", parsed.data);
    if (result.status !== 200) throw new IntegrationServiceError("service_unavailable", 503);
    return Response.json(outcome.parse(result.data), { headers });
  } catch (error) {
    return integrationErrorResponse(error);
  }
}
