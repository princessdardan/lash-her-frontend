import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  ReviewCourseProgress,
  ReviewNavigation,
  reviewLessonHref,
  reviewOutlineHref,
} from "@/components/learning/review-portal";
import { IntegrationServiceError } from "@/lib/api-integration/service-errors";
import { readLearningPage } from "@/lib/learning/page-result";
import {
  readReviewOutline,
  reviewCourseSettings,
  reviewLessonRequest,
} from "@/lib/staging-review/course";
import {
  getReviewSubject,
  reviewPath,
  reviewSettings,
} from "@/lib/staging-review/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Course outline | LASH HER",
  robots: { index: false, follow: false },
};

export default async function ReviewCourseOutline() {
  if (!reviewSettings()) notFound();
  const subject = await getReviewSubject();
  if (!subject) redirect(reviewPath);

  const view = await readLearningPage(async () => {
    const course = await readReviewOutline(subject);
    const lessons = course.modules.flatMap((module) => module.lessons);
    const entries = new Map(
      await Promise.all(
        lessons.map(async ({ id }) => {
          const scope = reviewCourseSettings(id);
          if (!scope) throw new IntegrationServiceError("not_found", 404);
          const { progress } = await reviewLessonRequest(
            scope,
            subject,
            id,
            "/v1/student/progress",
            "get",
          );
          return [id, progress.find((row) => row.lessonId === id)] as const;
        }),
      ),
    );
    return { course, lessons, entries };
  });
  if (view.error) {
    const denied = view.error.status < 500 && view.error.status !== 429;
    return (
      <main className="mx-auto max-w-5xl space-y-5 px-6 py-10 sm:px-8">
        <ReviewNavigation />
        <h1 className="font-heading text-4xl">Course outline</h1>
        <p role="alert">
          {denied
            ? "Course access is unavailable for this account."
            : "Course progress is temporarily unavailable."}
        </p>
        {!denied && (
          <Link
            className="underline underline-offset-4"
            href={reviewOutlineHref}
          >
            Try again
          </Link>
        )}
      </main>
    );
  }
  const { course, lessons, entries } = view.data;
  const completed = lessons.filter(
    ({ id }) => entries.get(id)?.completedAt,
  ).length;
  const next = lessons.find(({ id }) => !entries.get(id)?.completedAt);
  const activity = [...entries.values()].some(
    (progress) => progress?.lastWatchedAt || progress?.completedAt,
  );
  return (
    <main className="mx-auto max-w-5xl space-y-6 px-6 py-10 text-lh-shadow sm:px-8">
      <ReviewNavigation />
      <header className="space-y-5 rounded-3xl border border-lh-line bg-lh-neutral-2 p-6 sm:p-8">
        <h1 className="font-heading text-4xl sm:text-5xl">{course.title}</h1>
        <ReviewCourseProgress
          title={course.title}
          total={lessons.length}
          completed={completed}
          percent={
            lessons.length ? Math.floor((completed * 100) / lessons.length) : 0
          }
        />
        {next && (
          <Button asChild className="min-h-11">
            <Link href={reviewLessonHref(next.id)} prefetch={false}>
              {activity ? "Continue learning" : "Start course"}
            </Link>
          </Button>
        )}
      </header>
      <ol className="space-y-4">
        {course.modules.map((module) => (
          <li
            key={module.id}
            className="rounded-2xl border border-lh-line px-5 py-4 sm:px-6"
          >
            <h2 className="font-heading text-3xl">{module.title}</h2>
            <ol className="mt-2 divide-y divide-lh-line">
              {module.lessons.map((lesson) => {
                const progress = entries.get(lesson.id);
                return (
                  <li
                    key={lesson.id}
                    className="flex flex-col items-start gap-x-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <Link
                      className="flex min-h-11 min-w-0 items-center break-words underline underline-offset-4"
                      href={reviewLessonHref(lesson.id)}
                      prefetch={false}
                    >
                      {lesson.title}
                    </Link>
                    <span className="pb-2 text-sm text-lh-muted sm:pb-0">
                      {progress?.completedAt
                        ? "Complete"
                        : progress?.lastWatchedAt
                          ? "In progress"
                          : "Not started"}
                    </span>
                  </li>
                );
              })}
            </ol>
          </li>
        ))}
      </ol>
    </main>
  );
}
