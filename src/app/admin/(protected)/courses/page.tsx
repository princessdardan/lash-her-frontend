import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { CreateCourseForm } from "@/components/admin/course-authoring/create-course-form";
import { getCourseClient } from "@/lib/api-integration/course-client";
import { isIntegrationFeatureEnabled } from "@/lib/api-integration/rollout-flags";
import { loadCourseAuthoringPage } from "@/lib/course-authoring/page-data";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export default async function CoursesAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  if (!isIntegrationFeatureEnabled("courseReads")) notFound();
  const { cursor } = await searchParams;
  const loaded = await loadCourseAuthoringPage(() =>
    getCourseClient().listAdminCourses({
      limit: 100,
      ...(cursor ? { cursor } : {}),
    }),
  );
  if (loaded.kind === "redirect") redirect(loaded.destination);
  if (loaded.kind === "unavailable") {
    const { error } = loaded;
    return (
      <section className="space-y-3">
        <h1 className="font-heading text-4xl uppercase">Courses</h1>
        <p role="alert">{error.message}</p>
        <p className="text-xs text-lh-muted">Reference: {error.requestId}</p>
        <Link href="/admin/courses" className="underline">
          Reload courses
        </Link>
      </section>
    );
  }
  const result = loaded.data;
  return (
    <div className="space-y-8">
      <header>
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">
          Learning
        </p>
        <h1 className="mt-2 font-heading text-5xl uppercase tracking-wide">
          Courses
        </h1>
        <p className="mt-3 text-lh-muted">
          Edit curriculum, assessments and media, then review publication
          readiness.
        </p>
      </header>
      <section
        aria-labelledby="catalog-heading"
        className="rounded-2xl border border-lh-line bg-white p-5 sm:p-6"
      >
        <h2
          id="catalog-heading"
          className="font-heading text-3xl uppercase tracking-wide"
        >
          Course catalog
        </h2>
        {result.courses.length ? (
          <ul className="mt-5 divide-y divide-lh-line">
            {result.courses.map((course) => (
              <li
                key={course.id}
                className="flex flex-wrap items-center justify-between gap-3 py-4"
              >
                <div>
                  <Link
                    href={`/admin/courses/${course.id}`}
                    className="font-semibold text-lh-primary underline underline-offset-4"
                  >
                    {course.title}
                  </Link>
                  <p className="mt-1 text-sm text-lh-muted">
                    {course.status} ·{" "}
                    {course.accessMode === "free"
                      ? "Free"
                      : new Intl.NumberFormat("en-CA", {
                          style: "currency",
                          currency: "CAD",
                        }).format(course.priceCents / 100)}{" "}
                    · {course.modules.length} modules
                  </p>
                </div>
                <span className="text-xs text-lh-muted">
                  Revision {course.revision}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 text-lh-muted">No courses yet.</p>
        )}
        {result.nextCursor && (
          <Link
            className="mt-5 inline-block text-sm text-lh-primary underline"
            href={`/admin/courses?cursor=${encodeURIComponent(result.nextCursor)}`}
          >
            Next page
          </Link>
        )}
      </section>
      <section className="rounded-2xl border border-lh-line bg-white p-5 sm:p-6">
        <CreateCourseForm />
      </section>
    </div>
  );
}
