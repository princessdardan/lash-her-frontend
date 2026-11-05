"use client";

import { useEffect, useRef, useState } from "react";
import type { LearnerLesson, LessonProgress, LessonQuizState } from "@/lib/learning/types";
import { learningErrorText, learningRequest, LearningRequestError } from "@/lib/learning/browser-request";
import { createProgressSync, type ProgressSyncStatus } from "@/lib/learning/progress-sync";
import { AuthorizedVideo } from "./authorized-video";
import { LessonContent } from "./lesson-content";
import { LessonQuiz } from "./lesson-quiz";
import { learningAction, learningSecondaryAction } from "./shared";

export function LessonExperience({ lesson, initialProgress, quizState, preview = false }: { lesson: LearnerLesson; initialProgress: LessonProgress | null; quizState: LessonQuizState; preview?: boolean }) {
  const [progress, setProgress] = useState(initialProgress);
  const [status, setStatus] = useState<ProgressSyncStatus>("ready");
  const [failure, setFailure] = useState<unknown>(null);
  const assessmentPending = useRef(false);
  const [sync] = useState(() => createProgressSync({ initial: initialProgress,
    write: async (body, keepalive) => (await learningRequest<{ progress: LessonProgress }>(`/api/academy/lessons/${lesson.id}/progress`, { method: "POST", body, keepalive })).progress,
    latest: async () => (await learningRequest<{ progress: LessonProgress[] }>(`/api/academy/progress?lessonId=${lesson.id}`)).progress[0] ?? null,
    changed: (latest, next, error) => { setProgress(latest); setStatus(next); setFailure(error ?? null); },
  }));
  useEffect(() => {
    if (!preview) void sync.queue({ event: "lesson_started" });
    return () => { void sync.flush(true); };
  }, [sync, preview]);
  const completed = Boolean(progress?.completedAt);
  return <>
    {preview ? <p role="status" className="mt-6 border border-lh-primary/20 p-4 text-sm">Preview lesson. Enroll in the course to save progress and assessments to your account.</p> :
      <div aria-live="polite" className="mt-6 text-sm text-lh-muted">
        {status === "saving" ? "Saving progress…" : status === "saved" ? completed ? "Lesson complete. Progress saved." : "Progress saved to your account." : completed ? "Lesson complete." : "Your progress will save to your account."}
      </div>}
    <AuthorizedVideo lesson={lesson} resume={initialProgress?.resumePositionSeconds ?? 0} onPosition={(resume, watched, keepalive) => {
      if (!preview && !assessmentPending.current) void sync.queue({ resumePositionSeconds: resume, ...(watched === undefined ? {} : { maxPositionSeconds: watched }) }, keepalive);
    }} />
    <LessonContent lesson={lesson} />
    {!preview && status === "error" ? <div role="alert" className="mt-6 border border-lh-primary/20 p-5"><p>{learningErrorText(failure)} Progress has not been confirmed.</p>{failure instanceof LearningRequestError && failure.code === "sign_in_required" ? <a className={`${learningSecondaryAction} mt-3`} href="/sign-in?callbackUrl=%2Facademy">Sign in again</a> : <button type="button" className={`${learningSecondaryAction} mt-3`} onClick={() => { void sync.retry(); }}>Retry saving progress</button>}</div> : null}
    {!preview && status === "conflict" ? <div role="alert" className="mt-6 border border-lh-primary/20 p-5"><p>Another session updated this lesson. Reload to use your latest saved position before continuing.</p><button type="button" className={`${learningSecondaryAction} mt-3`} onClick={() => window.location.reload()}>Load latest progress</button></div> : null}
    {quizState.kind === "ready" && !preview ? <LessonQuiz key={`${quizState.quiz.id}-${quizState.quiz.revision}`} quiz={quizState.quiz} initialAttempts={quizState.attempts}
      onBusy={busy => { assessmentPending.current = busy; }} beforeAttempt={() => sync.flush()} afterAttempt={() => sync.refresh()} /> : !preview && quizState.kind === "unavailable" ?
      <div role="status" className="mt-10 border-t border-lh-primary/20 pt-8"><h2 className="font-heading text-3xl">Assessment unavailable</h2><p className="mt-3">We could not load this lesson’s assessment. Reload before marking this lesson complete.</p><button type="button" className={`${learningSecondaryAction} mt-4`} onClick={() => window.location.reload()}>Reload assessment</button></div> : null}
    {!preview && quizState.kind === "none" ? <div className="mt-10 border-t border-lh-primary/20 pt-8"><button type="button" className={learningAction} disabled={completed || status === "saving" || status === "error" || status === "conflict"} onClick={() => { void sync.queue({ event: "lesson_completed" }); }}>{completed ? "Lesson complete" : "Mark lesson complete"}</button></div> : null}
  </>;
}
