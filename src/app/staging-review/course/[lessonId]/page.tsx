import { notFound, redirect } from "next/navigation";
import { LessonExperience } from "@/components/learning/lesson-experience";
import {
  ReviewLessonNavigation,
  ReviewNavigation,
} from "@/components/learning/review-portal";
import { IntegrationServiceError } from "@/lib/api-integration/service-errors";
import {
  readReviewOutline,
  reviewCourseSettings,
  reviewLessonRequest,
} from "@/lib/staging-review/course";
import type { LessonQuizState } from "@/lib/learning/types";
import { getReviewSubject, reviewPath } from "@/lib/staging-review/session";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Staging lesson",
  robots: { index: false, follow: false },
};

export default async function ReviewLesson({
  params,
}: {
  params: Promise<{ lessonId: string }>;
}) {
  const { lessonId } = await params;
  const config = reviewCourseSettings(lessonId);
  if (!config) notFound();
  const subject = await getReviewSubject();
  if (!subject) redirect(reviewPath);

  let result;
  try {
    const [course, lesson, progress, quizState] = await Promise.all([
      readReviewOutline(subject),
      reviewLessonRequest(
        config,
        subject,
        lessonId,
        "/v1/student/lessons/{lessonId}",
        "get",
      ),
      reviewLessonRequest(
        config,
        subject,
        lessonId,
        "/v1/student/progress",
        "get",
      ),
      Promise.all([
        reviewLessonRequest(
          config,
          subject,
          lessonId,
          "/v1/student/lessons/{lessonId}/quiz",
          "get",
        ),
        reviewLessonRequest(
          config,
          subject,
          lessonId,
          "/v1/student/lessons/{lessonId}/quiz/attempts",
          "get",
        ),
      ])
        .then<LessonQuizState>(([quiz, history]) => ({
          kind: "ready",
          quiz: quiz.quiz,
          attempts: history.attempts,
        }))
        .catch<LessonQuizState>(() => ({ kind: "unavailable" })),
    ]);
    const outline = course.modules.flatMap((module) => module.lessons);
    const index = outline.findIndex(({ id }) => id === lessonId);
    if (index === -1 || lesson.lesson.id !== lessonId)
      throw new IntegrationServiceError("not_found", 404);
    result = {
      courseTitle: course.title,
      lesson: lesson.lesson,
      progress:
        progress.progress.find((item) => item.lessonId === lessonId) ?? null,
      quizState,
      previous: outline[index - 1],
      next: outline[index + 1],
    };
  } catch (error) {
    if (error instanceof IntegrationServiceError && error.status < 500)
      notFound();
  }

  return (
    <main className="mx-auto max-w-4xl space-y-5 px-6 py-10 text-lh-shadow sm:px-8">
      <ReviewNavigation lesson />
      {result ? (
        <>
          <header className="space-y-2">
            <p className="text-sm font-semibold text-lh-muted">
              {result.courseTitle}
            </p>
            <h1 className="break-words font-heading text-4xl sm:text-5xl">
              {result.lesson.title}
            </h1>
          </header>
          <LessonExperience
            lesson={result.lesson}
            initialProgress={result.progress}
            quizState={result.quizState}
            stagingReview
          />
          <ReviewLessonNavigation
            previous={result.previous}
            next={result.next}
          />
        </>
      ) : (
        <p role="status" className="mt-4">
          This lesson is temporarily unavailable. Reload to try again.
        </p>
      )}
    </main>
  );
}
