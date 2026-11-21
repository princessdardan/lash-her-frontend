import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  getReviewNotifications, notificationSettings, reviewNotificationActor, reviewNotificationsPath,
} from "@/lib/staging-review/notifications";
import { reviewPath } from "@/lib/staging-review/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Staging reply notifications", robots: { index: false, follow: false } };

export default async function ReviewNotificationsPage({ searchParams }: {
  searchParams: Promise<{ reply?: string }>;
}) {
  const scope = notificationSettings();
  if (!scope) notFound();
  const actor = await reviewNotificationActor(scope);
  if (!actor) redirect(reviewPath);
  const [notices, { reply }] = await Promise.all([
    getReviewNotifications(scope, actor),
    searchParams,
  ]);
  const unread = notices.filter(notice => !notice.read).length;
  return (
    <main className="mx-auto grid max-w-3xl gap-6 px-6 py-12">
      <Link href={reviewPath} className="underline">Back to staging review</Link>
      <h1 className="text-3xl">Staging reply notifications</h1>
      <p>{actor.role === "recipient" ? "Test learner" : "Temporary learner"}</p>
      <p>{unread} unread {unread === 1 ? "notification" : "notifications"} for the test discussion.</p>
      {actor.role === "replier" && (
        <form action={`${reviewNotificationsPath}/reply`} method="post" className="grid gap-4">
          {reply === "sent" && <p role="status">Synthetic reply accepted.</p>}
          <button className="justify-self-start rounded border px-4 py-2">Send synthetic reply</button>
        </form>
      )}
      {notices.map(notice => (
        <article key={notice.id} className="grid gap-3 rounded border p-4">
          <h2 className="text-xl">New reply in the test discussion</h2>
          <p>{notice.read ? "Read" : "Unread"}</p>
          {actor.role === "recipient" && (
            <>
              <Link className="underline" href={`${reviewPath}/discussions/${scope.post}`}>Open discussion</Link>
              {!notice.read && (
                <form action={`${reviewNotificationsPath}/read`} method="post">
                  <button className="rounded border px-4 py-2">Mark as read</button>
                </form>
              )}
            </>
          )}
        </article>
      ))}
    </main>
  );
}
