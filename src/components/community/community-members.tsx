"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { paths } from "@/lib/api-integration/generated/community-discussions";
import {
  communityHref,
  communityMemberHref,
  communityMembersHref,
} from "@/lib/community/client";
import { customerSignInHref } from "@/lib/learning/presentation";
import { useCommunityResource } from "./use-community-resource";

type Directory =
  paths["/v1/spaces/{courseId}/members"]["get"]["responses"][200]["content"]["application/json"];
type Profile =
  paths["/v1/spaces/{courseId}/members/{memberId}"]["get"]["responses"][200]["content"]["application/json"];
const linkClass = "underline underline-offset-4";

export function CommunityMembers({
  courseId,
  memberId,
}: {
  courseId: string;
  memberId?: string;
}) {
  const [search, setSearch] = useState("");
  const [after, setAfter] = useState<string>();
  const query = new URLSearchParams();
  if (search) query.set("search", search);
  if (after) query.set("after", after);
  const directoryHref = communityMembersHref(courseId);
  const currentHref = memberId
    ? communityMemberHref(courseId, memberId)
    : directoryHref;
  const path = `/api/community/spaces/${courseId}/members`;
  const suffix = memberId
    ? `/${memberId}`
    : query.size
      ? `?${query.toString()}`
      : "";
  const { data, error, refresh } = useCommunityResource<Directory | Profile>(
    path + suffix,
    true,
  );
  const profile = data && "member" in data ? data.member : undefined;

  return (
    <section className="space-y-6">
      <nav aria-label="Community navigation" className="flex flex-wrap gap-4">
        <Link className={linkClass} href={communityHref(courseId)}>
          Discussions
        </Link>
        {memberId && (
          <Link className={linkClass} href={directoryHref}>
            Members
          </Link>
        )}
      </nav>
      <header className="space-y-2">
        <h1 className="font-heading text-4xl">
          {memberId ? (profile?.displayName ?? "Member profile") : "Members"}
        </h1>
        {data && <p>{data.space.title}</p>}
      </header>
      {error ? (
        <div className="space-y-3" role="alert">
          <p>{error.message}</p>
          {error.status === 401 ? (
            <Link className={linkClass} href={customerSignInHref(currentHref)}>
              Sign in
            </Link>
          ) : (
            <Button type="button" variant="outline" onClick={refresh}>
              Check access again
            </Button>
          )}
        </div>
      ) : !data ? (
        <p role="status">
          {memberId ? "Loading profile…" : "Loading members…"}
        </p>
      ) : (
        "members" in data && (
          <div className="space-y-5">
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                setAfter(undefined);
                setSearch(
                  String(
                    new FormData(event.currentTarget).get("search") ?? "",
                  ).trim(),
                );
              }}
            >
              <label>
                <span className="block">Search members by name</span>
                <input
                  className="rounded-md border border-lh-shadow/25 bg-background p-3"
                  name="search"
                  type="search"
                  maxLength={100}
                />
              </label>
              <Button type="submit" variant="outline">
                Search
              </Button>
            </form>
            {data.members.length ? (
              <ul className="divide-y divide-lh-shadow/15 rounded-lg border border-lh-shadow/15">
                {data.members.map((entry) => (
                  <li key={entry.id} className="p-4">
                    <Link
                      prefetch={false}
                      className={linkClass}
                      href={communityMemberHref(courseId, entry.id)}
                    >
                      {entry.displayName}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p>
                {search
                  ? "No matching members."
                  : "No member profiles are available in this space."}
              </p>
            )}
            <div className="flex flex-wrap gap-3">
              {after && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setAfter(undefined)}
                >
                  First page
                </Button>
              )}
              {data.next && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setAfter(data.next ?? undefined)}
                >
                  Next page
                </Button>
              )}
            </div>
          </div>
        )
      )}
    </section>
  );
}
