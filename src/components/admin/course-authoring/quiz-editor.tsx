"use client";
import { useEffect, useState, type FormEvent } from "react";
import {
  authoringRequest,
  AuthoringRequestError,
} from "@/lib/course-authoring/browser";
import { buttonClass, fieldClass, secondaryClass } from "./course-fields";
import type { SaveAuthoring } from "./curriculum-forms";
import type { CandidateSuccess } from "@/lib/api-integration/candidate-validation";
type QuizRecord = CandidateSuccess<
  "course",
  "/v1/admin/lessons/{lessonId}/quiz",
  "get"
>["quiz"];
type QuizDocument = QuizRecord["document"];
type Question = QuizDocument["questions"][number];
const emptyDocument: QuizDocument = {
  version: 1,
  mode: "graded",
  passingPercent: 80,
  questions: [],
};
export function QuizEditor({
  lessonId,
  revision,
  pending,
  save,
}: {
  lessonId: string;
  revision: number;
  pending: boolean;
  save: SaveAuthoring;
}) {
  const [validationMessage, setValidationMessage] = useState<string | null>(
    null,
  );
  const [document, setDocument] = useState<QuizDocument>(emptyDocument),
    [loading, setLoading] = useState(true),
    [loadError, setLoadError] = useState(false),
    [quizRevision, setQuizRevision] = useState<number | null>(null);
  useEffect(() => {
    let disposed = false;
    authoringRequest<{ quiz: QuizRecord }>(
      `/api/admin/lessons/${lessonId}/quiz`,
    )
      .then((result) => {
        if (!disposed) {
          setDocument(result.quiz.document);
          setQuizRevision(result.quiz.revision);
        }
      })
      .catch((error) => {
        if (
          !disposed &&
          !(error instanceof AuthoringRequestError && error.status === 404)
        )
          setLoadError(true);
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [lessonId]);
  function updateQuestion(index: number, question: Question) {
    setDocument((previous) => ({
      ...previous,
      questions: previous.questions.map((item, i) =>
        i === index ? question : item,
      ),
    }));
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      document.questions.some(
        (question) =>
          !question.prompt.trim() ||
          !question.feedback.trim() ||
          question.options.some((option) => !option.text.trim()),
      )
    ) {
      setValidationMessage(
        "Every question, option and feedback field needs text.",
      );
      return;
    }
    setValidationMessage(null);
    await save(
      `/api/admin/lessons/${lessonId}/quiz`,
      "PUT",
      { expectedCourseRevision: revision, document },
      "Quiz revision saved. Previous attempts remain in history.",
    );
  }
  if (loading) return <p role="status">Loading assessment…</p>;
  if (loadError)
    return (
      <p role="alert">
        The assessment could not be loaded. Reload the current course before
        editing.
      </p>
    );
  return (
    <form onSubmit={submit} className="space-y-5">
      <fieldset disabled={pending} className="space-y-5">
        <legend className="mb-3 font-heading text-3xl uppercase">
          Assessment
        </legend>
        <p className="text-sm text-lh-muted">
          {quizRevision ? `Revision ${quizRevision}. ` : "No assessment yet. "}
          Saving creates a new revision. Earlier attempts remain unchanged;
          learners complete the current revision.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm">
            Assessment mode
            <select
              className={fieldClass}
              value={document.mode}
              onChange={(event) =>
                setDocument({
                  ...document,
                  mode: event.target.value as QuizDocument["mode"],
                })
              }
            >
              <option value="graded">Graded: pass to complete</option>
              <option value="practice">
                Practice: answer all questions to complete
              </option>
            </select>
          </label>
          <label className="text-sm">
            Passing score (%)
            <input
              className={fieldClass}
              type="number"
              min={1}
              max={100}
              required
              value={document.passingPercent}
              onChange={(event) =>
                setDocument({
                  ...document,
                  passingPercent: Number(event.target.value),
                })
              }
            />
          </label>
        </div>
        <p className="text-sm text-lh-muted">
          Learners can retry without a limit. The default passing score is 80%.
        </p>
        {document.questions.map((question, index) => (
          <fieldset
            className="space-y-4 rounded-xl border border-lh-line p-4"
            key={question.id}
          >
            <legend className="px-1 text-sm font-semibold">
              Question {index + 1}
            </legend>
            <label className="block text-sm">
              Question
              <textarea
                className={fieldClass}
                required
                maxLength={5000}
                rows={3}
                value={question.prompt}
                onChange={(event) =>
                  updateQuestion(index, {
                    ...question,
                    prompt: event.target.value,
                  })
                }
              />
            </label>
            <div className="space-y-3">
              {question.options.map((option, i) => (
                <div key={option.id} className="flex items-center gap-3">
                  <label className="shrink-0 text-xs">
                    <input
                      className="mr-1"
                      type="radio"
                      name={`correct-${question.id}`}
                      checked={question.correctOptionId === option.id}
                      required
                      onChange={() =>
                        updateQuestion(index, {
                          ...question,
                          correctOptionId: option.id,
                        })
                      }
                    />
                    Correct {i + 1}
                  </label>
                  <label className="grow">
                    <span className="sr-only">
                      Question {index + 1} option {i + 1}
                    </span>
                    <input
                      className={fieldClass}
                      required
                      maxLength={2000}
                      value={option.text}
                      onChange={(event) =>
                        updateQuestion(index, {
                          ...question,
                          options: question.options.map((item) =>
                            item.id === option.id
                              ? { ...item, text: event.target.value }
                              : item,
                          ),
                        })
                      }
                    />
                  </label>
                  {question.options.length > 2 && (
                    <button
                      type="button"
                      className={secondaryClass}
                      aria-label={`Remove question ${index + 1} option ${i + 1}`}
                      onClick={() =>
                        updateQuestion(index, {
                          ...question,
                          options: question.options.filter(
                            (item) => item.id !== option.id,
                          ),
                          correctOptionId:
                            question.correctOptionId === option.id
                              ? ""
                              : question.correctOptionId,
                        })
                      }
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button
              type="button"
              className={secondaryClass}
              disabled={question.options.length >= 6}
              onClick={() =>
                updateQuestion(index, {
                  ...question,
                  options: [
                    ...question.options,
                    { id: crypto.randomUUID(), text: "" },
                  ],
                })
              }
            >
              Add option
            </button>
            <label className="block text-sm">
              Feedback after answering
              <textarea
                className={fieldClass}
                required
                maxLength={8000}
                rows={3}
                value={question.feedback}
                onChange={(event) =>
                  updateQuestion(index, {
                    ...question,
                    feedback: event.target.value,
                  })
                }
              />
            </label>
            <button
              type="button"
              className={secondaryClass}
              onClick={() =>
                setDocument({
                  ...document,
                  questions: document.questions.filter(
                    (item) => item.id !== question.id,
                  ),
                })
              }
            >
              Remove question
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          className={secondaryClass}
          disabled={document.questions.length >= 100}
          onClick={() => {
            const first = crypto.randomUUID();
            setDocument({
              ...document,
              questions: [
                ...document.questions,
                {
                  id: crypto.randomUUID(),
                  prompt: "",
                  options: [
                    { id: first, text: "" },
                    { id: crypto.randomUUID(), text: "" },
                  ],
                  correctOptionId: first,
                  feedback: "",
                },
              ],
            });
          }}
        >
          Add question
        </button>
      </fieldset>
      {validationMessage && (
        <p role="alert" className="text-sm text-lh-accent">
          {validationMessage}
        </p>
      )}
      <button
        className={buttonClass}
        disabled={pending || document.questions.length === 0}
      >
        Save new quiz revision
      </button>
    </form>
  );
}
