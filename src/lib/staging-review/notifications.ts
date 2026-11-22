import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireStagingOwnerCourseReader } from "@/lib/admin/auth";
import { stagingOwnerRequest } from "@/lib/admin/staging-owner-auth";
import { AdminAuthError } from "@/lib/admin/types";
import { mintApplicationToken } from "@/lib/api-integration/application-jwt";
import { getGatewayTransport } from "@/lib/api-integration/gateway-transport";
import { IntegrationServiceError } from "@/lib/api-integration/service-errors";
import { reviewDiscussionsSignature } from "../../../ops/gateway/staging-review-community.mjs";
import {
  recipientNotificationProofKey,
  reviewReplyBody,
  validNotificationScope,
} from "../../../ops/gateway/staging-review-notifications.mjs";
import { getReviewSubject, reviewSettings } from "./session";

export const reviewNotificationsPath = "/staging-review/notifications";
const sharedScope = z.object({
  recipient: z.string().uuid(),
  post: z.string().uuid(),
  end: z.number(),
  admissionSha256: z.string(),
});
const scopeSchema = z.union([
  sharedScope.extend({ mode: z.literal("recipient") }).strict(),
  sharedScope
    .extend({
      key: z.string(),
      replier: z.string().uuid(),
      reply: z.string().uuid(),
    })
    .strict(),
]);

export function notificationSettings() {
  const parent = reviewSettings();
  if (!parent || !process.env.STAGING_REVIEW_NOTIFICATIONS_SETTINGS)
    return null;
  try {
    const config = scopeSchema.parse(
      JSON.parse(process.env.STAGING_REVIEW_NOTIFICATIONS_SETTINGS),
    );
    const scope =
      "mode" in config
        ? {
            ...config,
            key: recipientNotificationProofKey(
              config,
              process.env.STAGING_REVIEW_DISCUSSIONS_KEY,
            ),
          }
        : config;
    return validNotificationScope(scope) &&
      typeof scope.key === "string" &&
      scope.recipient === parent.subject &&
      scope.end <= parent.end &&
      scope.end > Date.now() / 1000
      ? scope
      : null;
  } catch {
    return null;
  }
}

type Scope = NonNullable<ReturnType<typeof notificationSettings>>;
export type ReviewNotificationActor = {
  subject: string;
  role: "recipient" | "replier";
};

export async function reviewNotificationActor(
  scope: Scope,
): Promise<ReviewNotificationActor | null> {
  if ((await getReviewSubject()) === scope.recipient)
    return { subject: scope.recipient, role: "recipient" };
  if ("mode" in scope) return null;
  if (!(await stagingOwnerRequest())) return null;
  try {
    // Only the existing Google owner may operate this synthetic replier.
    await requireStagingOwnerCourseReader();
    return { subject: scope.replier, role: "replier" };
  } catch (error) {
    if (error instanceof AdminAuthError) return null;
    throw error;
  }
}

async function send(
  scope: Scope,
  actor: ReviewNotificationActor,
  method: "GET" | "POST" | "PUT",
  path: string,
  input?: object,
) {
  const token = mintApplicationToken({
    profile: "community-member",
    customerId: actor.subject,
  });
  const body = input === undefined ? undefined : JSON.stringify(input);
  const now = Math.floor(Date.now() / 1000);
  const expires = Math.min(scope.end, now + 30);
  if (expires <= now)
    throw new IntegrationServiceError("feature_disabled", 404);
  const nonce = randomUUID();
  if (typeof scope.key !== "string")
    throw new IntegrationServiceError("feature_disabled", 404);
  const signature = reviewDiscussionsSignature(scope.key, {
    method,
    target: "/community" + path,
    body: body ?? "",
    token,
    expires,
    nonce,
  });
  const response = await getGatewayTransport()({
    service: "community",
    method,
    path,
    applicationToken: token,
    body,
    stagingReviewNotificationsProof: `1.${expires}.${nonce}.${signature}`,
  });
  if (response.status !== (method === "POST" ? 201 : 200))
    throw new IntegrationServiceError(
      "service_unavailable",
      503,
      response.headers.get("x-request-id"),
    );
  return response.json();
}

const list = z.object({
  notifications: z
    .array(
      z.object({
        id: z.string().uuid(),
        postId: z.string().uuid().nullable(),
        kind: z.enum(["reply", "moderation"]),
        read: z.boolean(),
      }),
    )
    .max(20),
});

export async function getReviewNotifications(
  scope: Scope,
  actor: ReviewNotificationActor,
) {
  const inbox = list.parse(
    await send(scope, actor, "GET", "/v1/notifications"),
  );
  return inbox.notifications.filter(
    (row) => row.kind === "reply" && row.postId === scope.post,
  );
}

export async function sendSyntheticReply(
  scope: Scope,
  actor: ReviewNotificationActor,
) {
  if ("mode" in scope || actor.role !== "replier")
    throw new IntegrationServiceError("forbidden", 403);
  const reply = z
    .object({ id: z.string().uuid() })
    .parse(
      await send(
        scope,
        actor,
        "POST",
        `/v1/discussions/${scope.post}/comments`,
        { body: reviewReplyBody, replyId: scope.reply },
      ),
    );
  if (reply.id !== scope.reply)
    throw new IntegrationServiceError("service_unavailable", 503);
}

export async function markSyntheticReplyRead(
  scope: Scope,
  actor: ReviewNotificationActor,
) {
  if (actor.role !== "recipient")
    throw new IntegrationServiceError("forbidden", 403);
  const matches = await getReviewNotifications(scope, actor);
  if (matches.length !== 1) throw new IntegrationServiceError("not_found", 404);
  const [notice] = matches;
  const result = z
    .object({ id: z.string().uuid(), read: z.literal(true) })
    .parse(
      await send(scope, actor, "PUT", `/v1/notifications/${notice.id}/read`, {
        read: true,
      }),
    );
  if (result.id !== notice.id)
    throw new IntegrationServiceError("service_unavailable", 503);
}
