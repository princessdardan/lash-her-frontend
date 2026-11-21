import type { Metadata } from "next";
import Link from "next/link";
import { reviewCourseSettings } from "@/lib/staging-review/course";
import { notFound } from "next/navigation";
import { ReviewProfileForm } from "@/components/community/review-profile-form";
import { ReviewDiscussionForm } from "@/components/community/review-discussion-form";
import type { CommunityFeed, CommunitySpaces } from "@/lib/community/client";
import { getReviewProfile, reviewDiscussionSettings } from "@/lib/staging-review/discussions";
import { DiscussionMedia } from "@/components/community/discussion-media";
import { mintApplicationToken } from "@/lib/api-integration/application-jwt";
import { getGatewayTransport } from "@/lib/api-integration/gateway-transport";
import { getReviewSubject, reviewCourse, reviewPath, reviewSettings } from "@/lib/staging-review/session";

export const metadata: Metadata = { title: "Staging review", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

type Course = { course?: { title: string; modules?: { id: string; title: string; lessons?: { id: string; title: string }[] }[] } };

async function read<T>(service: "course" | "community", path: string, customerId: string): Promise<T | null> {
  try {
    const profile = service === "course" ? "course-learner" : "community-member";
    const response = await getGatewayTransport()({ method: "GET", service, path,
      applicationToken: mintApplicationToken({ profile, customerId }) });
    if (!response.ok) {
      console.warn("Staging review upstream refused", service, response.status, response.headers.get("x-request-id"));
      return null;
    }
    return await response.json() as T;
  } catch {
    console.warn("Staging review upstream unavailable", service);
    return null;
  }
}

export default async function StagingReview({ searchParams }: { searchParams: Promise<{ signIn?: string }> }) {
  if (!reviewSettings()) notFound();
  const subject = await getReviewSubject();
  if (!subject) {
    const failed = (await searchParams).signIn === "failed";
    return (
      <main className="mx-auto max-w-md px-6 py-16">
        <h1 className="mb-5 text-3xl">Staging review</h1>
        {failed && <p role="alert" className="mb-4">The account or password was incorrect.</p>}
        <form action={`${reviewPath}/login`} method="post" className="grid gap-4">
          <label className="grid gap-1">Test account<input name="account" type="email" autoComplete="username" required className="rounded border p-2" /></label>
          <label className="grid gap-1">Password<input name="password" type="password" autoComplete="current-password" required className="rounded border p-2" /></label>
          <button className="rounded border px-4 py-2">Sign in</button>
        </form>
      </main>
    );
  }
  const discussionSettings = reviewDiscussionSettings();
  const [course, list, feed, profile] = await Promise.all([
    read<Course>("course", `/v1/student/courses/${reviewCourse}`, subject),
    read<CommunitySpaces>("community", "/v1/spaces", subject),
    read<CommunityFeed>("community", `/v1/spaces/${reviewCourse}/posts`, subject),
    discussionSettings ? getReviewProfile(discussionSettings, subject).catch(() => null) : null,
  ]);
  const discussionsEnabled = Boolean(discussionSettings);
  const space = list?.spaces.find((entry) => entry.courseId === reviewCourse);
  return (
    <main className="mx-auto grid max-w-4xl gap-10 px-6 py-12">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl">Staging review</h1>
          <p>Protected test account</p>
        </div>
        <form action={`${reviewPath}/logout`} method="post"><button className="rounded border px-4 py-2">Sign out</button></form>
      </header>
      <nav aria-label="Staging sections" className="flex gap-5 underline"><a href="#course">Course</a><a href="#community">Community</a></nav>
      <section id="course" className="grid gap-3">
        <h2 className="text-2xl">Course</h2>
        {course?.course ? <>
          <h3 className="text-xl">{course.course.title}</h3>
          {course.course.modules?.map((module) => (
            <div key={module.id}>
              <h4 className="font-semibold">{module.title}</h4>
              <ul className="list-inside list-disc">{module.lessons?.map((lesson) => <li key={lesson.id}>
                {reviewCourseSettings(lesson.id)
                  ? <Link className="underline" href={`${reviewPath}/course/${lesson.id}`}>{lesson.title}</Link>
                  : lesson.title}
              </li>)}</ul>
            </div>
          ))}
        </> : <p role="status">Course is temporarily unavailable.</p>}
      </section>
      <section id="community" className="grid gap-3">
        <h2 className="text-2xl">Community</h2>
        {feed && space ? <>
          <h3 className="text-xl">{space.title}</h3>
          {profile && <ReviewProfileForm key={profile.profile?.displayName} currentName={profile.profile?.displayName ?? ""} />}
          {discussionsEnabled && <ReviewDiscussionForm />}
          {feed.posts.length ? feed.posts.map((post) => (
            <article key={post.id} className="rounded border p-4">
              <p className="font-semibold">{post.author}</p>
              <p className="whitespace-pre-wrap">{post.body}</p>
              {discussionsEnabled && post.mine && (
                <Link className="mt-2 inline-block underline" href={`${reviewPath}/discussions/${post.id}`}>Open discussion</Link>
              )}
              {post.id === process.env.STAGING_REVIEW_MEDIA_POST && process.env.STAGING_REVIEW_MEDIA_KEY && (
                <div className="mt-4">
                  <p className="mb-3 text-sm">Use synthetic images for this staging test.</p>
                  <DiscussionMedia postId={post.id} own writes locked={false} apiBase="/staging-review/community" />
                </div>
              )}
            </article>
          )) : <p>No discussions yet.</p>}
        </> : <p role="status">Community is temporarily unavailable.</p>}
      </section>
    </main>
  );
}
