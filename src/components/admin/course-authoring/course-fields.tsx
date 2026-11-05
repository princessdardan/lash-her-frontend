import type { AuthoringCourse } from "@/lib/course-authoring/types";
export const fieldClass =
  "mt-1 block w-full rounded-lg border border-lh-line bg-white px-3 py-2 text-sm text-lh-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lh-primary disabled:opacity-60";
export const buttonClass =
  "inline-flex min-h-11 items-center justify-center rounded-full bg-lh-primary px-5 py-2 text-sm font-semibold text-white disabled:cursor-wait disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lh-primary focus-visible:ring-offset-2";
export const secondaryClass =
  "inline-flex min-h-11 items-center justify-center rounded-full border border-lh-line bg-white px-4 py-2 text-sm font-semibold text-lh-primary disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lh-primary focus-visible:ring-offset-2";
export function CourseFields({ course }: { course?: AuthoringCourse }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="text-sm font-medium">
        Course title
        <input
          className={fieldClass}
          name="title"
          required
          maxLength={300}
          defaultValue={course?.title}
        />
      </label>
      <label className="text-sm font-medium">
        URL name
        <input
          className={fieldClass}
          name="slug"
          required
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          maxLength={120}
          defaultValue={course?.slug}
        />
        <span className="mt-1 block text-xs text-lh-muted">
          Lowercase letters, numbers and hyphens.
        </span>
      </label>
      <label className="text-sm font-medium sm:col-span-2">
        Catalog description
        <textarea
          className={fieldClass}
          name="description"
          rows={3}
          maxLength={100000}
          defaultValue={course?.description ?? ""}
        />
      </label>
      <label className="text-sm font-medium sm:col-span-2">
        Introduction
        <textarea
          className={fieldClass}
          name="introduction"
          rows={4}
          maxLength={100000}
          defaultValue={course?.introduction ?? ""}
        />
      </label>
      <label className="text-sm font-medium">
        Access
        <select
          className={fieldClass}
          name="accessMode"
          defaultValue={course?.accessMode ?? "free"}
        >
          <option value="free">Free enrollment</option>
          <option value="paid">Paid course</option>
        </select>
      </label>
      <label className="text-sm font-medium">
        Price (CAD)
        <input
          className={fieldClass}
          name="price"
          inputMode="decimal"
          required
          defaultValue={((course?.priceCents ?? 0) / 100).toFixed(2)}
        />
        <span className="mt-1 block text-xs text-lh-muted">
          Paid checkout is not available in this release.
        </span>
      </label>
      <label className="text-sm font-medium">
        Approved tax classification
        <input
          className={fieldClass}
          name="taxClassification"
          maxLength={128}
          defaultValue={course?.taxClassification ?? ""}
        />
      </label>
      <label className="text-sm font-medium">
        Cover address
        <input
          className={fieldClass}
          name="coverUrl"
          type="url"
          placeholder="https://"
          defaultValue={course?.cover?.url ?? ""}
        />
      </label>
      <label className="text-sm font-medium sm:col-span-2">
        Cover alternative text
        <input
          className={fieldClass}
          name="coverAlt"
          maxLength={500}
          defaultValue={course?.cover?.alt ?? ""}
        />
      </label>
      <label className="text-sm font-medium">
        Search title
        <input
          className={fieldClass}
          name="seoTitle"
          maxLength={200}
          defaultValue={course?.seo?.title ?? ""}
        />
      </label>
      <label className="text-sm font-medium">
        Search description
        <textarea
          className={fieldClass}
          name="seoDescription"
          maxLength={1000}
          rows={2}
          defaultValue={course?.seo?.description ?? ""}
        />
      </label>
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input
          name="noIndex"
          type="checkbox"
          defaultChecked={course?.seo?.noIndex ?? false}
        />
        Hide from search engines
      </label>
    </div>
  );
}
