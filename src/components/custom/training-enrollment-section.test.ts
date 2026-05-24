import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TTrainingProgram } from "@/types";

process.env.NEXT_PUBLIC_SANITY_DATASET ??= "test";
process.env.NEXT_PUBLIC_SANITY_PROJECT_ID ??= "test-project";

function buildProgram(overrides: Partial<TTrainingProgram> = {}): TTrainingProgram {
  return {
    _id: "training-beginner",
    title: "Beginner Private Training",
    description: "Private training program",
    slug: "beginner-private-training",
    enrollmentTitle: "Reserve Your Training Place",
    blocks: [],
    ...overrides,
  };
}

describe("TrainingEnrollmentSection", () => {
  it("omits the investment amount when Sanity returns null commerce prices", async () => {
    const { TrainingEnrollmentSection } = await import("./training-enrollment-section");
    const program = buildProgram({
      price: null,
    } as unknown as Partial<TTrainingProgram>);

    const html = renderToStaticMarkup(createElement(TrainingEnrollmentSection, { data: program }));

    assert.match(html, /Reserve Your Training Place/);
    assert.doesNotMatch(html, /Investment/);
    assert.doesNotMatch(html, /CAD/);
  });

  it("renders fact list as inclusions when enrollmentInclusions is absent", async () => {
    const { TrainingEnrollmentSection } = await import("./training-enrollment-section");
    const program = buildProgram({
      factList: ["Kit included", "Certificate provided", "Ongoing support"],
    });

    const html = renderToStaticMarkup(createElement(TrainingEnrollmentSection, { data: program }));

    assert.match(html, /Included/);
    assert.match(html, /Kit included/);
    assert.match(html, /Certificate provided/);
    assert.match(html, /Ongoing support/);
  });

  it("does not render inclusions section when fact list is empty", async () => {
    const { TrainingEnrollmentSection } = await import("./training-enrollment-section");
    const program = buildProgram({
      factList: [],
    });

    const html = renderToStaticMarkup(createElement(TrainingEnrollmentSection, { data: program }));

    assert.doesNotMatch(html, /Included/);
  });
});
