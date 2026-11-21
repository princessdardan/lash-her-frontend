import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

export const reviewHome = "/staging-review";
export const reviewOutlineHref = `${reviewHome}/course`;
export const reviewDiscussionsHref = `${reviewHome}#community`;
export const reviewLessonHref = (id: string) => `${reviewOutlineHref}/${id}`;

export function ReviewCourseProgress({
  title,
  total,
  completed,
  percent,
}: {
  title: string;
  total: number;
  completed: number;
  percent: number;
}) {
  if (!total)
    return <p className="text-sm text-lh-muted">No lessons available yet.</p>;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 text-sm">
        <p>
          {completed} of {total} lessons complete
        </p>
        <span
          aria-hidden="true"
          className="font-semibold tabular-nums text-lh-primary"
        >
          {percent}%
        </span>
      </div>
      <progress
        aria-label={`Progress in ${title}`}
        className="block h-2 w-full appearance-none overflow-hidden rounded-full bg-lh-neutral [&::-moz-progress-bar]:bg-lh-primary [&::-webkit-progress-bar]:bg-lh-neutral [&::-webkit-progress-value]:bg-lh-primary"
        max={100}
        value={percent}
      />
    </div>
  );
}

export function ReviewNavigation({ lesson = false }: { lesson?: boolean }) {
  return (
    <nav
      aria-label="Academy navigation"
      className="flex flex-wrap gap-x-6 border-b border-lh-line pb-3"
    >
      <Link
        className="inline-flex min-h-11 items-center gap-2 underline underline-offset-4"
        href={lesson ? reviewOutlineHref : reviewHome}
      >
        <ArrowLeft size={16} aria-hidden="true" />{" "}
        {lesson ? "Course outline" : "My Academy"}
      </Link>
      <Link
        className="inline-flex min-h-11 items-center underline underline-offset-4"
        href={reviewDiscussionsHref}
      >
        Course discussions
      </Link>
    </nav>
  );
}

type LessonLink = { id: string; title: string };

export function ReviewLessonNavigation({
  previous,
  next,
}: {
  previous?: LessonLink;
  next?: LessonLink;
}) {
  return (
    <nav
      aria-label="Lesson navigation"
      className="mt-8 grid gap-3 border-t border-lh-line pt-6 sm:grid-cols-2"
    >
      {previous && (
        <Link
          className="rounded-2xl border border-lh-line p-4 hover:bg-lh-neutral-2"
          href={reviewLessonHref(previous.id)}
          rel="prev"
        >
          <span className="flex items-center gap-2 text-sm text-lh-muted">
            <ArrowLeft size={16} aria-hidden="true" /> Previous lesson
          </span>
          <span className="mt-1 block break-words font-semibold">
            {previous.title}
          </span>
        </Link>
      )}
      {next ? (
        <Link
          className="rounded-2xl border border-lh-line p-4 hover:bg-lh-neutral-2 sm:col-start-2"
          href={reviewLessonHref(next.id)}
          rel="next"
        >
          <span className="flex items-center gap-2 text-sm text-lh-muted">
            Next lesson <ArrowRight size={16} aria-hidden="true" />
          </span>
          <span className="mt-1 block break-words font-semibold">
            {next.title}
          </span>
        </Link>
      ) : (
        <Button
          asChild
          variant="outline"
          className="min-h-11 justify-self-start sm:col-start-2"
        >
          <Link href={reviewOutlineHref}>
            Back to outline <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
      )}
    </nav>
  );
}
