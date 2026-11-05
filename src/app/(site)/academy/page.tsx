import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCourseClient } from "@/lib/api-integration/course-client";
import { readLearningPage } from "@/lib/learning/page-result";
import { learningRoutesEnabled } from "@/lib/learning/rollout";
import { lessonHref, formatPosition } from "@/lib/learning/presentation";
import { LearningFailure, LearningNavigation, LearningShell, learningAction, learningSecondaryAction } from "@/components/learning/shared";

export const metadata: Metadata = { title: "My academy | LASH HER", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";
export default async function AcademyPage() {
  if (!learningRoutesEnabled()) notFound();
  const result = await readLearningPage(() => getCourseClient().listMyCourses());
  if (result.error) return <LearningShell><LearningNavigation /><LearningFailure error={result.error} retryHref="/academy" /></LearningShell>;
  const { courses } = result.data;
    return <LearningShell><LearningNavigation /><header className="mb-10"><p className="eyebrow-label text-lh-primary">Your learning space</p><h1 className="mt-4 font-heading text-5xl sm:text-6xl">My academy</h1><p className="mt-5 max-w-2xl leading-relaxed">Return to a lesson, revisit your notes, and keep building your practice.</p></header>
      {!courses.length ? <section className="border border-lh-primary/20 p-8"><h2 className="font-heading text-3xl">Your first course starts here</h2><p className="my-5">Explore the catalog and enroll to save your progress with your account.</p><Link className={learningAction} href="/courses">Find a course</Link></section> :
        <ul className="grid gap-8 lg:grid-cols-2">{courses.map(course => <li key={course.id} className="flex flex-col border border-lh-primary/20 p-6 sm:p-8">
          <h2 className="font-heading text-3xl">{course.title}</h2>{course.description ? <p className="mt-3 line-clamp-3 leading-relaxed text-lh-muted">{course.description}</p> : null}
          {course.status === "archived" ? <p role="status" className="mt-5">This course is archived. Learning access is no longer available.</p> : <>
            <label htmlFor={`progress-${course.id}`} className="mt-6 text-sm">{course.progress.completedLessons} of {course.progress.totalLessons} lessons complete</label>
            <progress id={`progress-${course.id}`} max={100} value={course.progress.percentComplete} className="mt-2 h-2 w-full accent-lh-primary">{course.progress.percentComplete}%</progress>
            <div className="mt-6 flex flex-wrap gap-3">{course.progress.continueLessonId ? <Link className={learningAction} href={lessonHref(course.id, course.progress.continueLessonId)}>Continue lesson{course.progress.continuePositionSeconds ? ` at ${formatPosition(course.progress.continuePositionSeconds)}` : ""}</Link> : null}
              <Link className={learningSecondaryAction} href={`/academy/courses/${course.id}`}>{course.progress.continueLessonId ? "All lessons" : "Open course"}</Link></div>
          </>}
        </li>)}</ul>}
    </LearningShell>;
}
