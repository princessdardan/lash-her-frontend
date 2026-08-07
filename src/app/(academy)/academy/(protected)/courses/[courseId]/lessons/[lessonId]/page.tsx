import Link from "next/link";

import {
  AcademyState,
  academyStateForError,
} from "@/components/academy/academy-state";
import { PlaybackBoundary } from "@/components/academy/playback-boundary";
import { getAcademyConfig } from "@/lib/academy/config";
import { getAcademyCourseApi } from "@/lib/academy/course-api-adapter";
import { requireAcademyPagePrincipal } from "@/lib/academy/page-auth";
import {
  academyCourseUrl,
  academyLessonUrl,
  academyPlaybackApiUrl,
} from "@/lib/academy/urls";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function AcademyLessonPage({
  params,
}: {
  params: Promise<{ courseId: string; lessonId: string }>;
}) {
  const { courseId, lessonId } = await params;
  const principal = await requireAcademyPagePrincipal(
    academyLessonUrl(courseId, lessonId),
  );
  if (!getAcademyConfig().enabled) return <AcademyState kind="disabled" />;

  let lesson;
  try {
    lesson = await getAcademyCourseApi().getLesson({
      courseId,
      lessonId,
      userId: principal.userId,
    });
  } catch (error) {
    return <AcademyState kind={academyStateForError(error)} />;
  }

  return (
    <article>
      <Link
        className="text-sm font-semibold text-lh-primary underline-offset-4 hover:underline"
        href={academyCourseUrl(courseId)}
      >
        Back to course
      </Link>
      <header className="mt-7 max-w-3xl">
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-primary">
          Lesson
        </p>
        <h1 className="mt-3 font-heading text-5xl uppercase leading-none tracking-[0.07em] sm:text-6xl">
          {lesson.title}
        </h1>
      </header>
      <div className="mt-9 grid gap-8">
        <PlaybackBoundary
          endpoint={academyPlaybackApiUrl(courseId, lessonId)}
        />
        {lesson.writtenContent ? (
          <section className="rounded-3xl border border-lh-line bg-white p-7 sm:p-10">
            <h2 className="font-heading text-3xl uppercase tracking-[0.07em]">
              Lesson notes
            </h2>
            <p className="mt-5 whitespace-pre-wrap leading-8 text-lh-shadow">
              {lesson.writtenContent}
            </p>
          </section>
        ) : null}
      </div>
    </article>
  );
}
