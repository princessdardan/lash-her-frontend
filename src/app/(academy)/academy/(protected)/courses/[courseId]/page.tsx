import Link from "next/link";

import {
  AcademyState,
  academyStateForError,
} from "@/components/academy/academy-state";
import { getAcademyConfig } from "@/lib/academy/config";
import { getAcademyCourseApi } from "@/lib/academy/course-api-adapter";
import { requireAcademyPagePrincipal } from "@/lib/academy/page-auth";
import {
  academyCourseUrl,
  academyDashboardUrl,
  academyLessonUrl,
} from "@/lib/academy/urls";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function AcademyCoursePage({
  params,
}: {
  params: Promise<{ courseId: string }>;
}) {
  const { courseId } = await params;
  const principal = await requireAcademyPagePrincipal(
    academyCourseUrl(courseId),
  );
  if (!getAcademyConfig().enabled) return <AcademyState kind="disabled" />;

  let course;
  try {
    course = await getAcademyCourseApi().getCourse({
      courseId,
      userId: principal.userId,
    });
  } catch (error) {
    return <AcademyState kind={academyStateForError(error)} />;
  }

  return (
    <article>
      <Link
        className="text-sm font-semibold text-lh-primary underline-offset-4 hover:underline"
        href={academyDashboardUrl()}
      >
        Back to academy
      </Link>
      <header className="mt-7 max-w-3xl">
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-primary">
          Course
        </p>
        <h1 className="mt-3 font-heading text-5xl uppercase leading-none tracking-[0.07em] sm:text-6xl">
          {course.title}
        </h1>
        {course.description ? (
          <p className="mt-5 leading-7 text-lh-muted">{course.description}</p>
        ) : null}
      </header>
      {course.lessons.length === 0 ? (
        <div className="mt-9">
          <AcademyState kind="course-empty" />
        </div>
      ) : (
        <ol className="mt-9 grid gap-3">
          {course.lessons.map((lesson, index) => (
            <li key={lesson.id}>
              <Link
                className="flex items-center justify-between gap-4 rounded-2xl border border-lh-line bg-white p-5 transition hover:border-lh-primary/40"
                href={academyLessonUrl(course.id, lesson.id)}
              >
                <span>
                  <span className="mr-3 text-sm text-lh-muted">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="font-semibold">{lesson.title}</span>
                </span>
                <span className="text-sm text-lh-muted">
                  {lesson.completed ? "Complete" : "Open lesson"}
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}
