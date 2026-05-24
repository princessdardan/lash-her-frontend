"use client";

import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
import { X } from "lucide-react";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel, FieldError } from "@/components/ui/field";
import { LashHerLogo } from "@/components/ui/logo";
import { submitContactPopup } from "@/app/actions/form";
import type { TContactPopupSettings } from "@/types";

interface ContactPopupProps {
  settings?: TContactPopupSettings;
}

export function ContactPopup({ settings }: ContactPopupProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [isSubmitted, setIsSubmitted] = React.useState(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [generalError, setGeneralError] = React.useState<string | null>(null);
  const pathname = usePathname();

  const enabled = settings?.enabled ?? false;
  const variant = settings?.variant ?? "fullContact";
  const heading = settings?.heading ?? "Join Our Community";
  const description = settings?.description ?? "Subscribe to get the latest updates and offers.";
  const privacyText = settings?.privacyText ?? "By subscribing, you agree to our";
  const privacyLinkLabel = settings?.privacyLinkLabel ?? "Privacy Policy";
  const privacyLinkHref = settings?.privacyLinkHref ?? "";
  const submitLabel = settings?.submitLabel ?? "Subscribe";
  const successMessage = settings?.successMessage ?? "Thank you for subscribing!";
  const cookieExpiryDays = settings?.cookieExpiryDays ?? 30;
  const safePrivacyLinkHref = getSafePrivacyLinkHref(privacyLinkHref);

  React.useEffect(() => {
    if (!enabled) return;

    const hasDismissed = document.cookie.includes("lh_contact_popup_dismissed=true");
    if (!hasDismissed) {
      const timer = setTimeout(() => {
        setIsOpen(true);
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [enabled]);

  const setDismissCookie = () => {
    const safeExpiryDays = Math.max(1, cookieExpiryDays);
    const date = new Date();
    date.setTime(date.getTime() + safeExpiryDays * 24 * 60 * 60 * 1000);
    document.cookie = `lh_contact_popup_dismissed=true;expires=${date.toUTCString()};path=/`;
  };

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (!open) {
      setDismissCookie();
    }
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsSubmitting(true);
    setErrors({});
    setGeneralError(null);

    const formData = new FormData(e.currentTarget);
    const name = formData.get("name");
    const email = formData.get("email");
    const instagram = formData.get("instagram");
    const company = formData.get("company");
    const data = {
      variant,
      name: typeof name === "string" ? name : "",
      email: typeof email === "string" ? email : "",
      instagram: typeof instagram === "string" ? instagram : "",
      sourcePath: pathname,
      consentText: buildPopupConsentText(description, privacyText, privacyLinkLabel),
      company: typeof company === "string" ? company : "",
    };

    const result = await submitContactPopup(data);

    if (result.success) {
      setIsSubmitted(true);
      setDismissCookie();
    } else {
      if (result.fieldErrors) {
        setErrors(result.fieldErrors);
      }
      if (result.error) {
        setGeneralError(result.error);
      }
    }
    setIsSubmitting(false);
  };

  if (!enabled) return null;

  return (
    <Dialog.Root open={isOpen} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-[50%] top-[50%] z-50 grid max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 overflow-y-auto border bg-white p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg md:w-full">
          <VisuallyHidden.Root>
            <Dialog.Title>{heading}</Dialog.Title>
            <Dialog.Description>{description}</Dialog.Description>
          </VisuallyHidden.Root>
          <div className="flex flex-col items-center text-center space-y-4">
            <LashHerLogo className="h-12 w-auto text-lh-primary" />
            <h2 className="text-2xl font-serif text-lh-primary">
              {heading}
            </h2>
            <p className="text-sm text-gray-600">
              {description}
            </p>
          </div>

          {isSubmitted ? (
            <div className="py-8 text-center">
              <p className="text-lg font-medium text-lh-primary">{successMessage}</p>
              <Button
                className="mt-6 w-full"
                onClick={() => handleOpenChange(false)}
              >
                Close
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4 mt-4">
              <input
                type="text"
                name="company"
                tabIndex={-1}
                autoComplete="off"
                className="hidden"
                aria-hidden="true"
              />

              {generalError && (
                <div className="p-3 text-sm text-red-600 bg-red-50 rounded-md">
                  {generalError}
                </div>
              )}

              {variant === "fullContact" && (
                <Field>
                  <FieldLabel htmlFor="popup-name">Name</FieldLabel>
                  <Input
                    id="popup-name"
                    name="name"
                    placeholder="Your name"
                    disabled={isSubmitting}
                    required
                    aria-invalid={!!errors.name}
                    aria-describedby={errors.name ? "popup-name-error" : undefined}
                  />
                  {errors.name && <FieldError id="popup-name-error">{errors.name}</FieldError>}
                </Field>
              )}

              <Field>
                <FieldLabel htmlFor="popup-email">Email*</FieldLabel>
                <Input
                  id="popup-email"
                  name="email"
                  type="email"
                  placeholder="Your email address"
                  disabled={isSubmitting}
                  required
                  aria-invalid={!!errors.email}
                  aria-describedby={errors.email ? "popup-email-error" : undefined}
                />
                {errors.email && <FieldError id="popup-email-error">{errors.email}</FieldError>}
              </Field>

              {variant === "fullContact" && (
                <Field>
                  <FieldLabel htmlFor="popup-instagram">Instagram (Optional)</FieldLabel>
                  <Input
                    id="popup-instagram"
                    name="instagram"
                    placeholder="@username"
                    disabled={isSubmitting}
                  />
                  {errors.instagram && <FieldError>{errors.instagram}</FieldError>}
                </Field>
              )}

              <div className="text-xs text-gray-500 text-center mt-4">
                {privacyText}{" "}
                {safePrivacyLinkHref ? (
                  <a
                    href={safePrivacyLinkHref}
                    className="underline hover:text-lh-primary"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {privacyLinkLabel}
                  </a>
                ) : null}
              </div>

              <Button
                type="submit"
                className="w-full"
                disabled={isSubmitting}
              >
                {isSubmitting ? "Submitting..." : submitLabel}
              </Button>
            </form>
          )}

          <Dialog.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-white transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-lh-primary focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-gray-100 data-[state=open]:text-gray-500">
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function getSafePrivacyLinkHref(href: string): string | null {
  const trimmedHref = href.trim();
  if (!trimmedHref) return null;
  if (trimmedHref.startsWith("/") && !trimmedHref.startsWith("//")) return trimmedHref;

  try {
    const url = new URL(trimmedHref);
    return url.protocol === "https:" || url.protocol === "mailto:" ? trimmedHref : null;
  } catch {
    return null;
  }
}

function buildPopupConsentText(description: string, privacyText: string, privacyLinkLabel: string): string {
  return [description, privacyText, privacyLinkLabel]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
}
