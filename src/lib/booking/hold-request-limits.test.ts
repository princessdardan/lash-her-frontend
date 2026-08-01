import assert from "node:assert/strict";
import test from "node:test";

import {
  BOOKING_HOLD_ANSWER_MAX_LENGTH,
  BOOKING_HOLD_ANSWERS_MAX_BYTES,
  BOOKING_HOLD_MAX_ANSWERS,
  BOOKING_HOLD_QUESTION_ID_MAX_LENGTH,
  validateHoldRequestBounds,
} from "./hold-request-limits";

test("hold intake bounds accept a normal answer set", () => {
  assert.deepEqual(validateHoldRequestBounds({
    answers: [
      { answer: "Sensitive eyes", questionId: "notes" },
      { answer: "No", questionId: "allergies" },
    ],
  }), { ok: true });
});

test("hold intake bounds enforce answer count and field lengths", () => {
  assert.equal(validateHoldRequestBounds({
    answers: Array.from(
      { length: BOOKING_HOLD_MAX_ANSWERS + 1 },
      (_, index) => ({ answer: "No", questionId: `question-${index}` }),
    ),
  }).ok, false);
  assert.equal(validateHoldRequestBounds({
    answers: [{
      answer: "No",
      questionId: "q".repeat(BOOKING_HOLD_QUESTION_ID_MAX_LENGTH + 1),
    }],
  }).ok, false);
  assert.equal(validateHoldRequestBounds({
    answers: [{
      answer: "a".repeat(BOOKING_HOLD_ANSWER_MAX_LENGTH + 1),
      questionId: "notes",
    }],
  }).ok, false);
});

test("hold intake bounds enforce aggregate UTF-8 size", () => {
  const result = validateHoldRequestBounds({
    answers: Array.from({ length: 5 }, (_, index) => ({
      answer: "é".repeat(Math.ceil(BOOKING_HOLD_ANSWERS_MAX_BYTES / 10)),
      questionId: `q-${index}`,
    })),
  });
  assert.deepEqual(result, {
    error: "The combined intake answers are too large.",
    ok: false,
    status: 413,
  });
});
