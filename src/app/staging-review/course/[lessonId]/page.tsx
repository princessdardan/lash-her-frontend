import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { LessonExperience } from "@/components/learning/lesson-experience";
import { IntegrationServiceError } from "@/lib/api-integration/service-errors";
import { reviewCourseSettings, reviewLessonRequest } from "@/lib/staging-review/course";
import type { LessonQuizState } from "@/lib/learning/types";
import { getReviewSubject, reviewPath } from "@/lib/staging-review/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Staging lesson", robots: { index: false, follow: false } };

export default async function ReviewLesson({ params }: { params: Promise<{ lessonId: string }> }) {
  const { lessonId } = await params;
  const config = reviewCourseSettings(lessonId);
  if (!config) notFound();
  const subject = await getReviewSubject();
  if (!subject) redirect(reviewPath);

  let result;
  try {
    const [lesson, progress, quizState] = await Promise.all([
      reviewLessonRequest(config, subject, lessonId, "/v1/student/lessons/{lessonId}", "get"),
      reviewLessonRequest(config, subject, lessonId, "/v1/student/progress", "get"),
      Promise.all([
        reviewLessonRequest(config, subject, lessonId, "/v1/student/lessons/{lessonId}/quiz", "get"),
        reviewLessonRequest(config, subject, lessonId, "/v1/student/lessons/{lessonId}/quiz/attempts", "get"),
      ]).then<LessonQuizState>(([quiz, history]) => ({ kind: "ready", quiz: quiz.quiz, attempts: history.attempts }))
        .catch<LessonQuizState>(() => ({ kind: "unavailable" })),
    ]);
    result = { lesson: lesson.lesson, progress: progress.progress.find((item) => item.lessonId === lessonId) ?? null, quizState };
  } catch (error) {
    if (error instanceof IntegrationServiceError && error.status < 500) notFound();
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <Link href={`${reviewPath}#course`} className="underline">Back to course</Link>
      {result ? (
        <>
          <h1 className="mt-4 text-3xl">{result.lesson.title}</h1>
          <LessonExperience lesson={result.lesson} initialProgress={result.progress} quizState={result.quizState} stagingReview />
        </>
      ) : <p role="status" className="mt-4">This lesson is temporarily unavailable. Reload to try again.</p>}
    </main>
  );
}
