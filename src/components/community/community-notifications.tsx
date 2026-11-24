"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import type { paths } from "@/lib/api-integration/generated/community-discussions";
import { communityFetch, discussionHref } from "@/lib/community/client";
import { customerSignInHref } from "@/lib/learning/presentation";
import { useCommunityResource } from "./use-community-resource";

const notificationsHref = "/community/notifications";
const inboxPath = "/api/community/notifications";
const preferencesPath = inboxPath + "/preferences";
const linkClass = "underline underline-offset-4";
type Inbox =
  paths["/v1/notifications"]["get"]["responses"][200]["content"]["application/json"];
type Preferences =
  paths["/v1/notifications/preferences"]["get"]["responses"][200]["content"]["application/json"];
type Unread =
  paths["/v1/notifications/unread"]["get"]["responses"][200]["content"]["application/json"];
type Entry = Inbox["notifications"][number];
type ModerationAction = Extract<Entry, { kind: "moderation" }>["action"];

const moderationMessages: Record<ModerationAction, string> = {
  hide: "A moderator hid your message.",
  restore: "A moderator restored your message.",
  lock: "A moderator locked your discussion.",
  unlock: "A moderator unlocked your discussion.",
  pin: "A moderator pinned your discussion.",
  unpin: "A moderator unpinned your discussion.",
  suspend: "A moderator suspended your participation in this course space.",
  unsuspend: "A moderator restored your participation in this course space.",
  resolve: "A moderator resolved your report.",
};

export function CommunityNotificationsLink() {
  const { data } = useCommunityResource<Unread>(inboxPath + "/unread", true);
  return (
    <Link className={linkClass} href={notificationsHref}>
      Notifications{data?.unreadCount ? ` (${data.unreadCount})` : ""}
    </Link>
  );
}

function PreferenceForm({
  settings,
  writes,
  save,
}: {
  settings: Preferences;
  writes: boolean;
  save: (settings: Preferences) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    setBusy(true);
    try {
      await save({
        replies: fields.has("replies"),
        moderation: fields.has("moderation"),
      });
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit}>
      <fieldset disabled={!writes || busy} className="space-y-3">
        <legend className="font-heading text-xl">
          Notification preferences
        </legend>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="replies"
            defaultChecked={settings.replies}
          />
          Replies to my discussions
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="moderation"
            defaultChecked={settings.moderation}
          />
          Moderation updates
        </label>
        {writes && (
          <Button type="submit" size="sm">
            Save preferences
          </Button>
        )}
      </fieldset>
    </form>
  );
}

export function CommunityNotifications({ writes }: { writes: boolean }) {
  const [cursor, setCursor] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<{ text: string; failed?: boolean }>();
  const inbox = useCommunityResource<Inbox>(
    inboxPath + (cursor ? `?after=${encodeURIComponent(cursor)}` : ""),
    true,
  );
  const prefs = useCommunityResource<Preferences>(preferencesPath);
  const data = inbox.data;

  async function update(
    path: string,
    body: object,
    saved: string,
    refresh: () => void,
  ) {
    setNotice(undefined);
    try {
      await communityFetch(path, { method: "PUT", body });
      setNotice({ text: saved });
      return true;
    } catch (error) {
      setNotice({
        text:
          error instanceof Error
            ? error.message
            : "Changes could not be saved.",
        failed: true,
      });
      return false;
    } finally {
      refresh();
    }
  }

  async function markRead(entry: Entry) {
    setBusy(entry.id);
    try {
      await update(
        `${inboxPath}/${entry.id}/read`,
        { read: !entry.read },
        entry.read ? "Marked as unread." : "Marked as read.",
        inbox.refresh,
      );
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <section className="space-y-8">
      <nav aria-label="Community navigation">
        <Link className={linkClass} href="/community">
          Community
        </Link>
      </nav>
      <h1 className="font-heading text-4xl">Notifications</h1>
      {notice && <p role={notice.failed ? "alert" : "status"}>{notice.text}</p>}
      {prefs.error ? (
        <p role="alert">{prefs.error.message}</p>
      ) : (
        prefs.data && (
          <PreferenceForm
            key={JSON.stringify(prefs.data)}
            settings={prefs.data}
            writes={writes}
            save={(settings) =>
              update(
                preferencesPath,
                settings,
                "Preferences saved.",
                prefs.refresh,
              )
            }
          />
        )
      )}
      {inbox.error ? (
        <div className="space-y-3">
          <p role="alert">{inbox.error.message}</p>
          {inbox.error.status === 401 ? (
            <Link className={linkClass} href={customerSignInHref(notificationsHref)}>
              Sign in
            </Link>
          ) : (
            <Button type="button" variant="outline" onClick={inbox.refresh}>
              Try again
            </Button>
          )}
        </div>
      ) : data ? (
        <div className="space-y-4">
          <p aria-live="polite">{data.unreadCount} unread</p>
          {data.notifications.length ? (
            <ul className="space-y-3">
              {data.notifications.map((entry) => (
                <li key={entry.id} className="space-y-2 rounded-lg border p-4">
                  <p className="font-semibold">{entry.courseTitle}</p>
                  <p>
                    {entry.kind === "reply"
                      ? "Someone replied to your discussion."
                      : moderationMessages[entry.action]}
                  </p>
                  <p className="text-sm">
                    {entry.read ? "Read" : "Unread"} ·{" "}
                    <time dateTime={entry.createdAt}>
                      {new Date(entry.createdAt).toLocaleDateString("en-CA")}
                    </time>
                  </p>
                  <div className="flex flex-wrap items-center gap-3">
                    {entry.postId && (
                      <Link
                        className={linkClass}
                        prefetch={false}
                        href={discussionHref(entry.postId)}
                      >
                        Open discussion
                      </Link>
                    )}
                    {writes && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy !== undefined}
                        onClick={() => void markRead(entry)}
                      >
                        {entry.read ? "Mark as unread" : "Mark as read"}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p>No notifications.</p>
          )}
          <div className="flex flex-wrap gap-3">
            {cursor && (
              <Button
                type="button"
                variant="outline"
                onClick={() => setCursor(undefined)}
              >
                First page
              </Button>
            )}
            {data.next && (
              <Button
                type="button"
                variant="outline"
                onClick={() => setCursor(data.next ?? undefined)}
              >
                Next page
              </Button>
            )}
          </div>
        </div>
      ) : (
        <p role="status">Loading notifications…</p>
      )}
    </section>
  );
}
