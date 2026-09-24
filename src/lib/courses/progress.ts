import type { TCourseModule } from "@/types";
import type { CourseAccessGrant } from "./contract";

export interface ModuleProgress {
  videoId: string;
  position: number;
  quizRevision: string;
  answers: Record<string, string>;
  submitted: boolean;
  completed: boolean;
}

export interface CourseProgress {
  version: 1;
  grantId: string;
  expiresAt: number;
  activeModule: string;
  modules: Record<string, ModuleProgress>;
}

export function courseProgressKey(grant: CourseAccessGrant): string {
  return `lh_course_progress:${grant.courseId}:${grant.grantId}`;
}

export function scoreCourseQuiz(
  lessonModule: TCourseModule,
  answers: Record<string, string>,
) {
  let correct = 0;
  let answered = 0;
  for (const question of lessonModule.quiz) {
    const option = question.options.find(
      (item) => item._key === answers[question._key],
    );
    if (option) answered++;
    if (option?.isCorrect) correct++;
  }
  return {
    correct,
    total: lessonModule.quiz.length,
    complete:
      lessonModule.quiz.length > 0 && answered === lessonModule.quiz.length,
  };
}

export function restoreCourseProgress(
  raw: string | null,
  modules: TCourseModule[],
  grant: CourseAccessGrant,
  now = Date.now(),
): CourseProgress {
  let saved: Partial<CourseProgress> = {};
  try {
    const parsed = raw && raw.length < 1_000_000 ? JSON.parse(raw) : null;
    if (
      parsed?.version === 1 &&
      parsed.grantId === grant.grantId &&
      parsed.expiresAt === grant.expiresAt &&
      grant.expiresAt * 1000 > now
    )
      saved = parsed;
  } catch {
    /* Corrupt or older storage should not prevent access. */
  }
  const currentModules: Record<string, ModuleProgress> = {};
  for (const lessonModule of modules) {
    const previous = saved.modules?.[lessonModule._key];
    const quizRevision = JSON.stringify(lessonModule.quiz);
    const answers: Record<string, string> = {};
    if (previous?.quizRevision === quizRevision) {
      for (const question of lessonModule.quiz) {
        const answer = previous.answers?.[question._key];
        if (
          typeof answer === "string" &&
          question.options.some((option) => option._key === answer)
        )
          answers[question._key] = answer;
      }
    }
    currentModules[lessonModule._key] = {
      videoId: lessonModule.video.id,
      position:
        previous?.videoId === lessonModule.video.id &&
        Number.isFinite(previous.position) &&
        previous.position >= 0
          ? previous.position
          : 0,
      quizRevision,
      answers,
      submitted:
        previous?.quizRevision === quizRevision &&
        previous.submitted === true &&
        scoreCourseQuiz(lessonModule, answers).complete,
      completed:
        previous?.quizRevision === quizRevision && previous.completed === true,
    };
  }
  return {
    version: 1,
    grantId: grant.grantId,
    expiresAt: grant.expiresAt,
    activeModule: modules.some(
      (lessonModule) => lessonModule._key === saved.activeModule,
    )
      ? saved.activeModule!
      : (modules[0]?._key ?? ""),
    modules: currentModules,
  };
}

export function removeExpiredCourseProgress(
  storage: Storage,
  now = Date.now(),
): void {
  for (let index = storage.length - 1; index >= 0; index--) {
    const key = storage.key(index);
    if (!key?.startsWith("lh_course_progress:")) continue;
    try {
      const value = JSON.parse(storage.getItem(key) ?? "null");
      if (!Number.isFinite(value?.expiresAt) || value.expiresAt * 1000 <= now)
        storage.removeItem(key);
    } catch {
      storage.removeItem(key);
    }
  }
}
