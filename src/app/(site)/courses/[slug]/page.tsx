import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";

import { LegacyCoursePage, generateLegacyCourseMetadata } from "@/components/courses/legacy-course-page";
import { ApiCourseDetail, readCourseCatalogDetail } from "@/components/learning/course-detail";
import { loaders } from "@/data/loaders";
import { IntegrationServiceError } from "@/lib/api-integration/service-errors";
import { validCourseSlug } from "@/lib/learning/presentation";
import { learningRoutesEnabled, legacyCourseFallbackEnabled } from "@/lib/learning/rollout";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<{ cookies?: string }> };

const resolveCourse = cache(async (slug: string) => {
  if (!learningRoutesEnabled()) return { kind: "legacy" as const };
  if (!validCourseSlug(slug)) return { kind: "missing" as const };
  try {
    const { course } = await readCourseCatalogDetail(slug);
    return { kind: "course" as const, course };
  } catch (error) {
    // A reviewed unmigrated slug can use its published legacy page during the transition.
    if (legacyCourseFallbackEnabled(slug) && error instanceof IntegrationServiceError &&
      (error.code === "not_found" || error.code === "service_unavailable") &&
      await loaders.getShortCourseSummary(slug).catch(() => null)) {
      return { kind: "legacy" as const };
    }
    return { kind: "unavailable" as const };
  }
});

export async function generateMetadata(props: Props): Promise<Metadata> {
  const selected = await resolveCourse((await props.params).slug);
  const metadataBase = new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://lashher.com");
  if (selected.kind === "legacy") {
    return { ...await generateLegacyCourseMetadata(props), metadataBase };
  }
  if (selected.kind !== "course") return { title: "Course unavailable", robots: { index: false } };
  const { course } = selected;
  return {
    metadataBase,
    title: course.seo?.title || course.title,
    description: course.seo?.description || course.introduction || course.description || undefined,
    alternates: { canonical: `/courses/${course.slug}` },
    robots: { index: !course.seo?.noIndex },
  };
}

export default async function CoursePage(props: Props) {
  const { slug } = await props.params;
  const selected = await resolveCourse(slug);
  if (selected.kind === "legacy") return LegacyCoursePage(props);
  if (selected.kind === "missing") notFound();
  return <ApiCourseDetail slug={slug} />;
}
