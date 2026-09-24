"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CourseVideo } from "@/components/courses/course-video";
import { confirmCourseAccess } from "@/app/actions/course";
import { Button } from "@/components/ui/button";
import { PortableTextRenderer } from "@/components/ui/portable-text-renderer";
import type { TCourseModule, TShortCourse } from "@/types";
import type { CourseAccessGrant } from "@/lib/courses/contract";
import {
  courseProgressKey,
  removeExpiredCourseProgress,
  restoreCourseProgress,
  scoreCourseQuiz,
  type CourseProgress,
  type ModuleProgress,
} from "@/lib/courses/progress";

const subscribeHydration = () => () => {};
const clientHydrated = () => true;
const serverHydrated = () => false;
type CourseProgressUpdate = (current: CourseProgress) => CourseProgress;
type ModuleProgressUpdate = (
  current: ModuleProgress,
) => Partial<ModuleProgress>;

export function CoursePlayer({
  course,
  grant,
}: {
  course: TShortCourse;
  grant: CourseAccessGrant;
}) {
  const hydrated = useSyncExternalStore(
    subscribeHydration,
    clientHydrated,
    serverHydrated,
  );
  useEffect(() => {
    let active = true;
    void confirmCourseAccess(course._id)
      .then((accepted) => {
        if (active && !accepted)
          window.location.replace(`/courses/${course.slug}?cookies=blocked`);
      })
      .catch(() => {
        /* A transient confirmation failure does not discard a valid grant. */
      });
    const timer = window.setInterval(() => {
      if (Date.now() >= grant.expiresAt * 1000) window.location.reload();
    }, 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [course._id, course.slug, grant.expiresAt]);
  if (!hydrated)
    return (
      <p role="status" className="py-10">
        Loading your course…
      </p>
    );
  return <CourseWorkspace key={grant.grantId} course={course} grant={grant} />;
}

function CourseWorkspace({
  course,
  grant,
}: {
  course: TShortCourse;
  grant: CourseAccessGrant;
}) {
  const key = courseProgressKey(grant);
  useEffect(() => {
    try {
      removeExpiredCourseProgress(localStorage);
    } catch {
      /* Storage may be disabled. */
    }
  }, []);
  const [state, setState] = useState(() => {
    try {
      return {
        progress: restoreCourseProgress(
          localStorage.getItem(key),
          course.modules,
          grant,
        ),
        storageError: false,
      };
    } catch {
      return {
        progress: restoreCourseProgress(null, course.modules, grant),
        storageError: true,
      };
    }
  });
  const stateRef = useRef(state);
  const savedProgressRef = useRef(state.progress);
  const pendingUpdatesRef = useRef<CourseProgressUpdate[]>([]);
  useEffect(() => {
    function syncProgress(event: StorageEvent) {
      if (event.key !== key && event.key !== null) return;
      // Keep unsaved in-memory progress when this tab cannot use storage.
      if (stateRef.current.storageError) return;
      try {
        if (event.storageArea !== localStorage) return;
        const shared = restoreCourseProgress(
          localStorage.getItem(key),
          course.modules,
          grant,
        );
        savedProgressRef.current = shared;
        const next = {
          progress: pendingUpdatesRef.current.reduce(
            (current, update) => update(current),
            {
              ...shared,
              // Another tab's navigation must not switch this tab's lesson.
              activeModule: stateRef.current.progress.activeModule,
            },
          ),
          storageError: false,
        };
        stateRef.current = next;
        setState(next);
      } catch {
        const next = { ...stateRef.current, storageError: true };
        stateRef.current = next;
        setState(next);
      }
    }
    window.addEventListener("storage", syncProgress);
    return () => window.removeEventListener("storage", syncProgress);
  }, [key, course.modules, grant]);
  const progress = restoreCourseProgress(
    JSON.stringify(state.progress),
    course.modules,
    grant,
  );
  const lessonModule =
    course.modules.find((item) => item._key === progress.activeModule) ??
    course.modules[0];
  const completed = course.modules.filter(
    (item) => progress.modules[item._key].completed,
  ).length;

  function save(update: CourseProgressUpdate) {
    // Controlled inputs must update synchronously, even while another tab
    // holds the write lock. Reapply pending changes over each saved snapshot.
    pendingUpdatesRef.current.push(update);
    const optimistic = {
      ...stateRef.current,
      progress: update(
        restoreCourseProgress(
          JSON.stringify(stateRef.current.progress),
          course.modules,
          grant,
        ),
      ),
    };
    stateRef.current = optimistic;
    setState(optimistic);

    function persist() {
      let current = restoreCourseProgress(
        JSON.stringify(savedProgressRef.current),
        course.modules,
        grant,
      );
      let storageError = stateRef.current.storageError;
      if (!storageError) {
        try {
          // Storage events may be delayed in background tabs. Always re-read
          // before applying this event's update, even if the UI is stale.
          const raw = localStorage.getItem(key);
          if (raw !== null)
            current = restoreCourseProgress(raw, course.modules, grant);
        } catch {
          storageError = true;
        }
      }
      const progress = update({
        ...current,
        activeModule: stateRef.current.progress.activeModule,
      });
      try {
        localStorage.setItem(key, JSON.stringify(progress));
        storageError = false;
      } catch {
        storageError = true;
      }
      savedProgressRef.current = progress;
      pendingUpdatesRef.current = pendingUpdatesRef.current.filter(
        (pending) => pending !== update,
      );
      const next = {
        progress: pendingUpdatesRef.current.reduce(
          (current, pending) => pending(current),
          progress,
        ),
        storageError,
      };
      stateRef.current = next;
      setState(next);
    }

    // Serialize the read/update/write across tabs. Older browsers and privacy
    // modes still use the latest stored snapshot when locks are unavailable.
    if (navigator.locks)
      void navigator.locks.request(key, persist).catch(persist);
    else persist();
  }
  function updateModule(update: ModuleProgressUpdate) {
    save((current) => ({
      ...current,
      modules: {
        ...current.modules,
        [lessonModule._key]: {
          ...current.modules[lessonModule._key],
          ...update(current.modules[lessonModule._key]),
        },
      },
    }));
  }

  return (
    <div className="grid gap-8 py-8 lg:grid-cols-[260px_minmax(0,1fr)] lg:gap-12">
      <aside>
        <p className="text-sm text-lh-primary" role="status">
          {completed === course.modules.length
            ? "Course complete"
            : `${completed} of ${course.modules.length} modules complete`}
        </p>
        <progress
          className="mt-3 h-2 w-full accent-lh-primary"
          value={completed}
          max={course.modules.length}
          aria-label="Course completion"
        />
        <nav aria-label="Course modules" className="mt-6 space-y-2">
          {course.modules.map((item, index) => (
            <button
              key={item._key}
              type="button"
              aria-current={
                item._key === lessonModule._key ? "step" : undefined
              }
              className={`block w-full border-l-2 px-4 py-3 text-left text-sm focus-visible:outline-2 focus-visible:outline-lh-primary ${item._key === lessonModule._key ? "border-lh-primary bg-lh-primary/5" : "border-transparent hover:bg-lh-primary/5"}`}
              onClick={() =>
                save((current) => ({ ...current, activeModule: item._key }))
              }
            >
              <span className="block text-xs uppercase tracking-widest text-lh-primary">
                Module {index + 1}
                {progress.modules[item._key].completed ? " · Complete" : ""}
              </span>
              <span className="mt-1 block">{item.title}</span>
            </button>
          ))}
        </nav>
      </aside>
      <div className="min-w-0">
        {state.storageError && (
          <p role="alert" className="mb-5 text-sm text-red-800">
            Your browser is blocking progress storage. You can use the course,
            but progress will be lost when you leave this page.
          </p>
        )}
        <h2 className="font-heading text-3xl text-lh-shadow sm:text-4xl">
          {lessonModule.title}
        </h2>
        <CourseVideo
          key={lessonModule.video.id + lessonModule._key}
          lessonModule={lessonModule}
          position={progress.modules[lessonModule._key].position}
          onPosition={(position) => updateModule(() => ({ position }))}
        />
        <div className="mt-8">
          <PortableTextRenderer content={lessonModule.lesson} />
        </div>
        {lessonModule.transcript && (
          <details className="my-6 border-y border-lh-primary/15 py-4">
            <summary className="cursor-pointer font-medium">
              Read video transcript
            </summary>
            <p className="mt-4 whitespace-pre-wrap text-sm leading-relaxed">
              {lessonModule.transcript}
            </p>
          </details>
        )}
        <CourseQuiz
          key={
            lessonModule._key + progress.modules[lessonModule._key].quizRevision
          }
          lessonModule={lessonModule}
          progress={progress.modules[lessonModule._key]}
          onChange={updateModule}
        />
      </div>
    </div>
  );
}

function CourseQuiz({
  lessonModule,
  progress,
  onChange,
}: {
  lessonModule: TCourseModule;
  progress: ModuleProgress;
  onChange: (update: ModuleProgressUpdate) => void;
}) {
  const score = scoreCourseQuiz(lessonModule, progress.answers);
  return (
    <section
      aria-labelledby="quiz-title"
      className="mt-10 border-t border-lh-primary/20 pt-8"
    >
      <h3 id="quiz-title" className="font-heading text-2xl text-lh-shadow">
        Check your understanding
      </h3>
      <p className="mt-2 text-sm">
        Practice at your own pace. Every attempt counts toward completion.
      </p>
      <form
        className="mt-6 space-y-7"
        onSubmit={(event) => {
          event.preventDefault();
          onChange((current) =>
            scoreCourseQuiz(lessonModule, current.answers).complete
              ? { submitted: true, completed: true }
              : {},
          );
        }}
      >
        {lessonModule.quiz.map((question, index) => (
          <fieldset
            key={question._key}
            className="space-y-3"
            disabled={progress.submitted}
          >
            <legend className="mb-3 font-medium">
              {index + 1}. {question.prompt}
            </legend>
            {question.options.map((option) => (
              <label
                key={option._key}
                className="flex cursor-pointer items-start gap-3 border border-lh-primary/15 p-3 text-sm has-[:checked]:border-lh-primary has-[:checked]:bg-lh-primary/5"
              >
                <input
                  className="mt-0.5 accent-lh-primary"
                  type="radio"
                  name={question._key}
                  value={option._key}
                  required
                  checked={progress.answers[question._key] === option._key}
                  onChange={() =>
                    onChange((current) =>
                      current.submitted
                        ? {}
                        : {
                            answers: {
                              ...current.answers,
                              [question._key]: option._key,
                            },
                          },
                    )
                  }
                />
                <span>{option.text}</span>
              </label>
            ))}
            {progress.submitted && (
              <div className="bg-lh-primary/5 p-4 text-sm leading-relaxed">
                <p className="font-medium">
                  {question.options.find(
                    (option) => option._key === progress.answers[question._key],
                  )?.isCorrect
                    ? "Correct."
                    : `Correct answer: ${question.options.find((option) => option.isCorrect)?.text}`}
                </p>
                <p className="mt-1">{question.explanation}</p>
              </div>
            )}
          </fieldset>
        ))}
        {progress.submitted ? (
          <div>
            <p role="status" className="mb-4">
              {score.correct} of {score.total} correct. Module complete.
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                onChange(() => ({ answers: {}, submitted: false }))
              }
            >
              Try quiz again
            </Button>
          </div>
        ) : (
          <Button type="submit">Check answers</Button>
        )}
      </form>
    </section>
  );
}
