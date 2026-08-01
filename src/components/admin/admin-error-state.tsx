"use client";

import Link from "next/link";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface AdminErrorStateProps {
  error: Error & { digest?: string };
  reset: () => void;
  standalone?: boolean;
}

export function AdminErrorState({
  error,
  reset,
  standalone = false,
}: AdminErrorStateProps) {
  useEffect(() => {
    console.error("[admin-error-boundary] Admin route render failed", {
      digest: error.digest ?? null,
      errorName: error.name,
    });
  }, [error.digest, error.name]);

  return (
    <div
      className={cn(
        "flex items-center justify-center bg-lh-neutral-2 px-5 py-12 text-lh-shadow",
        standalone ? "min-h-screen" : "min-h-[28rem] rounded-2xl",
      )}
    >
      <section
        aria-labelledby="admin-error-title"
        className="w-full max-w-xl rounded-2xl border border-lh-line bg-white p-6 shadow-sm sm:p-8"
        role="alert"
      >
        <p className="font-smallcaps text-sm uppercase tracking-[0.18em] text-lh-muted">
          Admin
        </p>
        <h1
          className="mt-2 font-heading text-4xl uppercase tracking-[0.08em]"
          id="admin-error-title"
        >
          Page unavailable
        </h1>
        <p className="mt-4 text-lh-muted">
          The requested admin data could not be loaded. No changes were made.
          Retry the request or return to the admin home page.
        </p>
        {error.digest ? (
          <p className="mt-3 break-all text-xs text-lh-muted">
            Error reference: {error.digest}
          </p>
        ) : null}
        <div className="mt-6 flex flex-wrap gap-3">
          <Button onClick={reset} size="lg" type="button">
            Try again
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/admin">Admin home</Link>
          </Button>
        </div>
      </section>
    </div>
  );
}
