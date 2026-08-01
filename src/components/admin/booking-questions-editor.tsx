"use client";

import { useMemo, useState } from "react";

import type {
  BookingQuestion,
  BookingQuestionInputType,
} from "@/lib/booking/types";

interface EditableQuestion {
  id: string;
  inputType: BookingQuestionInputType;
  label: string;
  optionsText: string;
  required: boolean;
}

export function BookingQuestionsEditor({
  questions,
}: {
  questions: BookingQuestion[];
}) {
  const [items, setItems] = useState<EditableQuestion[]>(() =>
    questions.map(toEditableQuestion),
  );
  const serialized = useMemo(
    () =>
      JSON.stringify(
        items.map((question) => {
          const base = {
            id: question.id,
            inputType: question.inputType,
            label: question.label,
            required: question.required,
          };

          return question.inputType === "select"
            ? {
                ...base,
                options: question.optionsText
                  .split("\n")
                  .map((option) => option.trim())
                  .filter(Boolean),
              }
            : base;
        }),
      ),
    [items],
  );

  function updateQuestion(
    id: string,
    update: Partial<Omit<EditableQuestion, "id">>,
  ) {
    setItems((current) =>
      current.map((question) =>
        question.id === id ? { ...question, ...update } : question,
      ),
    );
  }

  function addQuestion() {
    setItems((current) => {
      const id = createQuestionId(current.map((question) => question.id));
      return [
        ...current,
        {
          id,
          inputType: "text",
          label: "",
          optionsText: "",
          required: false,
        },
      ];
    });
  }

  return (
    <div>
      <input name="intakeQuestions" type="hidden" value={serialized} />
      <div className="space-y-4">
        {items.map((question, index) => (
          <fieldset
            className="rounded-xl border border-lh-line bg-lh-neutral-2 p-4"
            key={question.id}
          >
            <legend className="px-1 text-sm font-semibold">
              Question {index + 1}
            </legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-sm font-semibold sm:col-span-2">
                <span className="mb-2 block">Question shown to the client</span>
                <input
                  className={inputClass}
                  onChange={(event) =>
                    updateQuestion(question.id, {
                      label: event.target.value,
                    })
                  }
                  required
                  value={question.label}
                />
              </label>
              <label className="block text-sm font-semibold">
                <span className="mb-2 block">Answer format</span>
                <select
                  className={inputClass}
                  onChange={(event) =>
                    updateQuestion(question.id, {
                      inputType: event.target.value as BookingQuestionInputType,
                      optionsText:
                        event.target.value === "select" &&
                        !question.optionsText.trim()
                          ? "Option 1\nOption 2"
                          : question.optionsText,
                    })
                  }
                  value={question.inputType}
                >
                  <option value="text">Short answer</option>
                  <option value="textarea">Long answer</option>
                  <option value="select">Multiple choice</option>
                </select>
              </label>
              <label className="flex min-h-11 items-center gap-3 self-end rounded-xl border border-lh-line bg-white px-3 py-2 text-sm font-semibold">
                <input
                  checked={question.required}
                  onChange={(event) =>
                    updateQuestion(question.id, {
                      required: event.target.checked,
                    })
                  }
                  type="checkbox"
                />
                Client must answer
              </label>
              {question.inputType === "select" ? (
                <label className="block text-sm font-semibold sm:col-span-2">
                  <span className="mb-2 block">
                    Choices, one option per line
                  </span>
                  <textarea
                    className={`${inputClass} min-h-28`}
                    onChange={(event) =>
                      updateQuestion(question.id, {
                        optionsText: event.target.value,
                      })
                    }
                    required
                    value={question.optionsText}
                  />
                </label>
              ) : null}
            </div>
            <button
              className="mt-4 inline-flex min-h-11 items-center rounded-full border border-lh-line bg-white px-4 py-2 text-sm font-semibold text-lh-shadow hover:border-lh-primary"
              onClick={() =>
                setItems((current) =>
                  current.filter((item) => item.id !== question.id),
                )
              }
              type="button"
            >
              Remove question
            </button>
          </fieldset>
        ))}
      </div>
      {items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-lh-line bg-lh-neutral-2 p-4 text-sm text-lh-muted">
          No intake questions are shown during booking.
        </p>
      ) : null}
      <button
        className="mt-4 inline-flex min-h-11 items-center rounded-full border border-lh-line px-4 py-2 text-sm font-semibold text-lh-shadow hover:border-lh-primary disabled:opacity-50"
        disabled={items.length >= 20}
        onClick={addQuestion}
        type="button"
      >
        Add question
      </button>
    </div>
  );
}

function toEditableQuestion(question: BookingQuestion): EditableQuestion {
  return {
    id: question.id,
    inputType: question.inputType,
    label: question.label,
    optionsText:
      question.inputType === "select"
        ? (question.options ?? []).join("\n")
        : "",
    required: question.required,
  };
}

function createQuestionId(existingIds: string[]): string {
  const existing = new Set(existingIds);
  const base = `question-${Date.now().toString(36)}`;
  let candidate = base;
  let suffix = 2;

  while (existing.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }

  return candidate;
}

const inputClass =
  "min-h-11 w-full rounded-xl border border-lh-line bg-white px-3 py-2 text-sm focus:border-lh-primary focus:outline-none focus:ring-2 focus:ring-lh-primary/20";
