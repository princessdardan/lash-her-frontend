import assert from "node:assert/strict";
import test from "node:test";
import type { ValidationContext } from "sanity";
import {
  shortCourse,
  validateCourseOptions,
  validateCourseMuxVideo,
} from "./short-course";

test("course quiz options require at least two answers and exactly one correct answer", () => {
  for (const options of [
    undefined,
    [],
    [{ isCorrect: true }],
    [{ isCorrect: false }, { isCorrect: false }],
    [{ isCorrect: true }, { isCorrect: true }],
  ])
    assert.notEqual(validateCourseOptions(options), true);
  assert.equal(
    validateCourseOptions([{ isCorrect: true }, { isCorrect: false }]),
    true,
  );
  assert.equal(shortCourse.name, "shortCourse");
  assert.ok(shortCourse.fields.some((field) => field.name === "modules"));
});

test("course publishing requires an existing, ready, public Mux asset", async () => {
  for (const [asset, valid] of [
    [null, false],
    [{ status: "preparing" }, false],
    [{ status: "errored" }, false],
    [{ status: "ready", playbackId: null }, false],
    [{ status: "ready", playbackId: "public-playback-id" }, true],
  ] as const) {
    const context = {
      getClient: () => ({
        fetch: async (_query: string, params: { id: string }) => {
          assert.equal(params.id, "mux-asset");
          return asset;
        },
      }),
    } as unknown as ValidationContext;
    const result = await validateCourseMuxVideo(
      { asset: { _ref: "mux-asset" } },
      context,
    );
    assert.equal(result === true, valid);
  }
  assert.notEqual(
    await validateCourseMuxVideo(undefined, {} as ValidationContext),
    true,
  );
  assert.notEqual(
    await validateCourseMuxVideo({}, {} as ValidationContext),
    true,
  );
});
