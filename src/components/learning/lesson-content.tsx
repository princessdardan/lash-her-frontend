import { PortableText } from "@portabletext/react";
import type { LearnerLesson } from "@/lib/learning/types";
import { safeLearningUrl } from "@/lib/learning/presentation";

export function LessonContent({ lesson }: { lesson: LearnerLesson }) {
  return <>
    {lesson.contentDocument?.blocks.length ? <div className="prose mt-8 max-w-none prose-headings:font-heading prose-headings:text-lh-shadow prose-a:text-lh-primary">
      <PortableText value={lesson.contentDocument.blocks} components={{
        block: {
          h1: ({ children }) => <h2>{children}</h2>, h2: ({ children }) => <h2>{children}</h2>,
          h3: ({ children }) => <h3>{children}</h3>, h4: ({ children }) => <h4>{children}</h4>,
          h5: ({ children }) => <h5>{children}</h5>, h6: ({ children }) => <h6>{children}</h6>,
        },
        marks: { link: ({ value, children }) => { const href = safeLearningUrl(value?.href, true); return href ? <a href={href} rel="noreferrer">{children}</a> : <span>{children}</span>; } },
      }} />
    </div> : lesson.content ? <div className="mt-8 whitespace-pre-wrap leading-relaxed">{lesson.content}</div> : null}
    {lesson.transcript ? <details className="mt-8 border-y border-lh-primary/20 py-5"><summary className="min-h-11 cursor-pointer py-2 text-lg">Read the transcript</summary><div className="mt-4 whitespace-pre-wrap leading-relaxed">{lesson.transcript}</div></details> : null}
  </>;
}
