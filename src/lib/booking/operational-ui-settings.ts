import type { BookingQuestion } from "./types";

export const DEFAULT_BOOKING_MARKETING_OPT_IN_LABEL =
  "I agree to receive occasional updates from Lash Her by Nataliea.";

export interface OperationalBookingUiSettings {
  intakeQuestions: BookingQuestion[];
  marketingOptInLabel: string;
  timezone: string;
}

export function parseOperationalBookingQuestionsJson(
  value: string,
): BookingQuestion[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Intake questions must be valid JSON");
  }

  return normalizeOperationalBookingQuestions(parsed);
}

export function normalizeOperationalBookingQuestions(
  value: unknown,
): BookingQuestion[] {
  if (!Array.isArray(value)) {
    throw new Error("Intake questions must be a JSON array");
  }

  const seenIds = new Set<string>();

  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Intake question ${index + 1} must be an object`);
    }

    const id = requiredString(entry.id, `Intake question ${index + 1} ID`);
    if (!/^[a-z0-9-]+$/.test(id)) {
      throw new Error(
        `Intake question ${index + 1} ID must use lowercase letters, numbers, and hyphens only`,
      );
    }
    if (seenIds.has(id)) {
      throw new Error(`Intake question ID "${id}" is duplicated`);
    }
    seenIds.add(id);

    const label = requiredString(
      entry.label,
      `Intake question ${index + 1} label`,
    );
    const inputType = entry.inputType;
    if (
      inputType !== "text" &&
      inputType !== "textarea" &&
      inputType !== "select"
    ) {
      throw new Error(
        `Intake question ${index + 1} inputType must be text, textarea, or select`,
      );
    }
    if (typeof entry.required !== "boolean") {
      throw new Error(
        `Intake question ${index + 1} required must be true or false`,
      );
    }

    if (inputType !== "select") {
      return { id, inputType, label, required: entry.required };
    }

    if (!Array.isArray(entry.options)) {
      throw new Error(
        `Intake question ${index + 1} options must be an array for select questions`,
      );
    }
    const options = entry.options.map((option, optionIndex) =>
      requiredString(
        option,
        `Intake question ${index + 1} option ${optionIndex + 1}`,
      ),
    );
    if (options.length === 0) {
      throw new Error(
        `Intake question ${index + 1} must define at least one option`,
      );
    }
    if (new Set(options).size !== options.length) {
      throw new Error(`Intake question ${index + 1} options must be unique`);
    }

    return { id, inputType, label, options, required: entry.required };
  });
}

export function normalizeBookingMarketingOptInLabel(value: unknown): string {
  return requiredString(value, "Marketing opt-in label");
}

/**
 * V2 holds created before the label snapshot was introduced use the immutable
 * application default. This keeps the text rendered after deployment aligned
 * with the text persisted at confirmation without consulting mutable settings.
 */
export function readBookingMarketingOptInLabelSnapshot(value: unknown): string {
  try {
    return normalizeBookingMarketingOptInLabel(value);
  } catch {
    return DEFAULT_BOOKING_MARKETING_OPT_IN_LABEL;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required`);
  }

  return value.trim();
}
