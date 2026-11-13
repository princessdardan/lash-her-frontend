import type { MetadataRoute } from "next";

import { loaders } from "@/data/loaders";
import { getCourseClient } from "@/lib/api-integration/course-client";
import { validCourseSlug } from "@/lib/learning/presentation";
import { learningRoutesEnabled, legacyCourseFallbackEnabled } from "@/lib/learning/rollout";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const courseReads = learningRoutesEnabled();
  const legacy = await loaders.getLegacyShortCourseSlugs();
  const slugs = new Set(legacy.filter(course => !course.noIndex && validCourseSlug(course.slug)
    && (!courseReads || legacyCourseFallbackEnabled(course.slug))).map(course => course.slug));

  if (courseReads) {
    const client = getCourseClient();
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const { courses, nextCursor } = await client.listCatalog({ limit: 100, ...(cursor ? { cursor } : {}) });
      for (const course of courses) {
        if (course.seo?.noIndex) slugs.delete(course.slug);
        else if (validCourseSlug(course.slug)) slugs.add(course.slug);
      }
      if (nextCursor && seen.has(nextCursor)) throw new Error("Course catalog repeated a sitemap cursor");
      if (nextCursor) seen.add(nextCursor);
      cursor = nextCursor ?? undefined;
    } while (cursor);
  }

  const origin = new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://lashher.com").origin;
  return [...slugs].sort().map(slug => ({ url: new URL(`/courses/${slug}`, origin).href }));
}
