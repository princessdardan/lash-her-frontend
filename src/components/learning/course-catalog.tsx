import Link from "next/link";
import { getCourseClient } from "@/lib/api-integration/course-client";
import { readLearningPage } from "@/lib/learning/page-result";
import { coursePrice } from "@/lib/learning/presentation";
import { CourseCover } from "./course-cover";
import { LearningFailure, LearningNavigation, LearningShell } from "./shared";

export async function CourseCatalog({ cursor }: { cursor?: string }) {
  const result = await readLearningPage(() => getCourseClient().listCatalog({ limit: 12, ...(cursor ? { cursor } : {}) }));
  if (result.error) return <LearningShell><LearningNavigation /><LearningFailure error={result.error} retryHref="/courses" /></LearningShell>;
  const catalog = result.data;
    return <LearningShell><LearningNavigation />
      <header className="mb-10 max-w-3xl"><p className="eyebrow-label text-lh-primary">LASH HER Academy</p><h1 className="mt-4 font-heading text-5xl sm:text-6xl">Learn with intention</h1><p className="mt-5 leading-relaxed">Build your knowledge, practise your technique, and return to your lessons at your own pace.</p></header>
      {!catalog.courses.length ? <p role="status" className="border-t border-lh-primary/20 py-10">{cursor ? "No more courses are available." : "New courses are being prepared. Check back soon."}</p> :
        <ul className="grid gap-x-8 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">{catalog.courses.map(course => <li key={course.id}>
          <Link href={`/courses/${course.slug}`} className="group block focus-visible:outline-2 focus-visible:outline-offset-8"><CourseCover cover={course.cover} title={course.title} />
            <p className="mt-5 text-sm text-lh-primary">{coursePrice(course)}</p><h2 className="mt-2 font-heading text-3xl group-hover:underline underline-offset-4">{course.title}</h2>
            {course.description ? <p className="mt-3 line-clamp-3 leading-relaxed text-lh-muted">{course.description}</p> : null}
            <span className="mt-5 inline-block border-b border-lh-primary pb-1 text-sm">Explore course</span>
          </Link>
        </li>)}</ul>}
      <nav aria-label="Course pages" className="mt-12 flex gap-6 border-t border-lh-primary/20 pt-6 text-sm">
        {cursor ? <Link href="/courses" className="underline underline-offset-4">First page</Link> : null}
        {catalog.nextCursor ? <Link href={`/courses?cursor=${encodeURIComponent(catalog.nextCursor)}`} className="underline underline-offset-4">More courses</Link> : null}
      </nav>
    </LearningShell>;
}
