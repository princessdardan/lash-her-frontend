import assert from "node:assert/strict";
import test from "node:test";

import type {
  LessonProgress,
  StudentCourseDetail,
  StudentLesson,
} from "@/lib/course-api/contracts";
import type { StudentCourseClient } from "@/lib/course-api/student-client";
import { AcademyCourseApiError } from "./course-api";
import { createAcademyCourseApi } from "./course-api-adapter";

const courseId = "course-1";
const lessonId = "lesson-1";
const moduleId = "module-1";

test("lesson detail is not requested when the lesson is outside the enrolled course", async () => {
  let lessonCalls = 0;
  const api = createAcademyCourseApi({
    createClient: () =>
      createClient({
        course: createCourse({ lessonIds: ["different-lesson"] }),
        getLesson: async () => {
          lessonCalls += 1;
          return createLesson();
        },
      }),
  });

  await assertNotFound(
    api.getLesson({ courseId, lessonId, userId: "student-1" }),
  );
  assert.equal(lessonCalls, 0);
});

test("playback is not minted when the lesson is outside the enrolled course", async () => {
  let playbackCalls = 0;
  const api = createAcademyCourseApi({
    createClient: () =>
      createClient({
        course: createCourse({ lessonIds: ["different-lesson"] }),
        getPlayback: async () => {
          playbackCalls += 1;
          return createPlayback();
        },
      }),
  });

  await assertNotFound(
    api.getPlayback({ courseId, lessonId, userId: "student-1" }),
  );
  assert.equal(playbackCalls, 0);
});

test("a mismatched course response cannot authorize a matching lesson id", async () => {
  let playbackCalls = 0;
  const api = createAcademyCourseApi({
    createClient: () =>
      createClient({
        course: { ...createCourse(), id: "different-course" },
        getPlayback: async () => {
          playbackCalls += 1;
          return createPlayback();
        },
      }),
  });

  await assertNotFound(
    api.getPlayback({ courseId, lessonId, userId: "student-1" }),
  );
  assert.equal(playbackCalls, 0);
});

test("progress is not written when the lesson is outside the enrolled course", async () => {
  let progressCalls = 0;
  const api = createAcademyCourseApi({
    createClient: () =>
      createClient({
        course: createCourse({ lessonIds: ["different-lesson"] }),
        recordProgress: async () => {
          progressCalls += 1;
          return createProgress();
        },
      }),
  });

  await assertNotFound(
    api.updateProgress({
      courseId,
      lessonId,
      progress: { completed: true },
      userId: "student-1",
    }),
  );
  assert.equal(progressCalls, 0);
});

test("lesson detail rejects a response whose module does not match the enrolled course", async () => {
  const api = createAcademyCourseApi({
    createClient: () =>
      createClient({
        course: createCourse(),
        getLesson: async () => createLesson({ moduleId: "different-module" }),
      }),
  });

  await assertNotFound(
    api.getLesson({ courseId, lessonId, userId: "student-1" }),
  );
});

test("matching course and lesson IDs permit lesson, playback, and progress operations", async () => {
  const calls: string[] = [];
  const client = createClient({
    course: createCourse(),
    getLesson: async () => {
      calls.push("lesson");
      return createLesson();
    },
    getPlayback: async () => {
      calls.push("playback");
      return createPlayback();
    },
    recordProgress: async () => {
      calls.push("progress");
      return createProgress();
    },
  });
  const api = createAcademyCourseApi({ createClient: () => client });

  const lesson = await api.getLesson({
    courseId,
    lessonId,
    userId: "student-1",
  });
  const playback = await api.getPlayback({
    courseId,
    lessonId,
    userId: "student-1",
  });
  const progress = await api.updateProgress({
    courseId,
    lessonId,
    progress: { positionSeconds: 30 },
    userId: "student-1",
  });

  assert.equal(lesson.id, lessonId);
  assert.equal(playback.playbackId, "playback-1");
  assert.deepEqual(progress, { completed: false, positionSeconds: 30 });
  assert.deepEqual(calls, ["lesson", "playback", "progress"]);
});

async function assertNotFound(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) =>
      error instanceof AcademyCourseApiError && error.code === "NOT_FOUND",
  );
}

function createClient(
  overrides: {
    course?: StudentCourseDetail;
    getLesson?: StudentCourseClient["getLesson"];
    getPlayback?: StudentCourseClient["getPlayback"];
    recordProgress?: StudentCourseClient["recordProgress"];
  } = {},
): StudentCourseClient {
  return {
    getCourse: async () => overrides.course ?? createCourse(),
    getLesson: overrides.getLesson ?? (async () => createLesson()),
    getPlayback: overrides.getPlayback ?? (async () => createPlayback()),
    listProgress: async () => [],
    recordProgress: overrides.recordProgress ?? (async () => createProgress()),
  };
}

function createCourse({
  lessonIds = [lessonId],
}: { lessonIds?: string[] } = {}): StudentCourseDetail {
  return {
    currency: "USD",
    description: null,
    id: courseId,
    modules: [
      {
        description: null,
        id: moduleId,
        lessons: lessonIds.map((id, position) =>
          createLesson({ id, position }),
        ),
        position: 0,
        slug: "module-one",
        title: "Module one",
      },
    ],
    priceCents: 100,
    slug: "course-one",
    title: "Course one",
  };
}

function createLesson(overrides: Partial<StudentLesson> = {}): StudentLesson {
  return {
    content: "Lesson content",
    id: lessonId,
    isPreview: false,
    moduleId,
    position: 0,
    slug: "lesson-one",
    title: "Lesson one",
    ...overrides,
  };
}

function createPlayback() {
  return {
    expiresAt: "2026-08-07T12:00:00.000Z",
    playbackId: "playback-1",
    playbackToken: "playback-token",
  };
}

function createProgress(): LessonProgress {
  return {
    completedAt: null,
    createdAt: "2026-08-07T10:00:00.000Z",
    enrollmentId: "enrollment-1",
    id: "progress-1",
    lastWatchedAt: "2026-08-07T10:00:00.000Z",
    lessonId,
    maxPositionSeconds: 30,
    updatedAt: "2026-08-07T10:00:00.000Z",
    userId: "student-1",
  };
}
