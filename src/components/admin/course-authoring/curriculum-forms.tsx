"use client";
import { useState, type FormEvent } from "react";
import { textField } from "@/lib/course-authoring/forms";
import type {
  AuthoringLesson,
  AuthoringModule,
  ContentDocument,
} from "@/lib/course-authoring/types";
import { ContentEditor } from "./content-editor";
import { buttonClass, fieldClass } from "./course-fields";
export type SaveAuthoring = (
  path: string,
  method: "POST" | "PATCH" | "PUT",
  body: unknown,
  message: string,
) => Promise<boolean>;
export function ModuleForm({
  courseId,
  revision,
  module,
  pending,
  defaultPosition = 1,
  save,
}: {
  courseId: string;
  revision: number;
  module?: AuthoringModule;
  pending: boolean;
  defaultPosition?: number;
  save: SaveAuthoring;
}) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await save(
      module
        ? `/api/admin/modules/${module.id}`
        : `/api/admin/courses/${courseId}/modules`,
      module ? "PATCH" : "POST",
      {
        expectedCourseRevision: revision,
        title: textField(form, "title"),
        slug: textField(form, "slug"),
        description: textField(form, "description") || null,
        position: Number(form.get("position")),
      },
      "Module saved.",
    );
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <fieldset className="space-y-4" disabled={pending}>
        <legend className="mb-3 font-heading text-3xl uppercase">
          {module ? "Edit module" : "Create module"}
        </legend>
        <label className="block text-sm">
          Title
          <input
            name="title"
            className={fieldClass}
            required
            maxLength={300}
            defaultValue={module?.title}
          />
        </label>
        <label className="block text-sm">
          URL name
          <input
            name="slug"
            className={fieldClass}
            required
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            maxLength={120}
            defaultValue={module?.slug}
          />
        </label>
        <label className="block text-sm">
          Description
          <textarea
            name="description"
            className={fieldClass}
            rows={3}
            defaultValue={module?.description ?? ""}
          />
        </label>
        <label className="block text-sm">
          Position
          <input
            name="position"
            className={fieldClass}
            type="number"
            min={1}
            max={2147483647}
            required
            defaultValue={module?.position ?? defaultPosition}
          />
        </label>
      </fieldset>
      <button className={buttonClass} disabled={pending}>
        Save module
      </button>
    </form>
  );
}
export function LessonForm({
  revision,
  moduleId,
  lesson,
  pending,
  defaultPosition = 1,
  save,
}: {
  revision: number;
  moduleId: string;
  lesson?: AuthoringLesson;
  pending: boolean;
  defaultPosition?: number;
  save: SaveAuthoring;
}) {
  const [document, setDocument] = useState<ContentDocument>(
    lesson?.contentDocument ??
      (lesson?.content
        ? {
            version: 1,
            blocks: [
              {
                _type: "block",
                _key: `legacy-${lesson.id}`,
                style: "normal",
                children: [
                  {
                    _type: "span",
                    _key: `legacy-text-${lesson.id}`,
                    text: lesson.content,
                    marks: [],
                  },
                ],
                markDefs: [],
              },
            ],
          }
        : { version: 1, blocks: [] }),
  );
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await save(
      lesson
        ? `/api/admin/lessons/${lesson.id}`
        : `/api/admin/modules/${moduleId}/lessons`,
      lesson ? "PATCH" : "POST",
      {
        expectedCourseRevision: revision,
        title: textField(form, "title"),
        slug: textField(form, "slug"),
        position: Number(form.get("position")),
        contentDocument: document,
        transcript: textField(form, "transcript") || null,
        isPreview: form.get("isPreview") === "on",
        captions: lesson?.captions ?? [],
      },
      "Lesson saved.",
    );
  }
  return (
    <form onSubmit={submit} className="space-y-5">
      <fieldset disabled={pending} className="space-y-4">
        <legend className="mb-3 font-heading text-3xl uppercase">
          {lesson ? "Edit lesson" : "Create lesson"}
        </legend>
        <label className="block text-sm">
          Title
          <input
            name="title"
            className={fieldClass}
            required
            maxLength={300}
            defaultValue={lesson?.title}
          />
        </label>
        <label className="block text-sm">
          URL name
          <input
            name="slug"
            className={fieldClass}
            required
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            maxLength={120}
            defaultValue={lesson?.slug}
          />
        </label>
        <label className="block text-sm">
          Position
          <input
            name="position"
            className={fieldClass}
            type="number"
            min={1}
            max={2147483647}
            required
            defaultValue={lesson?.position ?? defaultPosition}
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="isPreview"
            defaultChecked={lesson?.isPreview}
          />
          Public preview text (assessments still require enrollment)
        </label>
        <ContentEditor
          value={document}
          revision={revision}
          onChange={setDocument}
        />
        <label className="block text-sm">
          Transcript
          <textarea
            className={fieldClass}
            name="transcript"
            rows={8}
            maxLength={500000}
            defaultValue={lesson?.transcript ?? ""}
          />
        </label>
      </fieldset>
      <button disabled={pending} className={buttonClass}>
        Save lesson
      </button>
    </form>
  );
}
