import {
  notificationSettings,
  reviewNotificationsPath,
} from "@/lib/staging-review/notifications";
import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  ReviewCourseProgress,
  reviewLessonHref,
  reviewOutlineHref,
} from "@/components/learning/review-portal";
import { formatPosition } from "@/lib/learning/presentation";
import {
  readReviewEnrollment,
  reviewCourseSettings,
} from "@/lib/staging-review/course";
import { ReviewProfileForm } from "@/components/community/review-profile-form";
import { ReviewDiscussionForm } from "@/components/community/review-discussion-form";
import type { CommunityFeed, CommunitySpaces } from "@/lib/community/client";
import {
  getReviewProfile,
  isReviewDiscussionCursor,
  reviewDiscussionSettings,
} from "@/lib/staging-review/discussions";
import { DiscussionMedia } from "@/components/community/discussion-media";
import { mintApplicationToken } from "@/lib/api-integration/application-jwt";
import { getGatewayTransport } from "@/lib/api-integration/gateway-transport";
import {
  getReviewSubject,
  reviewCourse,
  reviewPath,
  reviewSettings,
} from "@/lib/staging-review/session";

export const metadata: Metadata = {
  title: "Staging review",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

async function read<T>(path: string, customerId: string): Promise<T | null> {
  try {
    const response = await getGatewayTransport()({
      method: "GET",
      service: "community",
      path,
      applicationToken: mintApplicationToken({
        profile: "community-member",
        customerId,
      }),
    });
    if (!response.ok) {
      console.warn(
        "Staging Community review upstream refused",
        response.status,
        response.headers.get("x-request-id"),
      );
      return null;
    }
    return (await response.json()) as T;
  } catch {
    console.warn("Staging Community review upstream unavailable");
    return null;
  }
}

export default async function StagingReview({
  searchParams,
}: {
  searchParams: Promise<{ signIn?: string; after?: string | string[] }>;
}) {
  if (!reviewSettings()) notFound();
  const subject = await getReviewSubject();
  if (!subject) {
    const failed = (await searchParams).signIn === "failed";
    return (
      <main className="mx-auto max-w-md px-6 py-16">
        <h1 className="mb-5 text-3xl">Staging review</h1>
        {failed && (
          <p role="alert" className="mb-4">
            The account or password was incorrect.
          </p>
        )}
        <form
          action={`${reviewPath}/login`}
          method="post"
          className="grid gap-4"
        >
          <label className="grid gap-1">
            Test account
            <input
              name="account"
              type="email"
              autoComplete="username"
              required
              className="rounded border p-2"
            />
          </label>
          <label className="grid gap-1">
            Password
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="rounded border p-2"
            />
          </label>
          <button className="rounded border px-4 py-2">Sign in</button>
        </form>
      </main>
    );
  }
  const { after } = await searchParams;
  if (
    after !== undefined &&
    (typeof after !== "string" || !isReviewDiscussionCursor(after))
  )
    notFound();
  const discussionSettings = reviewDiscussionSettings();
  const [course, list, feed, profile] = await Promise.all([
    readReviewEnrollment(subject).catch(() => undefined),
    read<CommunitySpaces>("/v1/spaces", subject),
    read<CommunityFeed>(
      `/v1/spaces/${reviewCourse}/posts${after ? `?after=${after}` : ""}`,
      subject,
    ),
    discussionSettings
      ? getReviewProfile(discussionSettings, subject).catch(() => null)
      : null,
  ]);
  const discussionsEnabled = Boolean(discussionSettings);
  const space = list?.spaces.find((entry) => entry.courseId === reviewCourse);
  const progress = course?.progress;
  const resumeId = progress?.continueLessonId;
  const savedPosition = progress?.continuePositionSeconds ?? 0;
  const resumeAction = progress?.lastActivityAt
    ? "Continue learning"
    : "Start course";
  return (
    <main className="mx-auto grid max-w-5xl gap-9 px-6 py-10 text-lh-shadow sm:px-8 sm:py-12">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-lh-line pb-6">
        <div>
          <h1 className="font-heading text-5xl sm:text-6xl">My Academy</h1>
          <p className="mt-1 text-sm text-lh-muted">Protected test account</p>
        </div>
        <form action={`${reviewPath}/logout`} method="post">
          <Button type="submit" variant="outline" className="min-h-11">
            Sign out
          </Button>
        </form>
      </header>
      <nav
        aria-label="Academy sections"
        className="flex flex-wrap gap-x-6 gap-y-2 underline underline-offset-4"
      >
        <a className="inline-flex min-h-11 items-center" href="#course">
          Courses
        </a>
        <a className="inline-flex min-h-11 items-center" href="#community">
          Community
        </a>
        {notificationSettings() && (
          <Link
            className="inline-flex min-h-11 items-center"
            href={reviewNotificationsPath}
          >
            Reply notifications
          </Link>
        )}
      </nav>
      <section
        id="course"
        aria-labelledby="review-courses"
        className="grid gap-4"
      >
        <h2 id="review-courses" className="font-heading text-3xl">
          Your courses
        </h2>
        {course && progress ? (
          <article className="editorial-card max-w-xl gap-5">
            <h3 className="font-heading text-3xl">
              <Link
                className="underline-offset-4 hover:underline"
                href={reviewOutlineHref}
              >
                {course.title}
              </Link>
            </h3>
            <ReviewCourseProgress
              title={course.title}
              total={progress.totalLessons}
              completed={progress.completedLessons}
              percent={progress.percentComplete}
            />
            <div className="flex flex-wrap items-center gap-3">
              {resumeId && reviewCourseSettings(resumeId) && (
                <Button asChild className="min-h-11">
                  <Link href={reviewLessonHref(resumeId)} prefetch={false}>
                    {resumeAction} <ArrowRight aria-hidden="true" />
                  </Link>
                </Button>
              )}
              <Button asChild variant="outline" className="min-h-11">
                <Link href={reviewOutlineHref}>Course outline</Link>
              </Button>
              {savedPosition > 0 &&
                resumeId &&
                reviewCourseSettings(resumeId) && (
                  <p className="text-sm tabular-nums text-lh-muted">
                    Saved at {formatPosition(savedPosition)}
                  </p>
                )}
            </div>
          </article>
        ) : course === null ? (
          <p role="status">No courses are available for this account.</p>
        ) : (
          <div className="space-y-3">
            <p role="alert">Course is temporarily unavailable.</p>
            <Link href={reviewPath} className="underline underline-offset-4">
              Try again
            </Link>
          </div>
        )}
      </section>
      <section
        id="community"
        aria-labelledby="review-community"
        className="grid gap-4 border-t border-lh-line pt-7"
      >
        <h2 id="review-community" className="font-heading text-3xl">
          Community
        </h2>
        {after && (
          <Link className="underline" href={`${reviewPath}#community`}>
            Newest discussions
          </Link>
        )}
        {feed && space && feed.space.courseId === reviewCourse ? (
          <>
            <h3 className="font-heading text-2xl">{space.title}</h3>
            {profile && (
              <ReviewProfileForm
                key={profile.profile?.displayName}
                currentName={profile.profile?.displayName ?? ""}
              />
            )}
            {discussionsEnabled && <ReviewDiscussionForm />}
            {feed.posts.length ? (
              feed.posts.map((post) => (
                <article
                  key={post.id}
                  className="space-y-2 rounded-2xl border border-lh-line bg-lh-white p-4 sm:p-5"
                >
                  <p className="font-semibold">{post.author}</p>
                  <p className="whitespace-pre-wrap break-words">{post.body}</p>
                  {discussionsEnabled && post.mine && (
                    <Link
                      className="mt-2 inline-block underline"
                      href={`${reviewPath}/discussions/${post.id}`}
                    >
                      Open discussion
                    </Link>
                  )}
                  {post.id === process.env.STAGING_REVIEW_MEDIA_POST &&
                    process.env.STAGING_REVIEW_MEDIA_KEY && (
                      <div className="mt-4">
                        <p className="mb-3 text-sm">
                          Use synthetic images for this staging test.
                        </p>
                        <DiscussionMedia
                          postId={post.id}
                          own
                          writes
                          locked={false}
                          apiBase="/staging-review/community"
                        />
                      </div>
                    )}
                </article>
              ))
            ) : (
              <p>{after ? "No older discussions." : "No discussions yet."}</p>
            )}
            {isReviewDiscussionCursor(feed.next) && (
              <Link
                className="underline"
                href={`${reviewPath}?after=${feed.next}#community`}
              >
                Older discussions
              </Link>
            )}
          </>
        ) : (
          <p role="status">
            {after
              ? "This page of discussions could not be loaded."
              : "Community is temporarily unavailable."}
          </p>
        )}
      </section>
    </main>
  );
}
