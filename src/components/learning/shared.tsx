import Link from "next/link";
import type { ReactNode } from "react";
import type { IntegrationServiceError } from "@/lib/api-integration/service-errors";
import { customerSignInHref } from "@/lib/learning/presentation";

export const learningAction = "inline-flex min-h-11 items-center justify-center border border-lh-primary bg-lh-primary px-6 py-3 text-sm text-white transition-colors hover:bg-lh-shadow focus-visible:outline-2 focus-visible:outline-offset-4 disabled:opacity-50";
export const learningSecondaryAction = "inline-flex min-h-11 items-center justify-center border border-lh-primary/40 px-6 py-3 text-sm text-lh-shadow transition-colors hover:bg-lh-primary/5 focus-visible:outline-2 focus-visible:outline-offset-4 disabled:opacity-50";

export function LearningShell({ children }: { children: ReactNode }) {
  return <div className="mx-auto max-w-7xl px-6 py-12 text-lh-shadow sm:px-8 md:py-16">{children}</div>;
}

export function LearningNavigation() {
  return <nav aria-label="Learning" className="mb-10 flex flex-wrap gap-x-6 gap-y-3 border-b border-lh-primary/20 pb-5 text-sm">
    <Link href="/courses" className="underline-offset-4 hover:underline">Courses</Link>
    <Link href="/academy" className="underline-offset-4 hover:underline">My academy</Link>
    <Link href="/account" className="underline-offset-4 hover:underline">My account</Link>
  </nav>;
}

export function LearningFailure({ error, returnTo = "/academy", retryHref, headingLevel = 1 }: { error: Pick<IntegrationServiceError, "code" | "requestId">; returnTo?: string; retryHref?: string; headingLevel?: 1 | 2 }) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  const titles: Record<string, string> = { sign_in_required: "Sign in to continue", access_required: "Enrollment required", access_revoked: "Course access has ended",
    forbidden: "Your account cannot open this lesson", not_found: "This course is unavailable", course_archived: "This course is archived", rate_limited: "Please wait before trying again" };
  const descriptions: Record<string, string> = { sign_in_required: "Sign in with the account you use for learning.", access_required: "Open the course page to enroll or check your access.",
    access_revoked: "This lesson is no longer available to your account. Your academy shows your current courses.", forbidden: "Check your account status or contact support for help.",
    not_found: "The course or lesson may have been removed from the current catalog.", course_archived: "Archived courses cannot be opened for learning.", rate_limited: "Your progress is saved on the server. Try again shortly." };
  return <section aria-labelledby="learning-unavailable-title" className="max-w-2xl border border-lh-primary/20 bg-lh-primary/5 p-6 sm:p-10">
    <Heading id="learning-unavailable-title" className="font-heading text-4xl">{titles[error.code] ?? "Learning is temporarily unavailable"}</Heading>
    <p className="mt-4 leading-relaxed">{descriptions[error.code] ?? "We could not reach the learning service. Try again in a moment."}</p>
    <div className="mt-6 flex flex-wrap gap-3">
      {error.code === "sign_in_required" ? <Link className={learningAction} href={customerSignInHref(returnTo)}>Sign in</Link> : retryHref ? <a className={learningSecondaryAction} href={retryHref}>Try again</a> : null}
      <Link className={learningSecondaryAction} href="/courses">Browse courses</Link>
    </div>
    <p className="mt-6 break-all text-xs text-lh-muted">Reference: {error.requestId}</p>
  </section>;
}

export function LearningLoading() {
  return <LearningShell><p role="status" className="border-b border-lh-primary/20 py-10 text-lg">Loading your learning space…</p></LearningShell>;
}
