import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  getReviewNotifications,
  notificationSettings,
  reviewNotificationActor,
  reviewNotificationsPath,
} from "@/lib/staging-review/notifications";
import { reviewPath } from "@/lib/staging-review/session";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Staging reply notifications",
  robots: { index: false, follow: false },
};

export default async function ReviewNotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ reply?: string }>;
}) {
  const scope = notificationSettings();
  if (!scope) notFound();
  const actor = await reviewNotificationActor(scope);
  if (!actor) redirect(reviewPath);
  const [inbox, { reply }] = await Promise.all([
    getReviewNotifications(scope, actor).catch(() => null),
    searchParams,
  ]);
  const notices = inbox ?? [];
  const unread = notices.filter((notice) => !notice.read).length;
  return (
    <main className="mx-auto grid max-w-3xl gap-6 px-6 py-12">
      <Link
        href={`${reviewPath}#community`}
        className="inline-flex min-h-11 items-center justify-self-start underline underline-offset-4"
      >
        Back to Community
      </Link>
      <h1 className="font-heading text-4xl">Reply notifications</h1>
      {inbox ? (
        <p>
          {unread} unread {unread === 1 ? "notification" : "notifications"}
        </p>
      ) : (
        <p role="alert">
          Reply notifications are temporarily unavailable. Reload to try again.
        </p>
      )}
      {inbox && actor.role === "replier" && (
        <form
          action={`${reviewNotificationsPath}/reply`}
          method="post"
          className="grid gap-4"
        >
          {reply === "sent" && <p role="status">Synthetic reply accepted.</p>}
          <button className="justify-self-start rounded border px-4 py-2">
            Send synthetic reply
          </button>
        </form>
      )}
      {inbox?.length === 0 && <p>No reply notifications yet.</p>}
      {notices.map((notice) => (
        <article key={notice.id} className="grid gap-3 rounded border p-4">
          <h2 className="text-xl">New reply in the test discussion</h2>
          <p>{notice.read ? "Read" : "Unread"}</p>
          {actor.role === "recipient" && (
            <>
              <Link
                className="underline"
                href={`${reviewPath}/discussions/${scope.post}`}
              >
                Open discussion
              </Link>
              {!notice.read && (
                <form action={`${reviewNotificationsPath}/read`} method="post">
                  <button className="rounded border px-4 py-2">
                    Mark as read
                  </button>
                </form>
              )}
            </>
          )}
        </article>
      ))}
    </main>
  );
}
