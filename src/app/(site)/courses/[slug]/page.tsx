import type { Metadata } from "next";
import { learningRoutesEnabled } from "@/lib/learning/rollout";
import { validCourseSlug } from "@/lib/learning/presentation";
import { getCourseClient } from "@/lib/api-integration/course-client";
import { LegacyCoursePage, generateLegacyCourseMetadata } from "@/components/courses/legacy-course-page";
import { ApiCourseDetail } from "@/components/learning/course-detail";
import { notFound } from "next/navigation";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<{ cookies?: string }> };
export async function generateMetadata(props: Props): Promise<Metadata> {
  if (!learningRoutesEnabled()) return generateLegacyCourseMetadata(props);
  const { slug } = await props.params;
  if (!validCourseSlug(slug)) return { title: "Course unavailable", robots: { index: false } };
  try {
    const { course } = await getCourseClient().getCatalogCourse(slug);
    return { title: course.seo?.title || course.title, description: course.seo?.description || course.introduction || course.description || undefined,
      alternates: { canonical: `/courses/${course.slug}` }, robots: { index: !course.seo?.noIndex } };
  } catch { return { title: "Course unavailable", robots: { index: false } }; }
}
export default async function CoursePage(props: Props) {
  if (!learningRoutesEnabled()) return LegacyCoursePage(props);
  const { slug } = await props.params;
  if (!validCourseSlug(slug)) notFound();
  return <ApiCourseDetail slug={slug} />;
}
