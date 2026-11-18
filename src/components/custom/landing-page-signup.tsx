"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { submitLandingPageSignup } from "@/app/actions/landing-page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel, FieldError } from "@/components/ui/field";
import { currentCampaignAttribution } from "@/lib/highlevel/attribution";
import { EMAIL_CONSENT_TEXT } from "@/lib/highlevel/contract";
import {
  LANDING_PAGE_NAME_MAX_LENGTH,
  LANDING_PAGE_PHONE_MAX_LENGTH,
  type LandingPageSignupResult,
} from "@/lib/landing-pages/contract";
import type { TLandingPage } from "@/types";

export function LandingPageSignup({
  slug,
  settings,
}: {
  slug: string;
  settings?: TLandingPage["signup"];
}) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<LandingPageSignupResult | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const formData = new FormData(event.currentTarget);
    setPending(true);
    setResult(null);
    try {
      setResult(
        await submitLandingPageSignup({
          slug,
          name: String(formData.get("name") ?? ""),
          email: String(formData.get("email") ?? ""),
          phone: String(formData.get("phone") ?? ""),
          company: String(formData.get("company") ?? ""),
          marketingConsent: formData.get("marketingConsent") === "on",
          attribution: currentCampaignAttribution(),
        }),
      );
    } catch {
      setResult({
        success: false,
        error: "We couldn't connect. Please try again.",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      id="email-signup"
      aria-labelledby="signup-heading"
      tabIndex={0}
      className="scroll-mt-32 rounded-[24px] border border-lh-line bg-lh-white p-6 wrap-anywhere focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lh-primary sm:p-8 lg:sticky lg:top-32 lg:max-h-[calc(100dvh-9.5rem)] lg:overflow-y-auto"
    >
      <h2
        id="signup-heading"
        className="font-heading text-4xl leading-none text-lh-primary"
      >
        {settings?.heading || "Be the first to know"}
      </h2>
      {settings?.description ? (
        <p className="mt-4 text-sm leading-7 text-lh-muted">
          {settings.description}
        </p>
      ) : null}
      {result?.success ? (
        <p role="status" className="mt-6 leading-8 text-lh-shadow">
          {settings?.successMessage ||
            "You're on the list. Watch your inbox for updates."}
        </p>
      ) : (
        <form
          onSubmit={handleSubmit}
          aria-busy={pending}
          className="mt-6 space-y-5"
        >
          <input
            type="text"
            name="company"
            autoComplete="off"
            tabIndex={-1}
            aria-hidden="true"
            className="hidden"
          />
          {result?.error ? (
            <p role="alert" className="text-sm text-red-800">
              {result.error}
            </p>
          ) : null}
          <Field>
            <FieldLabel htmlFor="landing-name">Full name</FieldLabel>
            <Input
              id="landing-name"
              name="name"
              autoComplete="name"
              required
              maxLength={LANDING_PAGE_NAME_MAX_LENGTH}
              disabled={pending}
              aria-invalid={!!result?.fieldErrors?.name}
              aria-describedby={
                result?.fieldErrors?.name ? "landing-name-error" : undefined
              }
            />
            {result?.fieldErrors?.name ? (
              <FieldError id="landing-name-error" role="alert">
                {result.fieldErrors.name}
              </FieldError>
            ) : null}
          </Field>
          <Field>
            <FieldLabel htmlFor="landing-email">Email address</FieldLabel>
            <Input
              id="landing-email"
              name="email"
              type="email"
              autoComplete="email"
              required
              maxLength={254}
              disabled={pending}
              aria-invalid={!!result?.fieldErrors?.email}
              aria-describedby={
                result?.fieldErrors?.email ? "landing-email-error" : undefined
              }
            />
            {result?.fieldErrors?.email ? (
              <FieldError id="landing-email-error" role="alert">
                {result.fieldErrors.email}
              </FieldError>
            ) : null}
          </Field>
          <Field>
            <FieldLabel htmlFor="landing-phone">Phone number</FieldLabel>
            <Input
              id="landing-phone"
              name="phone"
              type="tel"
              autoComplete="tel"
              required
              maxLength={LANDING_PAGE_PHONE_MAX_LENGTH}
              disabled={pending}
              aria-invalid={!!result?.fieldErrors?.phone}
              aria-describedby={
                result?.fieldErrors?.phone ? "landing-phone-error" : undefined
              }
            />
            {result?.fieldErrors?.phone ? (
              <FieldError id="landing-phone-error" role="alert">
                {result.fieldErrors.phone}
              </FieldError>
            ) : null}
          </Field>
          <div>
            <label
              htmlFor="landing-consent"
              className="flex items-start gap-3 text-xs leading-6 text-lh-muted"
            >
              <input
                id="landing-consent"
                name="marketingConsent"
                type="checkbox"
                required
                disabled={pending}
                className="mt-1 size-4 shrink-0 accent-lh-primary"
                aria-invalid={!!result?.fieldErrors?.marketingConsent}
                aria-describedby={
                  result?.fieldErrors?.marketingConsent
                    ? "landing-consent-error"
                    : undefined
                }
              />
              <span>{EMAIL_CONSENT_TEXT}</span>
            </label>
            {result?.fieldErrors?.marketingConsent ? (
              <p
                id="landing-consent-error"
                role="alert"
                className="mt-2 text-sm text-red-800"
              >
                {result.fieldErrors.marketingConsent}
              </p>
            ) : null}
          </div>
          <Button
            type="submit"
            disabled={pending}
            className="h-auto min-h-9 w-full whitespace-normal wrap-anywhere text-center"
          >
            {pending ? "Joining…" : settings?.submitLabel || "Join the list"}
          </Button>
          {settings?.privacyPolicySlug ? (
            <p className="text-xs leading-6 text-lh-muted">
              Read our{" "}
              <Link
                href={`/policies/${encodeURIComponent(settings.privacyPolicySlug)}`}
                className="underline underline-offset-4"
              >
                Privacy Policy
              </Link>
              .
            </p>
          ) : null}
        </form>
      )}
    </section>
  );
}
