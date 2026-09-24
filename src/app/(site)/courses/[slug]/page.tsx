import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loaders } from "@/data/loaders";
import { readCourseAccess } from "@/lib/courses/access";
import { CoursePlayer } from "@/components/courses/course-player";
import { CourseSignup } from "@/components/courses/course-signup";
import { SanityImage } from "@/components/ui/sanity-image";

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ cookies?: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const course = await loaders.getShortCourseSummary((await params).slug);
  if (!course) return { title: "Course unavailable", robots: { index: false } };
  return {
    title: course.seo?.title || course.title,
    description: course.seo?.description || course.introduction,
    alternates: { canonical: `/courses/${course.slug}` },
    robots: { index: !course.seo?.noIndex },
  };
}

export default async function CoursePage({ params, searchParams }: Props) {
  const course = await loaders.getShortCourseSummary((await params).slug);
  if (!course?.modules?.length) notFound();
  // cookies() makes this response dynamic. Only the public summary crosses
  // the unauthenticated RSC boundary; full content is fetched after access.
  const grant = await readCourseAccess(course._id);
  const content = grant
    ? await loaders.getShortCourseContent(course._id)
    : null;
  if (grant && !content?.modules?.length) notFound();
  return (
    <div className="mx-auto max-w-7xl px-6 py-12 text-lh-shadow sm:px-8 md:py-16">
      <header className="border-b border-lh-primary/20 pb-10">
        <p className="eyebrow-label mb-4 text-lh-primary">Free short course</p>
        <h1 className="max-w-4xl font-heading text-4xl leading-tight sm:text-5xl lg:text-6xl">
          {course.title}
        </h1>
        <p className="mt-5 max-w-2xl whitespace-pre-line text-base leading-relaxed">
          {course.introduction}
        </p>
      </header>
      {grant && content ? (
        <CoursePlayer course={content} grant={grant} />
      ) : (
        <div className="grid gap-10 py-10 lg:grid-cols-2 lg:gap-16">
          <section aria-labelledby="course-outline-title">
            {course.coverImage && (
              <SanityImage
                image={course.coverImage}
                alt={course.coverImage.alt || course.title}
                width={800}
                height={450}
                className="mb-8 aspect-video w-full object-cover"
                sizes="(min-width: 1024px) 50vw, 100vw"
              />
            )}
            <h2 id="course-outline-title" className="font-heading text-3xl">
              What you’ll learn
            </h2>
            <ol className="mt-5 divide-y divide-lh-primary/15">
              {course.modules.map((module, index) => (
                <li key={module._key} className="flex gap-4 py-4">
                  <span className="text-sm text-lh-primary">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span>{module.title}</span>
                </li>
              ))}
            </ol>
          </section>
          <CourseSignup
            courseId={course._id}
            cookiesBlocked={(await searchParams).cookies === "blocked"}
          />
        </div>
      )}
    </div>
  );
}
