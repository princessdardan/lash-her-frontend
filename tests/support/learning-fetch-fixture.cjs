/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";
const { createHmac, randomUUID } = require("node:crypto");
if (process.env.LEARNING_E2E_FIXTURE === "1") {
  if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(new URL(process.env.DATABASE_URL).hostname)) throw new Error("Learning fixture requires local test DB and development runtime");
  const originalFetch = globalThis.fetch;
  const courseId = "a1111111-1111-4111-8111-111111111111", moduleId = "a2222222-2222-4222-8222-222222222222", lessonId = "a3333333-3333-4333-8333-333333333333";
  const users = new Map();
  const lesson = { id: lessonId, moduleId, slug: "the-basics", title: "The basics", content: "PRIVATE_LEARNING_CONTENT", contentDocument: null, transcript: "A gentle approach protects the natural lash.", captions: [{ language: "en", label: "English", url: "https://learning-media.example.invalid/captions.vtt" }], isPreview: false, position: 1 };
  const course = { id: courseId, slug: "learning-fixture", title: "Lash foundations", description: "An introduction to intentional lash care.", introduction: "Build a careful, confident practice.", cover: null, seo: null, priceCents: 0, currency: "CAD", accessMode: "free" };
  const fullCourse = { ...course, modules: [{ id: moduleId, slug: "foundations", title: "Foundations", description: null, position: 1, lessons: [lesson] }] };
  const publicCourse = { ...fullCourse, modules: fullCourse.modules.map(module => ({ ...module, lessons: [] })) };
  const questions = [{ id: "q1", prompt: "Which approach protects the natural lash?", options: [{ id: "gentle", text: "Use gentle care" }, { id: "pull", text: "Pull the extensions" }] }, { id: "q2", prompt: "When can you revisit the lesson?", options: [{ id: "anytime", text: "At your own pace" }, { id: "never", text: "Only once" }] }];
  const quiz = { id: "a4444444-4444-4444-8444-444444444444", lessonId, revision: 1, document: { version: 1, mode: "graded", passingPercent: 80, questions } };
  const json = (body, status = 200) => Response.json(body, { status, headers: { "x-request-id": randomUUID(), "cache-control": "private, no-store" } });
  const deny = (code, status) => json({ error: { code, message: "Synthetic receiver response" } }, status);
  globalThis.fetch = async function learningFetch(input, init) {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.hostname.endsWith(".api.sanity.io") || url.hostname.endsWith(".apicdn.sanity.io")) {
      const query = url.searchParams.get("query") || "";
      return json({ result: query.includes('"globalSettings"') ? { title: "LASH HER", header: { logoText: { label: "LASH HER", href: "/" }, ctaButton: [{ _key: "book", label: "Book now", href: "/contact" }] }, footer: { logoText: { label: "LASH HER", href: "/" }, navigationMenus: [], socialLink: [] }, contactPopup: { enabled: false } } : query.includes('"mainMenu"') ? { items: [] } : null, query, ms: 1 });
    }
    if (url.hostname === "api.resend.com" || url.hostname.includes("google")) throw new Error("Learning fixture must not call providers");
    if (url.origin !== "https://learning-gateway.example.invalid") return originalFetch(input, init);
    const path = url.pathname.replace(/^\/course/, ""), method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    if (!headers.get("x-lash-workload-token")) return deny("UNAUTHORIZED", 401);
    if (path === "/v1/courses") return json({ courses: [course], nextCursor: null });
    if (path === "/v1/courses/learning-fixture") return json({ course: publicCourse });
    const token = headers.get("authorization")?.replace(/^Bearer /, "");
    if (!token) return deny("UNAUTHORIZED", 401);
    const [header, payload, signature] = token.split(".");
    if (createHmac("sha256", process.env.COURSE_LEARNER_JWT_CURRENT_SECRET).update(`${header}.${payload}`).digest("base64url") !== signature) return deny("UNAUTHORIZED", 401);
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (claims.aud !== "lash-her-course-api:learner" || claims.exp < Date.now() / 1000 || "email" in claims) return deny("UNAUTHORIZED", 401);
    if (!users.has(claims.sub)) users.set(claims.sub, { grant: null, keys: new Map(), progress: null, attempts: [] });
    const state = users.get(claims.sub), body = init?.body ? JSON.parse(init.body) : {};
    if (path === `/v1/student/courses/${courseId}/enrollments` && method === "POST") {
      if (headers.get("x-idempotency-key") !== body.idempotencyKey) return deny("INVALID_REQUEST", 400);
      const replay = state.keys.has(body.idempotencyKey); state.grant ??= randomUUID();
      const result = { grantId: state.grant, enrollmentId: null, courseId, source: "free", status: "active", idempotentReplay: replay };
      state.keys.set(body.idempotencyKey, result); return json(result, replay ? 200 : 201);
    }
    if (path === "/v1/student/courses") return json({ courses: state.grant ? [{ id: courseId, slug: course.slug, title: course.title, description: course.description, status: "published", progress: { totalLessons: 1, completedLessons: state.progress?.completedAt ? 1 : 0, percentComplete: state.progress?.completedAt ? 100 : 0, lastActivityAt: state.progress?.lastWatchedAt ?? null, continueLessonId: lessonId, continuePositionSeconds: state.progress?.resumePositionSeconds ?? 0 } }] : [] });
    if (!state.grant) return deny("ACTIVE_ENROLLMENT_REQUIRED", 403);
    if (path === `/v1/student/courses/${courseId}` || path === `/v1/student/courses/${courseId}/lessons`) return json({ course: fullCourse });
    if (path === `/v1/student/lessons/${lessonId}`) return json({ lesson });
    if (path === "/v1/student/progress") return json({ progress: state.progress ? [state.progress] : [] });
    if (path.endsWith("/progress") && method === "POST") {
      if (body.expectedProgressRevision !== (state.progress?.revision ?? 0)) return deny("PROGRESS_REVISION_CONFLICT", 409);
      if (body.event === "lesson_completed") return deny("QUIZ_COMPLETION_REQUIRED", 409);
      const now = new Date().toISOString();
      state.progress = { id: state.progress?.id ?? randomUUID(), userId: claims.sub, lessonId, enrollmentId: null, revision: (state.progress?.revision ?? 0) + 1, resumePositionSeconds: body.resumePositionSeconds ?? state.progress?.resumePositionSeconds ?? 0, maxPositionSeconds: Math.max(body.maxPositionSeconds ?? 0, state.progress?.maxPositionSeconds ?? 0), completedQuizRevision: state.progress?.completedQuizRevision ?? null, completedAt: state.progress?.completedAt ?? null, createdAt: state.progress?.createdAt ?? now, updatedAt: now, lastWatchedAt: now }; return json({ progress: state.progress });
    }
    if (path.endsWith("/playback")) {
      const makeToken = aud => `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: "learningSignedPlayback", aud, exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url")}.fixture`;
      const expiresAt = new Date(Date.now() + 600_000).toISOString(); return json({ playbackId: "learningSignedPlayback", playbackToken: makeToken("v"), thumbnailToken: makeToken("t"), expiresAt, thumbnailExpiresAt: expiresAt });
    }
    if (path.endsWith("/quiz")) return json({ quiz });
    if (path.endsWith("/quiz/attempts") && method === "GET") return json({ attempts: state.attempts });
    if (path.endsWith("/quiz/attempts") && method === "POST") {
      if (body.quizRevision !== 1) return deny("QUIZ_REVISION_CONFLICT", 409);
      const previous = state.attempts.find(attempt => attempt.id === body.requestId); if (previous) return json({ attempt: previous });
      const results = questions.map((question, index) => { const selectedOptionId = body.answers.find(answer => answer.questionId === question.id)?.optionId; const correctOptionId = index === 0 ? "gentle" : "anytime"; return { questionId: question.id, selectedOptionId, correctOptionId, correct: selectedOptionId === correctOptionId, feedback: "Careful, consistent practice supports healthy lashes." }; });
      const correctCount = results.filter(result => result.correct).length, passed = correctCount === 2;
      const attempt = { id: body.requestId, lessonId, quizRevisionId: quiz.id, quizRevision: 1, mode: "graded", passingPercent: 80, answers: body.answers, correctCount, totalCount: 2, passed, completed: passed, results, createdAt: new Date().toISOString() }; state.attempts.unshift(attempt);
      if (passed && state.progress) state.progress = { ...state.progress, revision: state.progress.revision + 1, completedAt: attempt.createdAt, completedQuizRevision: 1 };
      return json({ attempt });
    }
    return deny("NOT_FOUND", 404);
  };
}
