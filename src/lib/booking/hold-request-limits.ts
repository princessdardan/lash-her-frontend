export const BOOKING_HOLD_BODY_MAX_BYTES = 24 * 1024;
export const BOOKING_HOLD_MAX_ANSWERS = 20;
export const BOOKING_HOLD_QUESTION_ID_MAX_LENGTH = 128;
export const BOOKING_HOLD_ANSWER_MAX_LENGTH = 2_000;
export const BOOKING_HOLD_ANSWERS_MAX_BYTES = 8 * 1024;

export type HoldRequestBoundsResult =
  | { ok: true }
  | { error: string; ok: false; status: 400 | 413 };

export function validateHoldRequestBounds(
  input: unknown,
): HoldRequestBoundsResult {
  if (!isRecord(input) || input.answers === undefined) return { ok: true };
  if (!Array.isArray(input.answers)) {
    return {
      error: "Intake answers must be submitted as a list.",
      ok: false,
      status: 400,
    };
  }
  if (input.answers.length > BOOKING_HOLD_MAX_ANSWERS) {
    return tooLarge("Too many intake answers were submitted.");
  }

  let aggregateBytes = 0;
  const encoder = new TextEncoder();
  for (const answer of input.answers) {
    if (
      !isRecord(answer)
      || typeof answer.questionId !== "string"
      || typeof answer.answer !== "string"
    ) {
      return {
        error: "Each intake answer must contain text question and answer fields.",
        ok: false,
        status: 400,
      };
    }
    if (answer.questionId.length > BOOKING_HOLD_QUESTION_ID_MAX_LENGTH) {
      return tooLarge("An intake question identifier is too long.");
    }
    if (answer.answer.length > BOOKING_HOLD_ANSWER_MAX_LENGTH) {
      return tooLarge("An intake answer is too long.");
    }
    aggregateBytes += encoder.encode(answer.questionId).byteLength;
    aggregateBytes += encoder.encode(answer.answer).byteLength;
    if (aggregateBytes > BOOKING_HOLD_ANSWERS_MAX_BYTES) {
      return tooLarge("The combined intake answers are too large.");
    }
  }

  return { ok: true };
}

function tooLarge(error: string): HoldRequestBoundsResult {
  return { error, ok: false, status: 413 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
