"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { confirmCourseAccess, submitCourseSignup } from "@/app/actions/course";
import type { FormActionResult } from "@/app/actions/form";
import { currentCampaignAttribution } from "@/lib/highlevel/attribution";
import { MarketingConsent } from "@/components/custom/marketing-consent";
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
        Create your course access to unlock every lesson. Marketing is optional.
        We’ll remember your access in this browser for up to one year.
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
                name: String(data.get("name") ?? ""),
                email: String(data.get("email") ?? ""),
                phone: String(data.get("phone") ?? ""),
                instagram: String(data.get("instagram") ?? ""),
                marketingConsent: data.get("marketingConsent") === "on",
                smsMarketingConsent: data.get("smsMarketingConsent") === "on",
                attribution: currentCampaignAttribution(),
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
          <label htmlFor="course-name" className="text-sm font-medium">
            Full name (first and last name)
          </label>
          <Input
            id="course-name"
            name="name"
            type="text"
            autoComplete="name"
            required
            maxLength={120}
            disabled={pending}
            aria-invalid={Boolean(result.fieldErrors?.name)}
            aria-describedby={
              result.fieldErrors?.name ? "course-name-error" : undefined
            }
          />
          {result.fieldErrors?.name && (
            <p
              id="course-name-error"
              role="alert"
              className="text-sm text-red-800"
            >
              {result.fieldErrors.name}
            </p>
          )}
        </div>
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
        <div className="space-y-2">
          <label htmlFor="course-phone" className="text-sm font-medium">
            Phone number
          </label>
          <Input
            id="course-phone"
            name="phone"
            type="tel"
            autoComplete="tel"
            required
            maxLength={40}
            disabled={pending}
            aria-invalid={Boolean(result.fieldErrors?.phone)}
            aria-describedby={
              result.fieldErrors?.phone ? "course-phone-error" : undefined
            }
          />
          {result.fieldErrors?.phone && (
            <p id="course-phone-error" className="text-sm text-red-800">
              {result.fieldErrors.phone}
            </p>
          )}
        </div>
        <div className="space-y-2">
          <label htmlFor="course-instagram" className="text-sm font-medium">
            Instagram handle (optional)
          </label>
          <Input
            id="course-instagram"
            name="instagram"
            type="text"
            placeholder="@yourhandle"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={31}
            disabled={pending}
            aria-invalid={Boolean(result.fieldErrors?.instagram)}
            aria-describedby={
              result.fieldErrors?.instagram
                ? "course-instagram-error"
                : undefined
            }
          />
          {result.fieldErrors?.instagram && (
            <p id="course-instagram-error" className="text-sm text-red-800">
              {result.fieldErrors.instagram}
            </p>
          )}
        </div>
        <MarketingConsent id="course" disabled={pending} />
        <p className="text-xs leading-relaxed">
          Your contact details are saved with your signup. Marketing preferences
          do not affect your course access. Course access and learning progress
          are remembered in this browser.{" "}
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
