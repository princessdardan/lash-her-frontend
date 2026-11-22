import type { paths } from "@/lib/api-integration/generated/community-discussions";

export type CommunitySpaces =
  paths["/v1/spaces"]["get"]["responses"][200]["content"]["application/json"];
export type CommunityFeed =
  paths["/v1/spaces/{courseId}/posts"]["get"]["responses"][200]["content"]["application/json"];
export type CommunityThread =
  paths["/v1/discussions/{postId}"]["get"]["responses"][200]["content"]["application/json"];
export type CommunityReports =
  paths["/v1/moderation/reports"]["get"]["responses"][200]["content"]["application/json"];
export type ModerationAction =
  paths["/v1/moderation/actions"]["post"]["requestBody"]["content"]["application/json"]["action"];
export const communityHref = (courseId: string) =>
  `/community/courses/${courseId}`;
export const discussionHref = (postId: string) =>
  `/community/discussions/${postId}`;

export class CommunityRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? "Community is temporarily unavailable.");
  }
}

export async function communityFetch<T>(
  path: string,
  options?: { method: "POST" | "PUT" | "PATCH" | "DELETE"; body: object },
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store",
    signal,
    ...(options
      ? {
          method: options.method,
          body: JSON.stringify(options.body),
          headers: { "content-type": "application/json", "x-lash-csrf": "1" },
        }
      : {}),
  });
  const data = await response.json();
  if (!response.ok)
    throw new CommunityRequestError(
      response.status,
      data.error?.code,
      data.error?.message,
    );
  return data as T;
}

export const communityMembersHref = (courseId: string) =>
  `${communityHref(courseId)}/members`;
export const communityMemberHref = (courseId: string, memberId: string) =>
  `${communityMembersHref(courseId)}/${memberId}`;
