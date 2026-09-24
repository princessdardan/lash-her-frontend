import assert from "node:assert/strict";
import test from "node:test";
import type { TCourseModule } from "@/types";
import {
  restoreCourseProgress,
  scoreCourseQuiz,
  courseProgressKey,
} from "./progress";
import type { CourseAccessGrant } from "./contract";

const lessonModule: TCourseModule = {
  _key: "first",
  title: "First",
  lesson: [],
  video: {
    provider: "sanity",
    id: "video-one",
    url: "https://example.invalid/video.mp4",
  },
  quiz: [
    {
      _key: "q1",
      prompt: "Choose",
      explanation: "A is correct",
      options: [
        { _key: "a", text: "A", isCorrect: true },
        { _key: "b", text: "B", isCorrect: false },
      ],
    },
  ],
};
const second = { ...lessonModule, _key: "second" };
const grant: CourseAccessGrant = {
  version: 1,
  courseId: "course",
  grantId: "browser-one",
  expiresAt: 2_000_000_000,
};

function savedProgress() {
  const saved = restoreCourseProgress(null, [lessonModule, second], grant);
  saved.modules.first = {
    ...saved.modules.first,
    position: 45,
    answers: { q1: "b" },
    submitted: true,
    completed: true,
  };
  return saved;
}

test("practice quizzes complete for a fully answered attempt regardless of score", () => {
  assert.deepEqual(scoreCourseQuiz(lessonModule, { q1: "b" }), {
    correct: 0,
    total: 1,
    complete: true,
  });
  assert.equal(scoreCourseQuiz(lessonModule, { q1: "a" }).correct, 1);
  assert.equal(
    scoreCourseQuiz(lessonModule, { q1: "missing" }).complete,
    false,
  );
});

test("reopening and reordering retain active module, playback and quiz progress by stable keys", () => {
  const saved = savedProgress();
  const restored = restoreCourseProgress(
    JSON.stringify(saved),
    [second, lessonModule],
    grant,
  );
  assert.equal(restored.activeModule, "first");
  assert.deepEqual(restored.modules.first, saved.modules.first);
  const retry = {
    ...saved,
    modules: {
      ...saved.modules,
      first: { ...saved.modules.first, answers: {}, submitted: false },
    },
  };
  assert.equal(
    restoreCourseProgress(JSON.stringify(retry), [lessonModule], grant).modules
      .first.completed,
    true,
  );
});

test("quiz edits reset only quiz progress; video replacement resets only playback", () => {
  const raw = JSON.stringify(savedProgress());
  const changedQuiz = {
    ...lessonModule,
    quiz: [{ ...lessonModule.quiz[0], prompt: "Changed question" }],
  };
  const quiz = restoreCourseProgress(raw, [changedQuiz], grant).modules.first;
  assert.equal(quiz.position, 45);
  assert.equal(quiz.submitted, false);
  assert.equal(quiz.completed, false);
  const video = restoreCourseProgress(
    raw,
    [{ ...lessonModule, video: { ...lessonModule.video, id: "new-video" } }],
    grant,
  ).modules.first;
  assert.equal(video.position, 0);
  assert.equal(video.submitted, true);
});

test("expired, corrupted and another browser's data start fresh; deleted modules disappear", () => {
  const raw = JSON.stringify(savedProgress());
  for (const text of [
    "{bad",
    "null",
    "[]",
    JSON.stringify({ ...savedProgress(), grantId: "another-browser" }),
  ]) {
    assert.equal(
      restoreCourseProgress(text, [lessonModule], grant).modules.first
        .completed,
      false,
    );
  }
  assert.equal(
    restoreCourseProgress(raw, [lessonModule], grant, grant.expiresAt * 1000)
      .modules.first.position,
    0,
  );
  const withoutFirst = restoreCourseProgress(raw, [second], grant);
  assert.equal(withoutFirst.activeModule, "second");
  assert.deepEqual(Object.keys(withoutFirst.modules), ["second"]);
  assert.notEqual(
    courseProgressKey(grant),
    courseProgressKey({ ...grant, grantId: "another-browser" }),
  );
});
