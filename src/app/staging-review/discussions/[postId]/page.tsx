import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ReviewDiscussionForm } from "@/components/community/review-discussion-form";
import { IntegrationServiceError } from "@/lib/api-integration/service-errors";
import { getReviewDiscussion, reviewDiscussionSettings } from "@/lib/staging-review/discussions";
import { getReviewSubject, reviewPath } from "@/lib/staging-review/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Staging discussion", robots: { index: false, follow: false } };

export default async function DiscussionPage({ params }: { params: Promise<{ postId: string }> }) {
  const settings = reviewDiscussionSettings();
  if (!settings) notFound();
  const subject = await getReviewSubject();
  if (!subject) redirect(reviewPath);
  const { postId } = await params;
  let discussion;
  try {
    discussion = await getReviewDiscussion(settings, subject, postId);
  } catch (error) {
    if (error instanceof IntegrationServiceError && error.status < 500) notFound();
  }

  return (
    <main className="mx-auto grid max-w-4xl gap-6 px-6 py-12">
      <Link className="underline" href={`${reviewPath}#community`}>Back to Community</Link>
      {discussion ? (
        <>
          <h1 className="text-3xl">Discussion</h1>
          <article className="rounded border p-4">
            <p className="font-semibold">{discussion.post.author}</p>
            <p className="whitespace-pre-wrap">{discussion.post.body}</p>
          </article>
          <section className="grid gap-4" aria-labelledby="discussion-replies">
            <h2 id="discussion-replies" className="text-xl">Replies</h2>
            {discussion.comments.length ? (
              <ul className="grid gap-3">
                {discussion.comments.map((comment) => (
                  <li className="rounded border p-4" key={comment.id}>
                    <p className="font-semibold">{comment.author}</p>
                    <p className="whitespace-pre-wrap">{comment.body}</p>
                  </li>
                ))}
              </ul>
            ) : <p>No replies yet.</p>}
            {discussion.post.locked ? <p>This discussion is locked.</p> : <ReviewDiscussionForm postId={postId} />}
          </section>
        </>
      ) : <p role="status">This discussion is temporarily unavailable. Reload to try again.</p>}
    </main>
  );
}
