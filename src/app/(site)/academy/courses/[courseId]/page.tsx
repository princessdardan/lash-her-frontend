import Link from "next/link";
import { notFound } from "next/navigation";
import { getCourseClient } from "@/lib/api-integration/course-client";
import { readLearningPage } from "@/lib/learning/page-result";
import { learningRoutesEnabled } from "@/lib/learning/rollout";
import { lessonHref, validLearningId } from "@/lib/learning/presentation";
import { readInteractiveBrowserRequest } from "@/lib/writer-admission/interactive-proof";
import { LearningFailure, LearningNavigation, LearningShell } from "@/components/learning/shared";

export const dynamic = "force-dynamic";
export const metadata = { title: "My course | LASH HER Academy", robots: { index: false, follow: false } };
export default async function AcademyCoursePage({ params }: { params: Promise<{ courseId: string }> }) {
  if (!learningRoutesEnabled()) notFound();
  const { courseId } = await params;
  if (!validLearningId(courseId)) notFound();
  const path = `/academy/courses/${courseId}`;
  const scope = await readInteractiveBrowserRequest();
  const prefetch = scope?.lessonEntry || scope?.lessonExitSave ? false : undefined;
  const result = await readLearningPage(async () => {
    const client = getCourseClient();
    const [{ course }, { progress }] = await Promise.all([client.getMyCourse(courseId), client.listProgress({ courseId })]);
    return { course, progress };
  });
  if (result.error) return <LearningShell><LearningNavigation /><LearningFailure error={result.error} returnTo={path} retryHref={path} /></LearningShell>;
  const { course, progress } = result.data;
    const completed = new Set(progress.filter(row => row.completedAt).map(row => row.lessonId));
    return <LearningShell><LearningNavigation /><Link href={`/courses/${course.slug}`} prefetch={prefetch} className="text-sm underline underline-offset-4">Course overview</Link>
      <h1 className="mt-5 max-w-4xl font-heading text-5xl sm:text-6xl">{course.title}</h1>
      <ol className="mt-10 divide-y divide-lh-primary/20">{course.modules.map((module, index) => <li key={module.id} className="py-7"><h2 className="font-heading text-3xl"><span className="mr-4 text-lh-primary">{String(index + 1).padStart(2, "0")}</span>{module.title}</h2>
        {module.description ? <p className="mt-3 max-w-3xl text-lh-muted">{module.description}</p> : null}
        <ol className="mt-5 space-y-2">{module.lessons.map(lesson => <li key={lesson.id}><Link className="flex min-h-12 items-center justify-between gap-4 border border-lh-primary/15 px-4 py-3 hover:bg-lh-primary/5" href={lessonHref(courseId, lesson.id)} prefetch={prefetch}><span>{lesson.title}</span><span className="text-sm text-lh-primary">{completed.has(lesson.id) ? "Complete" : "Open lesson"}</span></Link></li>)}</ol>
      </li>)}</ol>
      {!course.modules.some(module => module.lessons.length) ? <p role="status" className="mt-10">Lessons are being prepared. Check back shortly.</p> : null}
    </LearningShell>;
}
