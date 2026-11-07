import Link from "next/link";
import { readLearningPage } from "@/lib/learning/page-result";
import { notFound } from "next/navigation";
import { getCourseClient } from "@/lib/api-integration/course-client";
import { IntegrationServiceError } from "@/lib/api-integration/service-errors";
import { learningRoutesEnabled } from "@/lib/learning/rollout";
import {
  lessonHref,
  validCourseSlug,
  validLearningId,
} from "@/lib/learning/presentation";
import type {
  LearnerCourse,
  LessonQuizState,
  PublicCourse,
} from "@/lib/learning/types";
import {
  LearningFailure,
  LearningNavigation,
  LearningShell,
} from "@/components/learning/shared";
import { LessonExperience } from "@/components/learning/lesson-experience";
import { readInteractiveBrowserRequest } from "@/lib/writer-admission/interactive-proof";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "My lesson | LASH HER Academy",
  robots: { index: false, follow: false },
};
export default async function LessonPage({
  params,
  searchParams,
}: {
  params: Promise<{ courseId: string; lessonId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!learningRoutesEnabled()) notFound();
  const { courseId, lessonId } = await params;
  const query = await searchParams;
  if (
    !validLearningId(courseId) ||
    !validLearningId(lessonId) ||
    Object.keys(query).some((key) => key !== "course") ||
    (query.course !== undefined &&
      (typeof query.course !== "string" || !validCourseSlug(query.course)))
  )
    notFound();
  const path =
    lessonHref(courseId, lessonId) +
    (typeof query.course === "string" ? `?course=${query.course}` : "");
  const scope = await readInteractiveBrowserRequest();
  const prefetch = scope?.lessonEntry || scope?.lessonAssessment || scope?.lessonResume ? false : undefined;
  const result = await readLearningPage(async () => {
    const client = getCourseClient();
    const [
      courseResult,
      lessonResult,
      progressResult,
      quizResult,
      attemptsResult,
    ] = await Promise.allSettled([
      client.getMyCourse(courseId),
      client.getLesson(lessonId),
      client.listProgress({ lessonId }),
      client.getQuiz(lessonId),
      client.listQuizAttempts(lessonId),
    ]);
    let course: LearnerCourse | PublicCourse;
    let preview = false;
    if (courseResult.status === "fulfilled") course = courseResult.value.course;
    else if (
      courseResult.reason instanceof IntegrationServiceError &&
      ["access_required", "access_revoked"].includes(
        courseResult.reason.code,
      ) &&
      typeof query.course === "string"
    ) {
      const catalog = await client.getCatalogCourse(query.course);
      if (
        catalog.course.id !== courseId ||
        !catalog.course.modules.some((module) =>
          module.lessons.some(
            (lesson) => lesson.id === lessonId && lesson.isPreview,
          ),
        )
      )
        throw courseResult.reason;
      course = catalog.course;
      preview = true;
    } else throw courseResult.reason;
    if (lessonResult.status === "rejected") throw lessonResult.reason;
    const lesson = lessonResult.value.lesson;
    if (
      !course.modules.some(
        (module) =>
          module.id === lesson.moduleId &&
          module.lessons.some((row) => row.id === lessonId),
      )
    )
      throw new IntegrationServiceError("not_found", 404);
    if (progressResult.status === "rejected" && !preview)
      throw progressResult.reason;
    const progress =
      progressResult.status === "fulfilled"
        ? (progressResult.value.progress[0] ?? null)
        : null;
    const quizState: LessonQuizState =
      quizResult.status === "fulfilled" && attemptsResult.status === "fulfilled"
        ? {
            kind: "ready",
            quiz: quizResult.value.quiz,
            attempts: attemptsResult.value.attempts,
          }
        : quizResult.status === "rejected" &&
            quizResult.reason instanceof IntegrationServiceError &&
            quizResult.reason.code === "not_found"
          ? { kind: "none" }
          : { kind: "unavailable" };
    const lessons = course.modules.flatMap<{ id: string; title: string }>(
      (module) => module.lessons,
    );
    const index = lessons.findIndex((row) => row.id === lessonId);
    const next = lessons[index + 1],
      previous = lessons[index - 1];
    return {
      course,
      lesson,
      progress,
      quizState,
      lessons,
      index,
      next,
      previous,
      preview,
    };
  });
  if (result.error)
    return (
      <LearningShell>
        <LearningNavigation />
        <LearningFailure
          error={result.error}
          returnTo={path}
          retryHref={path}
        />
      </LearningShell>
    );
  const {
    course,
    lesson,
    progress,
    quizState,
    lessons,
    index,
    next,
    previous,
    preview,
  } = result.data;
  const href = (id: string) =>
    lessonHref(courseId, id) + (preview ? `?course=${course.slug}` : "");
  return (
    <LearningShell>
      <LearningNavigation />
      <Link
        href={
          preview ? `/courses/${course.slug}` : `/academy/courses/${courseId}`
        }
        prefetch={prefetch}
        className="text-sm underline underline-offset-4"
      >
        {course.title}
      </Link>
      <div className="mt-7 grid gap-10 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <article className="min-w-0">
          <p className="eyebrow-label text-lh-primary">
            Lesson {index + 1} of {lessons.length}
          </p>
          <h1 className="mt-4 font-heading text-4xl sm:text-5xl">
            {lesson.title}
          </h1>
          <LessonExperience
            key={`${lesson.id}:${progress?.revision ?? 0}:${progress?.completedAt ?? ""}:${quizState.kind === "ready" ? `${quizState.quiz.id}:${quizState.quiz.revision}` : quizState.kind}`}
            lesson={lesson}
            initialProgress={progress}
            quizState={quizState}
            preview={preview}
          />
          <nav
            aria-label="Lesson navigation"
            className="mt-10 flex flex-wrap justify-between gap-5 border-t border-lh-primary/20 pt-6 text-sm"
          >
            {previous ? (
              <Link
                href={href(previous.id)}
                prefetch={prefetch}
                className="underline underline-offset-4"
              >
                Previous: {previous.title}
              </Link>
            ) : (
              <span />
            )}
            {next ? (
              <Link
                href={href(next.id)}
                prefetch={prefetch}
                className="underline underline-offset-4"
              >
                Next: {next.title}
              </Link>
            ) : (
              <Link
                href={preview ? `/courses/${course.slug}` : "/academy"}
                prefetch={prefetch}
                className="underline underline-offset-4"
              >
                {preview ? "Return to course" : "Return to my academy"}
              </Link>
            )}
          </nav>
        </article>
        <aside
          aria-labelledby="lesson-outline-title"
          className="self-start border border-lh-primary/20 p-5 xl:sticky xl:top-36"
        >
          <h2 id="lesson-outline-title" className="font-heading text-2xl">
            Course lessons
          </h2>
          <nav aria-label="Course lessons">
            <ol className="mt-4 space-y-5">
              {course.modules.map((module) => (
                <li key={module.id}>
                  <h3 className="text-sm font-medium">{module.title}</h3>
                  <ol className="mt-2 space-y-1">
                    {module.lessons.map((row) => (
                      <li key={row.id}>
                        <Link
                          href={href(row.id)}
                          prefetch={prefetch}
                          aria-current={
                            row.id === lessonId ? "page" : undefined
                          }
                          className={`block min-h-11 px-3 py-3 text-sm ${row.id === lessonId ? "bg-lh-primary text-white" : "hover:bg-lh-primary/5"}`}
                        >
                          {row.title}
                        </Link>
                      </li>
                    ))}
                  </ol>
                </li>
              ))}
            </ol>
          </nav>
        </aside>
      </div>
    </LearningShell>
  );
}
