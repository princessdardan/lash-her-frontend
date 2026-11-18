"use client";
import { currentCampaignAttribution } from "@/lib/highlevel/attribution";
import { MarketingConsent } from "@/components/custom/marketing-consent";

import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel, FieldError } from "@/components/ui/field";
import { LashHerLogo } from "@/components/ui/logo";
import { submitContactPopup } from "@/app/actions/form";
import type { CheckoutMarketing } from "@/lib/highlevel/contract";
import type { TContactPopupSettings } from "@/types";

interface ContactPopupProps {
  settings?: TContactPopupSettings;
  excludedPaths?: string[];
}

const emptyContactDraft = { name: "", email: "", instagram: "" };
const reopenStorageKey = "lh_contact_popup_reopen";
const reopenChangedEvent = "lh-contact-popup-reopen-changed";
type ReopenStatus = "dismissed" | "submitted";
let reopenWithoutStorage: ReopenStatus | undefined;

function getReopenSnapshot(): ReopenStatus | null {
  if (reopenWithoutStorage !== undefined) return reopenWithoutStorage;
  try {
    const status = window.localStorage.getItem(reopenStorageKey);
    return status === "dismissed" || status === "submitted" ? status : null;
  } catch {
    return null;
  }
}

function subscribeToReopen(onChange: () => void) {
  function handleStorage(event: StorageEvent) {
    if (event.key === reopenStorageKey || event.key === null) onChange();
  }
  window.addEventListener(reopenChangedEvent, onChange);
  window.addEventListener("storage", handleStorage);
  window.addEventListener("pageshow", onChange);
  return () => {
    window.removeEventListener(reopenChangedEvent, onChange);
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener("pageshow", onChange);
  };
}

function setReopenStatus(status: ReopenStatus) {
  try {
    window.localStorage.setItem(reopenStorageKey, status);
    reopenWithoutStorage = undefined;
  } catch {
    // The in-memory flag still allows reopening in this document.
    reopenWithoutStorage = status;
  }
  window.dispatchEvent(new Event(reopenChangedEvent));
}

function migrateReopenStatus() {
  try {
    if (window.sessionStorage.getItem(reopenStorageKey) !== "true") return;
    if (getReopenSnapshot() === null) setReopenStatus("dismissed");
    window.sessionStorage.removeItem(reopenStorageKey);
  } catch {
    // Browsers can block access to session storage.
  }
}

function hasDismissCookie() {
  return document.cookie
    .split(";")
    .some((cookie) => cookie.trim() === "lh_contact_popup_dismissed=true");
}

export function ContactPopup({
  settings,
  excludedPaths = [],
}: ContactPopupProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  const canReopen =
    React.useSyncExternalStore(
      subscribeToReopen,
      getReopenSnapshot,
      () => null,
    ) === "dismissed";
  const [isSubmitted, setIsSubmitted] = React.useState(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [contactDraft, setContactDraft] = React.useState(emptyContactDraft);
  const [marketingDraft, setMarketingDraft] =
    React.useState<CheckoutMarketing>();
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [generalError, setGeneralError] = React.useState<string | null>(null);
  const pathname = usePathname();
  const isCoursePage =
    pathname === "/courses" || pathname.startsWith("/courses/");
  const isExcludedPage = isCoursePage || excludedPaths.includes(pathname);

  const enabled = settings?.enabled ?? false;
  const variant = settings?.variant ?? "fullContact";
  const heading = settings?.heading ?? "Join Our Community";
  const description =
    settings?.description ?? "Subscribe to get the latest updates and offers.";
  const privacyText =
    settings?.privacyText ?? "By subscribing, you agree to our";
  const privacyLinkLabel = settings?.privacyLinkLabel ?? "Privacy Policy";
  const privacyLinkHref = settings?.privacyLinkHref ?? "";
  const reopenLabel = settings?.reopenLabel?.trim() || "Open Offer Sign-up";
  const submitLabel = settings?.submitLabel ?? "Subscribe";
  const successMessage =
    settings?.successMessage ?? "Thank you for subscribing!";
  const cookieExpiryDays = settings?.cookieExpiryDays ?? 30;
  const safePrivacyLinkHref = getSafePrivacyLinkHref(privacyLinkHref);

  React.useEffect(migrateReopenStatus, []);

  React.useEffect(() => {
    if (
      !enabled ||
      isExcludedPage ||
      canReopen ||
      isSubmitted ||
      hasDismissCookie()
    )
      return;
    const timer = setTimeout(() => {
      setIsOpen(true);
    }, 3000);
    return () => clearTimeout(timer);
  }, [enabled, canReopen, isExcludedPage, isSubmitted]);

  const setDismissCookie = () => {
    const safeExpiryDays = Math.max(1, cookieExpiryDays);
    const date = new Date();
    date.setTime(date.getTime() + safeExpiryDays * 24 * 60 * 60 * 1000);
    document.cookie = `lh_contact_popup_dismissed=true;expires=${date.toUTCString()};path=/`;
  };

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (!open) {
      // An open dialog in another tab can outlive a successful submission.
      if (
        !isSubmitted &&
        (getReopenSnapshot() !== "submitted" || !hasDismissCookie())
      ) {
        setReopenStatus("dismissed");
      }
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
      marketingConsent: formData.get("marketingConsent") === "on",
      smsMarketingConsent: formData.get("smsMarketingConsent") === "on",
      attribution: currentCampaignAttribution(),
      phone: String(formData.get("marketingPhone") ?? ""),
      name: typeof name === "string" ? name : "",
      email: typeof email === "string" ? email : "",
      instagram: typeof instagram === "string" ? instagram : "",
      sourcePath: pathname,
      consentText: buildPopupConsentText(
        description,
        privacyText,
        privacyLinkLabel,
      ),
      company: typeof company === "string" ? company : "",
    };

    const result = await submitContactPopup(data);

    if (result.success) {
      setIsSubmitted(true);
      setContactDraft(emptyContactDraft);
      setMarketingDraft(undefined);
      setDismissCookie();
      setReopenStatus("submitted");
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

  if (!enabled || isExcludedPage) return null;

  return (
    <Dialog.Root open={isOpen} onOpenChange={handleOpenChange}>
      {canReopen && !isSubmitted && (
        <Dialog.Trigger asChild>
          <Button
            variant="outline"
            className="fixed right-[max(1rem,env(safe-area-inset-right))] bottom-[calc(3.75rem+env(safe-area-inset-bottom))] z-40 h-auto min-h-11 max-w-[calc(100%-2rem)] border-lh-line bg-lh-white text-center whitespace-normal wrap-anywhere text-lh-primary shadow-md sm:bottom-[max(1rem,env(safe-area-inset-bottom))]"
          >
            {reopenLabel}
          </Button>
        </Dialog.Trigger>
      )}
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm motion-safe:data-[state=open]:animate-in motion-safe:data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(85dvh,calc(100dvh-2rem))] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-lh-line bg-lh-white shadow-lg duration-200 motion-safe:data-[state=open]:animate-in motion-safe:data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 sm:max-h-[calc(100dvh-2rem)]">
          <div className="relative flex min-h-15 shrink-0 items-center justify-center px-16 sm:min-h-18">
            <LashHerLogo
              aria-hidden="true"
              className="h-9 w-auto text-lh-primary sm:h-12"
            />
            <Dialog.Close
              aria-label="Close sign-up form"
              className="absolute right-2 top-2 grid size-11 place-items-center rounded-full bg-lh-neutral-2 text-lh-primary transition-colors hover:bg-lh-neutral focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lh-primary"
            >
              <X aria-hidden="true" className="size-5" />
            </Dialog.Close>
          </div>

          <div className="min-h-0 overflow-y-auto overscroll-contain px-4 pb-4 sm:px-6 sm:pb-6">
            <div className="space-y-2 text-center sm:space-y-3">
              <Dialog.Title className="font-serif text-xl text-lh-primary sm:text-2xl">
                {heading}
              </Dialog.Title>
              <Dialog.Description className="text-sm text-lh-muted">
                {description}
              </Dialog.Description>
            </div>
            {isSubmitted ? (
              <div className="py-8 text-center">
                <p className="text-lg font-medium text-lh-primary">
                  {successMessage}
                </p>
                <Dialog.Close asChild>
                  <Button className="mt-6 w-full">Close</Button>
                </Dialog.Close>
              </div>
            ) : (
              <form
                onSubmit={handleSubmit}
                className="mt-4 space-y-3 sm:space-y-4"
              >
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
                      value={contactDraft.name}
                      onChange={(event) =>
                        setContactDraft({
                          ...contactDraft,
                          name: event.target.value,
                        })
                      }
                      disabled={isSubmitting}
                      required
                      aria-invalid={!!errors.name}
                      aria-describedby={
                        errors.name ? "popup-name-error" : undefined
                      }
                    />
                    {errors.name && (
                      <FieldError id="popup-name-error">
                        {errors.name}
                      </FieldError>
                    )}
                  </Field>
                )}

                <Field>
                  <FieldLabel htmlFor="popup-email">Email*</FieldLabel>
                  <Input
                    id="popup-email"
                    name="email"
                    type="email"
                    placeholder="Your email address"
                    value={contactDraft.email}
                    onChange={(event) =>
                      setContactDraft({
                        ...contactDraft,
                        email: event.target.value,
                      })
                    }
                    disabled={isSubmitting}
                    required
                    aria-invalid={!!errors.email}
                    aria-describedby={
                      errors.email ? "popup-email-error" : undefined
                    }
                  />
                  {errors.email && (
                    <FieldError id="popup-email-error">
                      {errors.email}
                    </FieldError>
                  )}
                </Field>

                {variant === "fullContact" && (
                  <Field>
                    <FieldLabel htmlFor="popup-instagram">
                      Instagram (Optional)
                    </FieldLabel>
                    <Input
                      id="popup-instagram"
                      name="instagram"
                      placeholder="@username"
                      value={contactDraft.instagram}
                      onChange={(event) =>
                        setContactDraft({
                          ...contactDraft,
                          instagram: event.target.value,
                        })
                      }
                      disabled={isSubmitting}
                    />
                    {errors.instagram && (
                      <FieldError>{errors.instagram}</FieldError>
                    )}
                  </Field>
                )}

                <MarketingConsent
                  id="popup"
                  disabled={isSubmitting}
                  includePhone
                  initialValue={marketingDraft}
                  onChange={setMarketingDraft}
                />
                {errors.phone && (
                  <p role="alert" className="text-sm text-red-800">
                    {errors.phone}
                  </p>
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
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function getSafePrivacyLinkHref(href: string): string | null {
  const trimmedHref = href.trim();
  if (!trimmedHref) return null;
  if (trimmedHref.startsWith("/") && !trimmedHref.startsWith("//"))
    return trimmedHref;

  try {
    const url = new URL(trimmedHref);
    return url.protocol === "https:" || url.protocol === "mailto:"
      ? trimmedHref
      : null;
  } catch {
    return null;
  }
}

function buildPopupConsentText(
  description: string,
  privacyText: string,
  privacyLinkLabel: string,
): string {
  return [description, privacyText, privacyLinkLabel]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
}
