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
    blocks: [],
    ...overrides,
  };
}

describe("TrainingEditorialDetails", () => {
  it("renders nothing when no structured details exist", async () => {
    const { TrainingEditorialDetails } = await import("./training-editorial-details");
    const program = buildProgram();

    const html = renderToStaticMarkup(createElement(TrainingEditorialDetails, { data: program }));
    assert.strictEqual(html, "");
  });

  it("renders detail items with single-column layout", async () => {
    const { TrainingEditorialDetails } = await import("./training-editorial-details");
    const program = buildProgram({
      detailHeading: "Curriculum",
      detailItems: [
        { _key: "1", title: "Classic Lashes", description: "Learn classic techniques" },
        { _key: "2", title: "Volume Lashes", description: "Master volume application" },
      ],
    });

    const html = renderToStaticMarkup(createElement(TrainingEditorialDetails, { data: program }));

    assert.match(html, /Curriculum/);
    assert.match(html, /Classic Lashes/);
    assert.match(html, /Volume Lashes/);
    assert.match(html, /grid-cols-1/);
    assert.doesNotMatch(html, /grid-cols-2/);
  });

  it("uses eyelash field when provided", async () => {
    const { TrainingEditorialDetails } = await import("./training-editorial-details");
    const program = buildProgram({
      detailItems: [
        { _key: "1", eyelash: "Day 1", title: "Classic Lashes", description: "Learn classic techniques" },
      ],
    });

    const html = renderToStaticMarkup(createElement(TrainingEditorialDetails, { data: program }));

    assert.match(html, /Day 1/);
    assert.doesNotMatch(html, /Lesson 1/);
  });

  it("falls back to Lesson N when eyelash is absent", async () => {
    const { TrainingEditorialDetails } = await import("./training-editorial-details");
    const program = buildProgram({
      detailItems: [
        { _key: "1", title: "Classic Lashes", description: "Learn classic techniques" },
      ],
    });

    const html = renderToStaticMarkup(createElement(TrainingEditorialDetails, { data: program }));

    assert.match(html, /Lesson 1/);
  });

  it("renders fact list when present", async () => {
    const { TrainingEditorialDetails } = await import("./training-editorial-details");
    const program = buildProgram({
      factList: ["2-day intensive", "Small groups"],
    });

    const html = renderToStaticMarkup(createElement(TrainingEditorialDetails, { data: program }));

    assert.match(html, /Program Facts/);
    assert.match(html, /2-day intensive/);
    assert.match(html, /Small groups/);
  });

  it("uses reduced vertical padding", async () => {
    const { TrainingEditorialDetails } = await import("./training-editorial-details");
    const program = buildProgram({
      detailHeading: "Curriculum",
    });

    const html = renderToStaticMarkup(createElement(TrainingEditorialDetails, { data: program }));

    assert.match(html, /py-10/);
    assert.doesNotMatch(html, /py-16/);
  });
});
