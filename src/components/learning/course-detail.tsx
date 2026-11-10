import Link from "next/link";
import { cache } from "react";
import { readLearningPage } from "@/lib/learning/page-result";
import { getCourseClient } from "@/lib/api-integration/course-client";
import { IntegrationServiceError } from "@/lib/api-integration/service-errors";
import { getCustomerActor } from "@/lib/customer-auth/session";
import { readInteractiveBrowserRequest } from "@/lib/writer-admission/interactive-proof";
import { coursePrice, customerSignInHref, lessonHref } from "@/lib/learning/presentation";
import { CourseCover } from "./course-cover";
import { FreeEnrollment } from "./free-enrollment";
import { LearningFailure, LearningNavigation, LearningShell, learningAction } from "./shared";

export const readCourseCatalogDetail = cache((slug: string) => getCourseClient().getCatalogCourse(slug));

export async function ApiCourseDetail({ slug }: { slug: string }) {
  const path = `/courses/${slug}`;
  const result = await readLearningPage(async () => {
    const client = getCourseClient();
    const [{ course }, customer, scoped] = await Promise.all([
      readCourseCatalogDetail(slug),
      getCustomerActor(),
      readInteractiveBrowserRequest(),
    ]);
    let enrolled = false;
    let accessFailure: IntegrationServiceError | undefined;
    if (customer) {
      try { await client.getMyCourse(course.id); enrolled = true; }
      catch (error) {
        if (error instanceof IntegrationServiceError && ["access_required", "access_revoked", "not_found"].includes(error.code)) { /* Public metadata remains available without access. */ }
        else accessFailure = error instanceof IntegrationServiceError ? error : new IntegrationServiceError("service_unavailable", 503);
      }
    }
    const enrollment = scoped?.learningEnrollment;
    const reviewedIdempotencyKey = enrollment && customer?.id === enrollment.actorId ? enrollment.idempotencyKey : undefined;
    return { course, customer, enrolled, accessFailure, reviewedIdempotencyKey };
  });
  if (result.error) return <LearningShell><LearningNavigation /><LearningFailure error={result.error} returnTo={path} retryHref={path} /></LearningShell>;
  const { course, customer, enrolled, accessFailure, reviewedIdempotencyKey } = result.data;
  return <LearningShell><LearningNavigation />
      <header className="border-b border-lh-primary/20 pb-10"><p className="eyebrow-label text-lh-primary">{coursePrice(course)} course</p><h1 className="mt-4 max-w-4xl font-heading text-5xl sm:text-6xl">{course.title}</h1>
        {course.introduction || course.description ? <p className="mt-6 max-w-3xl whitespace-pre-line leading-relaxed">{course.introduction || course.description}</p> : null}</header>
      <div className="grid gap-10 py-10 lg:grid-cols-2 lg:gap-16"><div><CourseCover cover={course.cover} title={course.title} />
        <section className="mt-10" aria-labelledby="curriculum-title"><h2 id="curriculum-title" className="font-heading text-3xl">Inside the course</h2>
          {!course.modules.length ? <p className="mt-4 text-lh-muted">The curriculum is being prepared.</p> : <ol className="mt-4 divide-y divide-lh-primary/15">{course.modules.map((module, index) => <li key={module.id} className="py-5">
            <h3 className="flex gap-4"><span className="text-sm text-lh-primary">{String(index + 1).padStart(2, "0")}</span><span>{module.title}</span></h3>
            {module.description ? <p className="mt-2 pl-9 text-sm leading-relaxed text-lh-muted">{module.description}</p> : null}
            {module.lessons.length ? <ul className="mt-3 space-y-3 pl-9">{module.lessons.map(lesson => <li key={lesson.id} className="text-sm">
              <Link className="underline underline-offset-4" href={customer ? `${lessonHref(course.id, lesson.id)}?course=${course.slug}` : customerSignInHref(`${lessonHref(course.id, lesson.id)}?course=${course.slug}`)}>{lesson.title}<span className="sr-only"> — preview lesson</span></Link><span className="ml-2 text-lh-muted">Preview</span>
            </li>)}</ul> : null}
          </li>)}</ol>}
        </section></div>
        <section aria-labelledby="course-start-title" className="self-start border border-lh-primary/20 p-6 sm:p-8"><h2 id="course-start-title" className="font-heading text-3xl">{enrolled ? "Your next lesson awaits" : "Make space to learn"}</h2>
          <p className="my-5 leading-relaxed text-lh-muted">Learn at your own pace. Resume your lessons on any device when you sign in.</p>
          {accessFailure ? <LearningFailure error={accessFailure} returnTo={path} retryHref={path} headingLevel={2} /> : enrolled ? <Link className={learningAction} href={`/academy/courses/${course.id}`}>Open course</Link> : !customer ?
            <Link className={learningAction} href={customerSignInHref(path)}>Sign in to {course.accessMode === "free" ? "enroll" : "continue"}</Link> : course.accessMode === "free" && course.priceCents === 0 && course.currency === "CAD" ? <FreeEnrollment courseId={course.id} reviewedIdempotencyKey={reviewedIdempotencyKey} /> :
              <p role="status" className="leading-relaxed">Enrollment for this course is not open yet.</p>}
        </section>
      </div>
    </LearningShell>;
}
