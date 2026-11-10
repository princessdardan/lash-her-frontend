"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  authoringRequest,
  AuthoringRequestError,
} from "@/lib/course-authoring/browser";
import { courseFormInput } from "@/lib/course-authoring/forms";
import type { AuthoringCourse } from "@/lib/course-authoring/types";
import { buttonClass, CourseFields } from "./course-fields";

export function CreateCourseForm() {
  const router = useRouter(),
    [pending, setPending] = useState(false),
    [message, setMessage] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    setMessage(null);
    setPending(true);
    try {
      const result = await authoringRequest<{ course: AuthoringCourse }>(
        "/api/admin/courses",
        "POST",
        { ...courseFormInput(form), status: "draft" },
      );
      router.push(`/admin/courses/${encodeURIComponent(result.course.id)}`);
      router.refresh();
    } catch (error) {
      setMessage(
        error instanceof AuthoringRequestError && error.requestId
          ? `${error.message} Reference: ${error.requestId}`
          : error instanceof Error
            ? error.message
            : "The course could not be created.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <form className="space-y-5" onSubmit={submit}>
      <fieldset disabled={pending} className="space-y-4">
        <legend className="mb-4 font-heading text-2xl uppercase tracking-wide">
          Create a draft
        </legend>
        <CourseFields />
      </fieldset>
      {message && (
        <p role="alert" className="text-sm text-lh-accent">
          {message}
        </p>
      )}
      <button className={buttonClass} disabled={pending} type="submit">
        {pending ? "Creating draft…" : "Create draft"}
      </button>
    </form>
  );
}
