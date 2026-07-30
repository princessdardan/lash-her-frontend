import Link from "next/link";
import type { ReactNode } from "react";

interface AdminWorkspaceHeaderProps {
  description: ReactNode;
  eyebrow: string;
  title: string;
}

export function AdminWorkspaceHeader({
  description,
  eyebrow,
  title,
}: AdminWorkspaceHeaderProps) {
  return (
    <header>
      <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">
        {eyebrow}
      </p>
      <h1 className="mt-2 font-heading text-4xl uppercase tracking-[0.08em] sm:text-5xl">
        {title}
      </h1>
      <div className="mt-3 max-w-3xl text-lh-muted">{description}</div>
    </header>
  );
}

interface AdminWorkspaceSearchProps {
  action: string;
  label: string;
  placeholder: string;
  search: string;
}

export function AdminWorkspaceSearch({
  action,
  label,
  placeholder,
  search,
}: AdminWorkspaceSearchProps) {
  return (
    <form
      action={action}
      className="flex max-w-2xl flex-col gap-2 sm:flex-row"
      method="GET"
      role="search"
    >
      <label className="sr-only" htmlFor={`${action}-search`}>
        {label}
      </label>
      <input
        className="min-h-11 min-w-0 flex-1 rounded-full border border-lh-line bg-white px-4 py-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lh-primary"
        defaultValue={search}
        id={`${action}-search`}
        name="q"
        placeholder={placeholder}
        type="search"
      />
      <div className="flex gap-2">
        <button
          className="min-h-11 rounded-full bg-lh-primary px-5 py-2.5 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lh-primary focus-visible:ring-offset-2"
          type="submit"
        >
          Search
        </button>
        {search ? (
          <Link
            className="inline-flex min-h-11 items-center rounded-full border border-lh-line bg-white px-5 py-2.5 text-sm font-semibold text-lh-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lh-primary"
            href={action}
          >
            Clear
          </Link>
        ) : null}
      </div>
    </form>
  );
}

interface AdminWorkspaceResultsProps {
  emptyMessage: ReactNode;
  page: number;
  pageCount: number;
  pageSize: number;
  path: string;
  preservedParams?: Record<string, string | undefined>;
  rows: ReactNode;
  search: string;
  total: number;
}

export function AdminWorkspaceResults({
  emptyMessage,
  page,
  pageCount,
  pageSize,
  path,
  preservedParams,
  rows,
  search,
  total,
}: AdminWorkspaceResultsProps) {
  const firstResult = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastResult = Math.min(page * pageSize, total);

  return (
    <section aria-labelledby={`${path}-results-heading`} className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2
            className="font-heading text-2xl uppercase tracking-[0.08em]"
            id={`${path}-results-heading`}
          >
            Results
          </h2>
          <p aria-live="polite" className="mt-1 text-sm text-lh-muted">
            {total === 0
              ? "0 results"
              : `${firstResult}–${lastResult} of ${total} results`}
          </p>
        </div>
        {pageCount > 1 ? (
          <p className="text-sm text-lh-muted">
            Page {page} of {pageCount}
          </p>
        ) : null}
      </div>

      {total === 0 ? (
        <div className="rounded-2xl border border-dashed border-lh-line bg-white p-6 text-lh-muted">
          {emptyMessage}
        </div>
      ) : (
        rows
      )}

      {pageCount > 1 ? (
        <nav
          aria-label="Results pagination"
          className="flex items-center justify-between gap-3"
        >
          {page > 1 ? (
            <Link
              className="inline-flex min-h-11 items-center rounded-full border border-lh-line bg-white px-5 py-2.5 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lh-primary"
              href={buildPageHref(path, page - 1, search, preservedParams)}
              rel="prev"
            >
              Previous
            </Link>
          ) : (
            <span
              aria-disabled="true"
              className="inline-flex min-h-11 items-center rounded-full border border-lh-line px-5 py-2.5 text-sm font-semibold text-lh-muted opacity-50"
            >
              Previous
            </span>
          )}
          {page < pageCount ? (
            <Link
              className="inline-flex min-h-11 items-center rounded-full border border-lh-line bg-white px-5 py-2.5 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lh-primary"
              href={buildPageHref(path, page + 1, search, preservedParams)}
              rel="next"
            >
              Next
            </Link>
          ) : (
            <span
              aria-disabled="true"
              className="inline-flex min-h-11 items-center rounded-full border border-lh-line px-5 py-2.5 text-sm font-semibold text-lh-muted opacity-50"
            >
              Next
            </span>
          )}
        </nav>
      ) : null}
    </section>
  );
}

function buildPageHref(
  path: string,
  page: number,
  search: string,
  preservedParams: Record<string, string | undefined> = {},
): string {
  const params = new URLSearchParams();

  Object.entries(preservedParams).forEach(([key, value]) => {
    if (value) {
      params.set(key, value);
    }
  });

  if (search) {
    params.set("q", search);
  }

  if (page > 1) {
    params.set("page", String(page));
  }

  const query = params.toString();
  return query ? `${path}?${query}` : path;
}
