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
      linkedProduct: {
        _id: "linked-training-product",
        title: "Beginner Private Training",
        slug: "beginner-private-training",
        price: null,
        currency: "CAD",
        isAvailable: true,
      },
    } as unknown as Partial<TTrainingProgram>);

    const html = renderToStaticMarkup(createElement(TrainingEnrollmentSection, { data: program }));

    assert.match(html, /Reserve Your Training Place/);
    assert.doesNotMatch(html, /Investment/);
    assert.doesNotMatch(html, /CAD/);
  });
});
