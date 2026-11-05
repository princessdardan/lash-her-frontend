"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { LearnerQuiz, QuizAttempt } from "@/lib/learning/types";
import {
  learningErrorText,
  learningRequest,
  LearningRequestError,
} from "@/lib/learning/browser-request";
import { learningAction, learningSecondaryAction } from "./shared";

export function LessonQuiz({
  quiz,
  initialAttempts,
  beforeAttempt,
  afterAttempt,
  beforeRefresh,
  onBusy,
}: {
  quiz: LearnerQuiz;
  initialAttempts: QuizAttempt[];
  beforeAttempt: () => Promise<void>;
  afterAttempt: () => Promise<void>;
  beforeRefresh: () => Promise<boolean>;
  onBusy: (busy: boolean) => void;
}) {
  const router = useRouter();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [attempt, setAttempt] = useState<QuizAttempt | null>(null);
  const [history, setHistory] = useState(initialAttempts);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const key = useRef<{ fingerprint: string; id: string } | null>(null);
  const inFlight = useRef(false);
  async function refresh() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      if (!(await beforeRefresh())) {
        setError(
          "Your latest progress could not be confirmed. Retry saving progress before loading the assessment.",
        );
        return;
      }
      router.refresh();
    } catch (failure) {
      setError(learningErrorText(failure));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function submit() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    onBusy(true);
    setError("");
    const selected = quiz.document.questions.map((question) => ({
      questionId: question.id,
      optionId: answers[question.id],
    }));
    const fingerprint = JSON.stringify([quiz.revision, selected]);
    if (key.current?.fingerprint !== fingerprint)
      key.current = { fingerprint, id: crypto.randomUUID() };
    try {
      await beforeAttempt();
      const result = await learningRequest<{ attempt: QuizAttempt }>(
        `/api/academy/lessons/${quiz.lessonId}/quiz/attempts`,
        {
          method: "POST",
          body: {
            quizRevision: quiz.revision,
            requestId: key.current.id,
            answers: selected,
          },
        },
      );
      setAttempt(result.attempt);
      setHistory((previous) =>
        [
          result.attempt,
          ...previous.filter((row) => row.id !== result.attempt.id),
        ].slice(0, 50),
      );
      await afterAttempt();
    } catch (failure) {
      setError(learningErrorText(failure));
      if (failure instanceof LearningRequestError && failure.status === 409)
        setStale(true);
    } finally {
      inFlight.current = false;
      setBusy(false);
      onBusy(false);
    }
  }
  return (
    <section
      className="mt-10 border-t border-lh-primary/20 pt-8"
      aria-labelledby="lesson-assessment-title"
    >
      <h2 id="lesson-assessment-title" className="font-heading text-3xl">
        {quiz.document.mode === "graded"
          ? "Check your understanding"
          : "Put it into practice"}
      </h2>
      <p className="mt-3 leading-relaxed text-lh-muted">
        {quiz.document.mode === "graded"
          ? `Score at least ${quiz.document.passingPercent}% to complete this assessment. You can try as often as you need.`
          : "Use these questions to reflect on the lesson. Practice attempts complete the activity, and you can retry at any time."}
      </p>
      {!attempt ? (
        <form
          className="mt-6 space-y-8"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {quiz.document.questions.map((question, index) => (
            <fieldset key={question.id} disabled={busy || stale}>
              <legend className="mb-4 font-medium">
                {index + 1}. {question.prompt}
              </legend>
              <div className="space-y-3">
                {question.options.map((option) => (
                  <label
                    key={option.id}
                    className="flex min-h-12 cursor-pointer items-start gap-3 border border-lh-primary/20 px-4 py-3 hover:bg-lh-primary/5"
                  >
                    <input
                      type="radio"
                      name={`quiz-${quiz.id}-${question.id}`}
                      value={option.id}
                      checked={answers[question.id] === option.id}
                      onChange={() =>
                        setAnswers((previous) => ({
                          ...previous,
                          [question.id]: option.id,
                        }))
                      }
                      required
                      className="mt-1 size-4 shrink-0 accent-lh-primary"
                    />
                    <span>{option.text}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
          <button
            type="submit"
            disabled={
              busy ||
              stale ||
              quiz.document.questions.some((question) => !answers[question.id])
            }
            className={learningAction}
          >
            {busy ? "Submitting…" : "Submit answers"}
          </button>
        </form>
      ) : (
        <div
          role="status"
          className="mt-6 border border-lh-primary/20 bg-lh-primary/5 p-6"
        >
          <h3 className="font-heading text-2xl">
            {attempt.mode === "practice"
              ? "Practice complete"
              : attempt.passed
                ? "Assessment passed"
                : "Keep practising"}
          </h3>
          <p className="mt-3">
            {attempt.correctCount} of {attempt.totalCount} answers correct.{" "}
            {attempt.mode === "graded" && !attempt.passed
              ? `You need ${attempt.passingPercent}% to complete this assessment.`
              : "Your attempt has been saved."}
          </p>
          <ol className="mt-5 space-y-5">
            {attempt.results.map((result) => {
              const question = quiz.document.questions.find(
                (item) => item.id === result.questionId,
              );
              return (
                <li key={result.questionId}>
                  <p className="font-medium">
                    {question?.prompt ?? "Question"}:{" "}
                    {result.correct ? "Correct" : "Review"}
                  </p>
                  {!result.correct ? (
                    <p className="mt-1 text-sm">
                      Correct answer:{" "}
                      {question?.options.find(
                        (option) => option.id === result.correctOptionId,
                      )?.text ?? "See the feedback below."}
                    </p>
                  ) : null}
                  <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">
                    {result.feedback}
                  </p>
                </li>
              );
            })}
          </ol>
          <button
            type="button"
            className={`${learningSecondaryAction} mt-6`}
            onClick={() => {
              key.current = null;
              setAttempt(null);
              setAnswers({});
            }}
          >
            Try again
          </button>
        </div>
      )}
      {error || stale ? (
        <div role="alert" className="mt-5">
          {error ? <p>{error}</p> : null}
          {stale ? (
            <button
              type="button"
              disabled={busy}
              className={`${learningSecondaryAction} mt-3`}
              onClick={() => {
                void refresh();
              }}
            >
              Load the latest assessment
            </button>
          ) : null}
        </div>
      ) : null}
      {history.length ? (
        <details className="mt-8 border-t border-lh-primary/20 pt-5">
          <summary className="min-h-11 cursor-pointer py-2">
            Your recent attempts
          </summary>
          <ol className="mt-3 space-y-3">
            {history.map((row) => (
              <li key={row.id} className="text-sm">
                {new Date(row.createdAt).toLocaleString("en-CA", {
                  timeZone: "UTC",
                })}{" "}
                UTC · {row.correctCount}/{row.totalCount} ·{" "}
                {row.mode === "practice"
                  ? "Practice"
                  : row.passed
                    ? "Passed"
                    : "Not passed"}
                {row.quizRevision !== quiz.revision
                  ? " · Earlier assessment version"
                  : ""}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </section>
  );
}
