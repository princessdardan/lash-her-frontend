import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  normalizeBookingMarketingOptInLabel,
  normalizeOperationalBookingQuestions,
  parseOperationalBookingQuestionsJson,
} from "./operational-ui-settings";

describe("operational booking UI settings", () => {
  it("normalizes valid intake questions for operational storage", () => {
    assert.deepEqual(
      parseOperationalBookingQuestionsJson(
        JSON.stringify([
          {
            id: "allergies",
            inputType: "text",
            label: " Allergies ",
            required: true,
          },
          {
            id: "lash-style",
            inputType: "select",
            label: "Lash style",
            options: [" Classic ", "Volume"],
            required: false,
          },
        ]),
      ),
      [
        {
          id: "allergies",
          inputType: "text",
          label: "Allergies",
          required: true,
        },
        {
          id: "lash-style",
          inputType: "select",
          label: "Lash style",
          options: ["Classic", "Volume"],
          required: false,
        },
      ],
    );
  });

  it("rejects duplicate IDs and malformed select questions", () => {
    assert.throws(
      () =>
        normalizeOperationalBookingQuestions([
          {
            id: "notes",
            inputType: "text",
            label: "Notes",
            required: false,
          },
          {
            id: "notes",
            inputType: "textarea",
            label: "More notes",
            required: false,
          },
        ]),
      /duplicated/,
    );
    assert.throws(
      () =>
        normalizeOperationalBookingQuestions([
          {
            id: "style",
            inputType: "select",
            label: "Style",
            required: true,
          },
        ]),
      /options must be an array/,
    );
  });

  it("requires a non-empty marketing consent label", () => {
    assert.equal(
      normalizeBookingMarketingOptInLabel(" Send me occasional updates "),
      "Send me occasional updates",
    );
    assert.throws(
      () => normalizeBookingMarketingOptInLabel(" "),
      /Marketing opt-in label is required/,
    );
  });
});
