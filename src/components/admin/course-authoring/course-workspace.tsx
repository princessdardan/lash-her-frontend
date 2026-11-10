"use client";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import {
  authoringRequest,
  AuthoringRequestError,
} from "@/lib/course-authoring/browser";
import { courseUpdateInput } from "@/lib/course-authoring/forms";
import type { AuthoringCourse } from "@/lib/course-authoring/types";
import { buttonClass, CourseFields, secondaryClass } from "./course-fields";
import { LessonForm, ModuleForm, type SaveAuthoring } from "./curriculum-forms";
import { QuizEditor } from "./quiz-editor";
import { MediaEditor } from "./media-editor";

type View =
  | { kind: "details" }
  | { kind: "module"; id?: string }
  | { kind: "lesson"; moduleId: string; id?: string }
  | { kind: "quiz"; lessonId: string }
  | { kind: "media"; lessonId: string };
interface Readiness {
  courseId: string;
  courseRevision: number;
  ready: boolean;
  issues: { code: string; field: string; message: string; lessonId?: string }[];
}
export function CourseWorkspace({
  initialCourse,
}: {
  initialCourse: AuthoringCourse;
}) {
  const [course, setCourse] = useState(initialCourse),
    [view, setView] = useState<View>({ kind: "details" }),
    [pending, setPending] = useState(false),
    [feedback, setFeedback] = useState<{
      message: string;
      failed: boolean;
    } | null>(null),
    [readiness, setReadiness] = useState<Readiness | null>(null);
  const editable = course.status === "draft";
  const [dirty, setDirty] = useState(false);
  const [reviewPaidArchive, setReviewPaidArchive] = useState(false);
  useEffect(() => {
    if (!dirty) return;
    const preventLoss = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [dirty]);
  function discardDraft() {
    if (dirty && !window.confirm("Discard unsaved changes in the open editor?"))
      return false;
    setDirty(false);
    return true;
  }
  function chooseView(next: View) {
    if (discardDraft()) setView(next);
  }

  async function reloadCourse() {
    const result = await authoringRequest<{ course: AuthoringCourse }>(
      `/api/admin/courses/${course.id}`,
    );
    setCourse(result.course);
    setDirty(false);
    setReadiness(null);
  }
  const save: SaveAuthoring = async (path, method, body, message) => {
    if (pending) return false;
    setPending(true);
    setFeedback(null);
    try {
      await authoringRequest(path, method, body);
      const result = await authoringRequest<{ course: AuthoringCourse }>(
        `/api/admin/courses/${course.id}`,
      );
      setCourse(result.course);
      setDirty(false);
      setReadiness(null);
      setFeedback({ message, failed: false });
      return true;
    } catch (error) {
      setFeedback({
        message:
          error instanceof AuthoringRequestError && error.requestId
            ? `${error.message} Reference: ${error.requestId}`
            : error instanceof Error
              ? error.message
              : "Changes could not be confirmed.",
        failed: true,
      });
      return false;
    } finally {
      setPending(false);
    }
  };
  const discardThenSave: SaveAuthoring = async (...args) =>
    discardDraft() ? save(...args) : false;
  async function details(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await save(
        `/api/admin/courses/${course.id}`,
        "PATCH",
        courseUpdateInput(form, course.revision),
        "Course details saved.",
      );
    } catch (error) {
      setFeedback({
        message: error instanceof Error ? error.message : "Check the fields.",
        failed: true,
      });
    }
  }
  async function review() {
    if (pending) return;
    setPending(true);
    setFeedback(null);
    try {
      setReadiness(
        await authoringRequest<Readiness>(
          `/api/admin/courses/${course.id}/publication-readiness`,
        ),
      );
    } catch (error) {
      setFeedback({
        message:
          error instanceof Error
            ? error.message
            : "Readiness could not be checked.",
        failed: true,
      });
    } finally {
      setPending(false);
    }
  }
  function reorder(
    kind: "module" | "lesson",
    parentId: string,
    ids: string[],
    index: number,
    offset: number,
  ) {
    if (!discardDraft()) return;
    const next = [...ids];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    void save(
      kind === "module"
        ? `/api/admin/courses/${parentId}/modules/reorder`
        : `/api/admin/modules/${parentId}/lessons/reorder`,
      "POST",
      { expectedCourseRevision: course.revision, ids: next },
      "Curriculum order saved.",
    );
  }
  const selectedModule =
    view.kind === "module"
      ? course.modules.find((item) => item.id === view.id)
      : undefined;
  const lessonModule =
    view.kind === "lesson"
      ? course.modules.find((item) => item.id === view.moduleId)
      : undefined;
  const selectedLesson =
    view.kind === "lesson"
      ? lessonModule?.lessons.find((item) => item.id === view.id)
      : undefined;
  return (
    <div className="space-y-7">
      <header>
        <Link
          href="/admin/courses"
          onClick={(event) => {
            if (!discardDraft()) event.preventDefault();
          }}
          className="text-sm text-lh-primary underline underline-offset-4"
        >
          All courses
        </Link>
        <h1 className="mt-4 break-words font-heading text-4xl uppercase tracking-wide sm:text-5xl">
          {course.title}
        </h1>
        <p className="mt-2 text-sm text-lh-muted">
          {course.status} · Revision {course.revision}
        </p>
      </header>
      {feedback && (
        <div
          role={feedback.failed ? "alert" : "status"}
          className="rounded-xl border border-lh-line bg-white p-4 text-sm"
        >
          <p>{feedback.message}</p>
          {feedback.failed && (
            <p className="mt-2">
              <a
                href={`/admin/courses/${course.id}`}
                className="text-lh-primary underline"
              >
                Reload current course
              </a>{" "}
              (discards unsaved edits).
            </p>
          )}
        </div>
      )}
      <section
        aria-labelledby="publication-heading"
        className="space-y-4 rounded-2xl border border-lh-line bg-white p-5 sm:p-6"
      >
        <h2
          id="publication-heading"
          className="font-heading text-3xl uppercase tracking-wide"
        >
          Publication
        </h2>
        <p className="text-sm text-lh-muted">
          Review current content, media and assessments before publishing.
          Publication checks run again when you publish.
        </p>
        <div className="flex flex-wrap gap-3">
          <button
            className={secondaryClass}
            disabled={pending}
            onClick={review}
          >
            Review publication readiness
          </button>
          {course.status !== "draft" && (
            <button
              className={secondaryClass}
              disabled={pending}
              onClick={() => {
                void discardThenSave(
                  `/api/admin/courses/${course.id}`,
                  "PATCH",
                  { expectedRevision: course.revision, status: "draft" },
                  "Course moved to draft.",
                );
              }}
            >
              Move to draft
            </button>
          )}
          {course.status !== "archived" && (
            <button
              className={secondaryClass}
              disabled={pending}
              onClick={() => {
                if (course.accessMode === "paid") {
                  setReviewPaidArchive(true);
                  return;
                }
                void discardThenSave(
                  `/api/admin/courses/${course.id}`,
                  "PATCH",
                  { expectedRevision: course.revision, status: "archived" },
                  "Course archived. Historical references remain available.",
                );
              }}
            >
              Archive course
            </button>
          )}
        </div>
        {reviewPaidArchive &&
          course.accessMode === "paid" &&
          course.status !== "archived" && (
            <section
              aria-labelledby="paid-archive-heading"
              className="space-y-3 border border-lh-primary/30 bg-lh-primary/5 p-4 text-sm"
            >
              <h3 id="paid-archive-heading" className="font-medium">
                Before archiving this paid course
              </h3>
              <p>
                Archiving denies protected lessons, new playback, assessments
                and progress updates, including access from existing purchases.
                Already issued video access may continue for up to 600 seconds.
              </p>
              <p>
                Course and lesson identifiers, independent grants, progress and
                assessment and audit history remain. Community access depends on
                remaining eligible courses and grants.
              </p>
              <p>
                Archiving does not issue a refund or cancel a payment. Support
                and refund requests follow existing applicable terms and owner
                review.
              </p>
              <p>
                Restoring access requires an explicit republish that passes
                current publication checks. Republish cannot override revoked or
                expired grants, suspension or account deletion.
              </p>
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  className={secondaryClass}
                  disabled={pending}
                  onClick={() => setReviewPaidArchive(false)}
                >
                  Cancel archive
                </button>
                <button
                  type="button"
                  className={buttonClass}
                  disabled={pending}
                  onClick={() => {
                    void discardThenSave(
                      `/api/admin/courses/${course.id}`,
                      "PATCH",
                      { expectedRevision: course.revision, status: "archived" },
                      "Course archived. Historical references remain available.",
                    ).then((saved) => {
                      if (saved) setReviewPaidArchive(false);
                    });
                  }}
                >
                  Archive paid course
                </button>
              </div>
            </section>
          )}
        {dirty && (
          <p className="text-sm text-lh-muted">
            Save the open editor before publishing.
          </p>
        )}
        {readiness && (
          <div role="status" className="space-y-3">
            <p className="font-medium">
              {readiness.ready
                ? "Ready to publish"
                : "Resolve these items before publishing"}
            </p>
            {readiness.issues.length > 0 && (
              <ul className="list-disc space-y-2 pl-5 text-sm">
                {readiness.issues.map((issue, index) => (
                  <li key={`${issue.code}-${index}`}>
                    {issue.message}
                    {issue.lessonId && (
                      <span className="block text-xs text-lh-muted">
                        Lesson:{" "}
                        {course.modules
                          .flatMap((module) => module.lessons)
                          .find((lesson) => lesson.id === issue.lessonId)
                          ?.title ?? "Unavailable lesson"}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {readiness.ready && course.status === "draft" && (
              <button
                className={buttonClass}
                disabled={
                  pending ||
                  dirty ||
                  readiness.courseRevision !== course.revision
                }
                onClick={() => {
                  void discardThenSave(
                    `/api/admin/courses/${course.id}`,
                    "PATCH",
                    {
                      expectedRevision: readiness.courseRevision,
                      status: "published",
                    },
                    "Course published.",
                  );
                }}
              >
                Publish course
              </button>
            )}
          </div>
        )}
      </section>
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(16rem,1fr)_minmax(0,2fr)]">
        <section
          aria-labelledby="curriculum-heading"
          className="space-y-4 rounded-2xl border border-lh-line bg-white p-5"
        >
          <h2
            id="curriculum-heading"
            className="font-heading text-3xl uppercase tracking-wide"
          >
            Curriculum
          </h2>
          <div className="flex flex-wrap gap-2">
            <button
              className={secondaryClass}
              disabled={pending}
              onClick={() => chooseView({ kind: "details" })}
            >
              Course details
            </button>
            <button
              className={secondaryClass}
              disabled={!editable || pending}
              onClick={() => chooseView({ kind: "module" })}
            >
              Add module
            </button>
          </div>
          <p className="text-xs text-lh-muted">
            Save the open editor before choosing another item. Courses must be
            draft to edit.
          </p>
          <ol className="space-y-4">
            {course.modules.map((module, moduleIndex) => (
              <li
                key={module.id}
                className="space-y-3 border-t border-lh-line pt-4"
              >
                <h3 className="font-semibold">
                  {module.title}
                  {module.archivedAt ? " (archived)" : ""}
                </h3>
                <div className="flex flex-wrap gap-2">
                  <button
                    className={secondaryClass}
                    disabled={!editable || pending}
                    onClick={() =>
                      chooseView({ kind: "module", id: module.id })
                    }
                  >
                    Edit module
                  </button>
                  <button
                    className={secondaryClass}
                    disabled={!editable || pending || !!module.archivedAt}
                    onClick={() =>
                      chooseView({ kind: "lesson", moduleId: module.id })
                    }
                  >
                    Add lesson
                  </button>
                  <button
                    className={secondaryClass}
                    disabled={!editable || pending}
                    onClick={() => {
                      void discardThenSave(
                        `/api/admin/modules/${module.id}`,
                        "PATCH",
                        {
                          expectedCourseRevision: course.revision,
                          archived: !module.archivedAt,
                        },
                        module.archivedAt
                          ? "Module restored."
                          : "Module archived.",
                      );
                    }}
                  >
                    {module.archivedAt ? "Restore" : "Archive"}
                  </button>
                  <button
                    className={secondaryClass}
                    aria-label={`Move module ${module.title} up`}
                    disabled={!editable || pending || moduleIndex === 0}
                    onClick={() =>
                      reorder(
                        "module",
                        course.id,
                        course.modules.map((item) => item.id),
                        moduleIndex,
                        -1,
                      )
                    }
                  >
                    Up
                  </button>
                  <button
                    className={secondaryClass}
                    aria-label={`Move module ${module.title} down`}
                    disabled={
                      !editable ||
                      pending ||
                      moduleIndex === course.modules.length - 1
                    }
                    onClick={() =>
                      reorder(
                        "module",
                        course.id,
                        course.modules.map((item) => item.id),
                        moduleIndex,
                        1,
                      )
                    }
                  >
                    Down
                  </button>
                </div>
                <ol className="space-y-4 pl-3">
                  {module.lessons.map((lesson, index) => (
                    <li
                      key={lesson.id}
                      data-lesson-id={lesson.id}
                      className="space-y-2 border-l border-lh-line pl-3"
                    >
                      <h4 className="text-sm font-semibold">
                        {lesson.title}
                        {lesson.archivedAt ? " (archived)" : ""}
                      </h4>
                      <div className="flex flex-wrap gap-2">
                        <button
                          className={secondaryClass}
                          disabled={!editable || pending}
                          onClick={() =>
                            chooseView({
                              kind: "lesson",
                              moduleId: module.id,
                              id: lesson.id,
                            })
                          }
                        >
                          Edit lesson
                        </button>
                        <button
                          className={secondaryClass}
                          disabled={
                            !editable ||
                            pending ||
                            !!lesson.archivedAt ||
                            !!module.archivedAt
                          }
                          onClick={() =>
                            chooseView({ kind: "quiz", lessonId: lesson.id })
                          }
                        >
                          Assessment
                        </button>
                        <button
                          type="button"
                          className={secondaryClass}
                          disabled={
                            pending ||
                            !!lesson.archivedAt ||
                            !!module.archivedAt
                          }
                          onClick={() =>
                            chooseView({ kind: "media", lessonId: lesson.id })
                          }
                        >
                          Video and captions
                        </button>
                        <button
                          className={secondaryClass}
                          disabled={!editable || pending}
                          onClick={() => {
                            void discardThenSave(
                              `/api/admin/lessons/${lesson.id}`,
                              "PATCH",
                              {
                                expectedCourseRevision: course.revision,
                                archived: !lesson.archivedAt,
                              },
                              lesson.archivedAt
                                ? "Lesson restored."
                                : "Lesson archived.",
                            );
                          }}
                        >
                          {lesson.archivedAt ? "Restore" : "Archive"}
                        </button>
                        <button
                          className={secondaryClass}
                          aria-label={`Move lesson ${lesson.title} up`}
                          disabled={!editable || pending || index === 0}
                          onClick={() =>
                            reorder(
                              "lesson",
                              module.id,
                              module.lessons.map((item) => item.id),
                              index,
                              -1,
                            )
                          }
                        >
                          Up
                        </button>
                        <button
                          className={secondaryClass}
                          aria-label={`Move lesson ${lesson.title} down`}
                          disabled={
                            !editable ||
                            pending ||
                            index === module.lessons.length - 1
                          }
                          onClick={() =>
                            reorder(
                              "lesson",
                              module.id,
                              module.lessons.map((item) => item.id),
                              index,
                              1,
                            )
                          }
                        >
                          Down
                        </button>
                      </div>
                    </li>
                  ))}
                </ol>
              </li>
            ))}
          </ol>
          {!course.modules.length && (
            <p className="text-sm text-lh-muted">
              This draft has no modules yet.
            </p>
          )}
        </section>
        <section
          aria-label="Open course editor"
          onChange={() => setDirty(true)}
          onClick={(event) => {
            if (
              view.kind !== "media" &&
              event.target instanceof HTMLElement &&
              event.target.closest("button[type=button]")
            )
              setDirty(true);
          }}
          className="min-w-0 rounded-2xl border border-lh-line bg-white p-5 sm:p-6"
          key={`${JSON.stringify(view)}-${course.revision}`}
        >
          {view.kind === "media" ? (
            <MediaEditor
              lessonId={view.lessonId}
              revision={course.revision}
              editable={editable}
              onBusy={setPending}
              onChanged={reloadCourse}
            />
          ) : !editable ? (
            <p className="text-sm text-lh-muted">
              Move this course to draft before editing.
            </p>
          ) : view.kind === "details" ? (
            <form className="space-y-5" onSubmit={details}>
              <fieldset disabled={pending}>
                <legend className="mb-4 font-heading text-3xl uppercase">
                  Course details
                </legend>
                <CourseFields course={course} />
              </fieldset>
              <button type="submit" className={buttonClass} disabled={pending}>
                Save course details
              </button>
            </form>
          ) : view.kind === "module" ? (
            <ModuleForm
              courseId={course.id}
              revision={course.revision}
              module={selectedModule}
              defaultPosition={Math.min(
                2147483647,
                Math.max(0, ...course.modules.map((item) => item.position)) + 1,
              )}
              pending={pending}
              save={save}
            />
          ) : view.kind === "lesson" ? (
            <LessonForm
              moduleId={view.moduleId}
              revision={course.revision}
              lesson={selectedLesson}
              defaultPosition={Math.min(
                2147483647,
                Math.max(
                  0,
                  ...(lessonModule?.lessons.map((item) => item.position) ?? []),
                ) + 1,
              )}
              pending={pending}
              save={save}
            />
          ) : (
            <QuizEditor
              key={view.lessonId}
              lessonId={view.lessonId}
              revision={course.revision}
              pending={pending}
              save={save}
            />
          )}
        </section>
      </div>
    </div>
  );
}
