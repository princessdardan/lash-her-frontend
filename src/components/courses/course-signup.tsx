"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { confirmCourseAccess, submitCourseSignup } from "@/app/actions/course";
import type { FormActionResult } from "@/app/actions/form";
import { COURSE_CONSENT_TEXT } from "@/lib/courses/contract";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function CourseSignup({
  courseId,
  cookiesBlocked,
}: {
  courseId: string;
  cookiesBlocked: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<FormActionResult>({ success: false });
  return (
    <section
      aria-labelledby="course-signup-title"
      className="border border-lh-primary/20 bg-white p-6 sm:p-8"
    >
      <h2
        id="course-signup-title"
        className="font-heading text-3xl text-lh-shadow"
      >
        Start your free course
      </h2>
      <p className="mt-3 text-sm leading-relaxed">
        Sign up for Lash Her emails to unlock every lesson. We’ll remember your
        access in this browser for up to one year.
      </p>
      {cookiesBlocked && (
        <p role="alert" className="mt-4 text-sm text-red-800">
          Your browser did not save the access cookie. Allow cookies for this
          site, then try again.
        </p>
      )}
      <form
        className="mt-6 space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          startTransition(async () => {
            try {
              const response = await submitCourseSignup({
                courseId,
                email: String(data.get("email") ?? ""),
                marketingConsent: data.get("consent") === "on",
                company: String(data.get("company") ?? ""),
              });
              setResult(response);
              if (response.success) {
                if (await confirmCourseAccess(courseId)) router.refresh();
                else
                  setResult({
                    success: false,
                    error:
                      "Your signup was saved, but your browser blocked the access cookie. Allow cookies for this site to remember your access.",
                  });
              }
            } catch {
              setResult({
                success: false,
                error: "Unable to connect. Please try again.",
              });
            }
          });
        }}
      >
        <input
          name="company"
          type="text"
          autoComplete="off"
          tabIndex={-1}
          aria-hidden="true"
          className="hidden"
        />
        <div className="space-y-2">
          <label htmlFor="course-email" className="text-sm font-medium">
            Email address
          </label>
          <Input
            id="course-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            maxLength={254}
            disabled={pending}
            aria-invalid={Boolean(result.fieldErrors?.email)}
            aria-describedby={
              result.fieldErrors?.email ? "course-email-error" : undefined
            }
          />
          {result.fieldErrors?.email && (
            <p id="course-email-error" className="text-sm text-red-800">
              {result.fieldErrors.email}
            </p>
          )}
        </div>
        <label className="flex items-start gap-3 text-sm leading-relaxed">
          <input
            name="consent"
            type="checkbox"
            required
            disabled={pending}
            className="mt-1 size-4 shrink-0 accent-lh-primary"
            aria-describedby={
              result.fieldErrors?.marketingConsent
                ? "course-consent-error"
                : undefined
            }
          />
          <span>{COURSE_CONSENT_TEXT}</span>
        </label>
        {result.fieldErrors?.marketingConsent && (
          <p id="course-consent-error" className="text-sm text-red-800">
            {result.fieldErrors.marketingConsent}
          </p>
        )}
        <p className="text-xs leading-relaxed">
          Your email is used for marketing updates. Course access and learning
          progress are remembered in this browser.{" "}
          <Link
            className="underline underline-offset-4"
            href="/policies/privacy-policy"
          >
            Privacy policy
          </Link>
          .
        </p>
        {result.error && (
          <p role="alert" className="text-sm text-red-800">
            {result.error}
          </p>
        )}
        <Button type="submit" disabled={pending} className="w-full">
          {pending ? "Opening your course…" : "Sign up and access course"}
        </Button>
      </form>
    </section>
  );
}
