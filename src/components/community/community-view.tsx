"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  communityFetch,
  communityHref,
  communityMembersHref,
  discussionHref,
  CommunityRequestError,
  type CommunityFeed,
  type CommunitySpaces,
  type CommunityThread,
} from "@/lib/community/client";
import type { paths } from "@/lib/api-integration/generated/community-discussions";
import { customerSignInHref } from "@/lib/learning/presentation";
import { CommunityNotificationsLink } from "./community-notifications";
import { DiscussionMedia } from "./discussion-media";
import { useCommunityResource } from "./use-community-resource";

const api = "/api/community";
const linkClass = "underline underline-offset-4";
const panelClass =
  "space-y-4 rounded-2xl border border-lh-line bg-lh-white p-4 sm:p-5";
const inputClass =
  "w-full rounded-md border border-lh-shadow/25 bg-background p-3";

type Message =
  CommunityFeed["posts"][number] | CommunityThread["comments"][number];
type CreatedDiscussion =
  paths["/v1/spaces/{courseId}/posts"]["post"]["responses"][201]["content"]["application/json"];
type Scope =
  | { courseId: string; postId?: never }
  | { postId: string; courseId?: never }
  | { courseId?: never; postId?: never };

function TextForm({
  label,
  button,
  max,
  initial,
  onSubmit,
}: {
  label: string;
  button: string;
  max: number;
  initial?: string;
  onSubmit: (value: string) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const value = String(new FormData(form).get("text") ?? "").trim();
    if (!value) return;
    setBusy(true);
    try {
      if (await onSubmit(value)) form.reset();
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="space-y-2" onSubmit={send}>
      <label className="block space-y-2">
        <span>{label}</span>
        <textarea
          className={inputClass}
          name="text"
          rows={3}
          maxLength={max}
          required
          defaultValue={initial}
        />
      </label>
      <Button type="submit" size="sm" disabled={busy}>
        {button}
      </Button>
    </form>
  );
}

function DisplayNameForm({
  writes,
  save,
}: {
  writes: boolean;
  save: (name: string) => Promise<boolean>;
}) {
  type Profile =
    paths["/v1/profile"]["get"]["responses"][200]["content"]["application/json"];
  const { data, error, refresh } = useCommunityResource<Profile>(
    api + "/profile",
  );
  if (error) return <p role="status">{error.message}</p>;
  if (!data) return null;
  const name = data.profile?.displayName;
  if (!writes) return name ? <p>Community display name: {name}</p> : null;
  return (
    <div className="space-y-2">
      <TextForm
        key={name ?? ""}
        label="Community display name"
        button="Save display name"
        max={60}
        initial={name}
        onSubmit={async (displayName) => {
          if (!(await save(displayName))) return false;
          refresh();
          return true;
        }}
      />
      <p className="text-sm">
        Members who share a course can see your display name.
      </p>
    </div>
  );
}

function DiscussionMessage({
  message,
  writes,
  mutate,
  inFeed,
}: {
  message: Message;
  writes: boolean;
  inFeed?: boolean;
  mutate: (
    suffix: string,
    method: "POST" | "PUT" | "PATCH" | "DELETE",
    body: object,
  ) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [reporting, setReporting] = useState(false);
  const post = "reactionCount" in message ? message : undefined;
  const resource = `/content/${message.id}`;
  return (
    <article className={panelClass}>
      <div className="flex flex-wrap gap-3 text-sm">
        <strong>{message.author}</strong>
        <time dateTime={message.createdAt}>
          {new Date(message.createdAt).toLocaleDateString("en-CA")}
        </time>
        {post?.pinned && <span>Pinned</span>}
        {post?.locked && <span>Locked</span>}
      </div>
      <p className="whitespace-pre-wrap break-words">{message.body}</p>
      <div className="flex flex-wrap items-center gap-3">
        {inFeed && (
          <Link
            prefetch={false}
            className={linkClass}
            href={discussionHref(message.id)}
          >
            Open discussion
          </Link>
        )}
        {post && (
          <span className="text-sm">
            {post.reactionCount}{" "}
            {post.reactionCount === 1 ? "reaction" : "reactions"}
          </span>
        )}
        {post && writes && !post.locked && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-pressed={post.reacted}
            onClick={() =>
              void mutate(`/discussions/${post.id}/reaction`, "PUT", {
                active: !post.reacted,
              })
            }
          >
            {post.reacted ? "Remove like" : "Like"}
          </Button>
        )}
        {writes && message.mine && (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setEditing(!editing)}
              aria-expanded={editing}
            >
              Edit
            </Button>
            <details>
              <summary className="cursor-pointer underline underline-offset-4">
                Delete
              </summary>
              <p className="py-2 text-sm">
                Delete this message from the discussion?
              </p>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => void mutate(resource, "DELETE", {})}
              >
                Confirm delete
              </Button>
            </details>
          </>
        )}
        {writes && !message.mine && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setReporting(!reporting)}
            aria-expanded={reporting}
          >
            Report
          </Button>
        )}
      </div>
      {editing && (
        <TextForm
          label="Edit message"
          button="Save changes"
          max={4000}
          initial={message.body}
          onSubmit={async (body) => {
            const saved = await mutate(resource, "PATCH", { body });
            if (saved) setEditing(false);
            return saved;
          }}
        />
      )}
      {reporting && (
        <TextForm
          label="Report reason"
          button="Send report"
          max={500}
          onSubmit={async (reason) => {
            const saved = await mutate(`${resource}/reports`, "POST", {
              reason,
            });
            if (saved) setReporting(false);
            return saved;
          }}
        />
      )}
    </article>
  );
}

export function CommunityView({
  scope,
  writes,
  mediaEnabled = false,
  academyEnabled,
}: {
  scope: Scope;
  writes: boolean;
  mediaEnabled?: boolean;
  academyEnabled: boolean;
}) {
  const { courseId, postId } = scope;
  const suffix = courseId
    ? `/spaces/${courseId}/posts`
    : postId
      ? `/discussions/${postId}`
      : "/spaces";
  const returnTo = courseId
    ? communityHref(courseId)
    : postId
      ? discussionHref(postId)
      : "/community";
  const [cursors, setCursors] = useState<string[]>([]);
  const after = cursors.at(-1);
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState("");
  const [postedId, setPostedId] = useState<string>();
  const heading = useRef<HTMLHeadingElement>(null);
  const pendingReply = useRef<{ body: string; replyId: string } | undefined>(
    undefined,
  );
  const query = new URLSearchParams();
  if (after) query.set("after", after);
  if (search) query.set("search", search);
  const { data, error, refresh } = useCommunityResource<
    CommunitySpaces | CommunityFeed | CommunityThread
  >(api + suffix + (query.size ? `?${query}` : ""), true);

  function changePage(nextCursors: string[]) {
    setCursors(nextCursors);
    heading.current?.focus();
  }

  async function mutate<T>(
    path: string,
    method: "POST" | "PUT" | "PATCH" | "DELETE",
    body: object,
    onSaved?: (result: T) => void,
  ) {
    setNotice("");
    try {
      const result = await communityFetch<T>(api + path, { method, body });
      onSaved?.(result);
      setNotice(path.endsWith("/reports") ? "Report sent." : "Changes saved.");
      refresh();
      return true;
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Changes could not be saved.",
      );
      if (
        !(error instanceof CommunityRequestError) ||
        error.code !== "participation_suspended"
      )
        refresh();
      return false;
    }
  }

  return (
    <div className="space-y-6">
      <nav
        aria-label="Community navigation"
        className="flex flex-wrap gap-x-5 gap-y-2 border-b border-lh-line pb-4"
      >
        {academyEnabled && (
          <Link className={linkClass} href="/academy">
            My academy
          </Link>
        )}
        {returnTo !== "/community" && (
          <Link className={linkClass} href="/community">
            Community
          </Link>
        )}
        <CommunityNotificationsLink />
        {data && "space" in data && (
          <Link
            className={linkClass}
            href={communityMembersHref(data.space.courseId)}
          >
            Members
          </Link>
        )}
        {academyEnabled && courseId && (
          <Link className={linkClass} href={`/academy/courses/${courseId}`}>
            Course outline
          </Link>
        )}
        {data && "post" in data && (
          <Link className={linkClass} href={communityHref(data.space.courseId)}>
            Back to discussions
          </Link>
        )}
      </nav>
      <h1
        ref={heading}
        tabIndex={-1}
        className="break-words font-heading text-4xl sm:text-5xl"
      >
        {data && "space" in data ? data.space.title : "Community"}
      </h1>
      {error ? (
        <div className="space-y-3" role="alert">
          <p>{error.message}</p>
          {error.status === 401 ? (
            <Link href={customerSignInHref(returnTo)} className={linkClass}>
              Sign in
            </Link>
          ) : (
            <Button type="button" variant="outline" onClick={refresh}>
              Check access again
            </Button>
          )}
        </div>
      ) : !data ? (
        <p role="status">Loading Community…</p>
      ) : (
        <>
          <p role="status" aria-live="polite">
            {notice}
          </p>
          {"spaces" in data && (
            <>
              <DisplayNameForm
                writes={writes}
                save={(displayName) =>
                  mutate("/profile", "PUT", { displayName })
                }
              />
              {data.spaces.length ? (
                <ul className="space-y-3">
                  {data.spaces.map((space) => (
                    <li key={space.courseId} className={panelClass}>
                      <Link
                        prefetch={false}
                        className={linkClass}
                        href={communityHref(space.courseId)}
                      >
                        {space.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No course spaces are available.</p>
              )}
            </>
          )}
          {"posts" in data && (
            <>
              {writes && (
                <div className="space-y-3">
                  <TextForm
                    label="New discussion"
                    button="Post discussion"
                    max={4000}
                    onSubmit={(body) => {
                      setPostedId(undefined);
                      return mutate<CreatedDiscussion>(
                        suffix,
                        "POST",
                        { body },
                        ({ id }) => setPostedId(id),
                      );
                    }}
                  />
                  {postedId && (
                    <Link className={linkClass} href={discussionHref(postedId)}>
                      Open posted discussion
                    </Link>
                  )}
                </div>
              )}
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  setCursors([]);
                  setSearch(
                    String(
                      new FormData(event.currentTarget).get("search") ?? "",
                    ).trim(),
                  );
                }}
              >
                <label className="min-w-0 flex-1 basis-56">
                  <span className="block">Search discussions</span>
                  <input
                    className={inputClass}
                    maxLength={100}
                    name="search"
                    type="search"
                  />
                </label>
                <Button type="submit" variant="outline">
                  Search
                </Button>
              </form>
              {data.posts.length ? (
                data.posts.map((post) => (
                  <DiscussionMessage
                    key={post.id}
                    message={post}
                    inFeed
                    writes={writes}
                    mutate={mutate}
                  />
                ))
              ) : (
                <p>No discussions found.</p>
              )}
            </>
          )}
          {"post" in data && (
            <>
              <DiscussionMessage
                key={data.post.id}
                message={data.post}
                writes={writes}
                mutate={mutate}
              />
              {mediaEnabled && (
                <DiscussionMedia
                  key={`media:${data.post.id}`}
                  postId={data.post.id}
                  own={data.post.mine}
                  writes={writes}
                  locked={data.post.locked}
                />
              )}
              <h2 className="font-heading text-2xl">Replies</h2>
              {!data.comments.length && <p>No replies yet.</p>}
              {data.comments.map((comment) => (
                <DiscussionMessage
                  key={comment.id}
                  message={comment}
                  writes={writes}
                  mutate={mutate}
                />
              ))}
              {writes && !data.post.locked && (
                <TextForm
                  label="Reply"
                  button="Post reply"
                  max={4000}
                  onSubmit={async (body) => {
                    if (pendingReply.current?.body !== body)
                      pendingReply.current = {
                        body,
                        replyId: crypto.randomUUID(),
                      };
                    const saved = await mutate(
                      `${suffix}/comments`,
                      "POST",
                      pendingReply.current,
                    );
                    if (saved) pendingReply.current = undefined;
                    return saved;
                  }}
                />
              )}
            </>
          )}
          {(after || data.next) && (
            <nav
              aria-label={postId ? "Reply pages" : "Discussion pages"}
              className="flex flex-wrap gap-3"
            >
              {after && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => changePage([])}
                >
                  First page
                </Button>
              )}
              {cursors.length > 1 && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => changePage(cursors.slice(0, -1))}
                >
                  Previous page
                </Button>
              )}
              {data.next && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    if (data.next) changePage([...cursors, data.next]);
                  }}
                >
                  Next page
                </Button>
              )}
            </nav>
          )}
        </>
      )}
    </div>
  );
}
