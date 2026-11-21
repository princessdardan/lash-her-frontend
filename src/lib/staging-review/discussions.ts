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
  method: "GET" | "POST" | "PATCH" | "DELETE",
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
    const [, postId, segment, replyId] = parts;
    const create = method === "POST" && parts.length === 1;
    const reply = method === "POST" && parts.length === 3 && segment === "replies";
    const change = (method === "PATCH" || method === "DELETE") &&
      (parts.length === 2 || (parts.length === 4 && segment === "replies" && uuid.safeParse(replyId).success));
    if (!config || new URL(request.url).search || (!create && !(uuid.safeParse(postId).success && (reply || change))))
      throw new IntegrationServiceError("not_found", 404);
    if (!reviewSameOrigin(request)) throw new IntegrationServiceError("forbidden", 403);
    const body = await readSameOriginJson(request, new URL(request.url).origin, REVIEW_DISCUSSIONS_BODY_LIMIT);
    const parsed = (method === "DELETE" ? z.object({}).strict() : reply ? replyInput : postInput).safeParse(body);
    if (!parsed.success) throw new IntegrationServiceError("invalid_request", 400);

    let path = `/v1/spaces/${reviewCourse}/posts`;
    if (!create) {
      const discussion = await getReviewDiscussion(config, subject, postId);
      if (method !== "DELETE" && discussion.post.locked) throw new IntegrationServiceError("conflict", 409);
      if (reply) {
        path = `/v1/discussions/${postId}/comments`;
      } else {
        if (replyId && !discussion.comments.some((comment) => comment.id === replyId && comment.mine))
          throw new IntegrationServiceError("not_found", 404);
        if (!replyId && method === "DELETE" && postId === process.env.STAGING_REVIEW_MEDIA_POST)
          throw new IntegrationServiceError("forbidden", 403);
        path = `/v1/content/${replyId ?? postId}`;
      }
    }
    const verb = method === "DELETE" || method === "PATCH" ? method : "POST";
    const result = await send(config, subject, verb, path, verb === "DELETE" ? undefined : parsed.data as z.infer<typeof postInput>);
    if (result.status !== (verb === "POST" ? 201 : 200)) throw new IntegrationServiceError("service_unavailable", 503);
    return Response.json(outcome.parse(result.data), {
      status: result.status, headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
    });
  } catch (error) {
    return integrationErrorResponse(error);
  }
}
