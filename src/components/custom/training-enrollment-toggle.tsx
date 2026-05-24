"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { SanityImage } from "@/components/ui/sanity-image";
import { formatCad } from "@/lib/commerce/money";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PortableTextRenderer } from "@/components/ui/portable-text-renderer";
import { submitTrainingContact, type FormActionResult } from "@/app/actions/form";
import { validateField, validateForm, type FieldValidationConfig, type ValidationErrors } from "@/lib/form-validation";
import type { TTrainingProgram, TTrainingContactSection } from "@/types";

interface TrainingEnrollmentToggleProps {
  readonly data: TTrainingProgram;
  readonly contactData?: TTrainingContactSection;
  readonly programSlug: string;
  readonly programTitle: string;
  readonly hasPurchaseUi?: boolean;
}

type ViewMode = "enrollment" | "contact";

type TrainingContactFormData = {
  name: string;
  email: string;
  phone: string;
  location: string;
  instagram: string;
  privacyPolicyConsent: boolean;
};

const TRAINING_CONTACT_CONSENT_TEXT = "I agree to receive training updates, program news, and offers from Lash Her by Nataliea.";

const TRAINING_CONTACT_VALIDATION: FieldValidationConfig = {
  name: [{ type: "required", message: "Name is required" }],
  email: [
    { type: "required", message: "Email is required" },
    { type: "email", message: "Please enter a valid email address" },
  ],
  phone: [
    { type: "required", message: "Phone number is required" },
    { type: "phone", message: "Please enter a valid phone number" },
  ],
  privacyPolicyConsent: [{ type: "required", message: "You must agree to the privacy policy to continue" }],
};

const DEFAULT_CONTACT_LABELS = {
  heading: "Begin Your Training Conversation",
  subHeading: "Share your details and we will follow up with next steps for this training program.",
  name: "Name",
  email: "Email",
  phone: "Phone Number",
  location: "Location (optional)",
  instagram: "Instagram (optional)",
  submitLabel: "Submit Training Inquiry",
  successMessage: "Thank you. Your training inquiry has been received.",
};

function isSafeUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    if (url.startsWith("https://")) {
      new URL(url);
      return true;
    }
    return url.startsWith("/") && !url.startsWith("//");
  } catch {
    return false;
  }
}

function getFinitePrice(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function TrainingEnrollmentToggle({
  data,
  contactData,
  programSlug,
  programTitle,
  hasPurchaseUi = false,
}: TrainingEnrollmentToggleProps) {
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    if (typeof window !== "undefined") {
      const hash = window.location.hash;
      if (hash === "#contact") return "contact";
      if (hash === "#enrollment") return "enrollment";
    }
    return "enrollment";
  });
  const [isTransitioning, setIsTransitioning] = useState(false);

  // Handle hash changes while on the page
  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash;
      if (hash === "#contact") {
        setViewMode("contact");
      } else if (hash === "#enrollment") {
        setViewMode("enrollment");
      }
    };

    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  const handleToggle = () => {
    if (isTransitioning) return;
    setIsTransitioning(true);
    setViewMode((prev) => (prev === "enrollment" ? "contact" : "enrollment"));
    setTimeout(() => setIsTransitioning(false), 300);
  };

  const {
    title,
    enrollmentTitle,
    enrollmentDescription,
    enrollmentBackgroundImage,
    factList,
    primaryCta,
    secondaryCta,
  } = data;

  const inclusions = factList?.filter(Boolean) ?? [];
  const price = getFinitePrice(data.price);
  const availabilityLabel = data.availabilityLabel;
  const isAvailable = data.isAvailable;
  const safePrimaryCta = primaryCta?.label && isSafeUrl(primaryCta.href) ? primaryCta : null;
  const safeSecondaryCta = secondaryCta?.label && isSafeUrl(secondaryCta.href) ? secondaryCta : null;
  const hasEnrollmentData = enrollmentTitle || enrollmentDescription || enrollmentBackgroundImage || inclusions.length > 0 || price !== null || availabilityLabel || isAvailable !== undefined || safePrimaryCta || safeSecondaryCta;

  const showContact = contactData?.enabled !== false;
  const toggleText = viewMode === "enrollment" ? "I Want More Info" : "I'm Ready To Purchase";

  if (!hasEnrollmentData && !showContact) return null;

  return (
    <section className="py-8 md:py-12 lg:py-16" id={viewMode} data-training-enrollment-toggle="true">
      <div className={hasPurchaseUi ? "" : undefined}>
        {/* Toggle Header */}
        {showContact && hasEnrollmentData && (
          <div className="mb-6 flex items-center justify-center gap-4">
            <span className="font-body text-sm font-bold uppercase tracking-[0.12em] text-lh-shadow">
              {toggleText}
            </span>
            <button
              onClick={handleToggle}
              disabled={isTransitioning}
              className="relative inline-flex h-8 w-14 items-center rounded-full bg-lh-shadow transition-colors duration-300 focus:outline-none focus:ring-2 focus:ring-lh-primary focus:ring-offset-2 disabled:opacity-50"
              aria-label={`Toggle between enrollment and contact form. Currently showing: ${viewMode === "enrollment" ? "enrollment information" : "contact form"}`}
              role="switch"
              aria-checked={viewMode === "contact"}
            >
              <span
                className={`inline-block h-6 w-6 transform rounded-full bg-lh-neutral-2 transition-transform duration-300 ${
                  viewMode === "contact" ? "translate-x-7" : "translate-x-1"
                }`}
              />
            </button>
          </div>
        )}

        {/* Enrollment View */}
        <div
          className={`transition-opacity duration-300 ${
            viewMode === "enrollment" ? "opacity-100 relative" : "opacity-0 absolute pointer-events-none"
          }`}
          aria-hidden={viewMode !== "enrollment"}
        >
          {hasEnrollmentData && (
            <div className="grid grid-cols-1 overflow-hidden rounded-[28px] border border-lh-line bg-lh-white shadow-[0_24px_70px_rgba(28,19,24,0.08)] lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
              <div className="relative min-h-[360px] overflow-hidden bg-lh-shadow p-8 text-lh-neutral-2 md:p-10 lg:min-h-[520px] lg:p-12">
                <div className="absolute inset-0 z-0">
                  {enrollmentBackgroundImage ? (
                    <SanityImage
                      image={enrollmentBackgroundImage}
                      alt={enrollmentBackgroundImage.alt || enrollmentTitle || title}
                      fill
                      sizes="(min-width: 1024px) 42vw, 100vw"
                      className="object-cover"
                    />
                  ) : (
                    <div className="absolute inset-0 bg-[radial-gradient(circle_at_22%_16%,var(--lh-light-soft),transparent_30%),linear-gradient(145deg,var(--lh-shadow),var(--lh-accent)_54%,var(--lh-primary))]" />
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-lh-shadow via-lh-shadow/72 to-lh-shadow/20" />
                </div>

                <div className="relative z-10 flex h-full min-h-[inherit] flex-col justify-between">
                  <div>
                    <p className="eyebrow-label mb-4 text-lh-light">Enrollment</p>
                    <h2 className="section-heading text-lh-neutral-2 text-balance">
                      {enrollmentTitle || "Reserve Your Training Place"}
                    </h2>
                  </div>

                  <div className="mt-10 border-t border-lh-neutral-2/20 pt-6">
                    <p className="font-body text-sm font-bold uppercase tracking-[0.16em] text-lh-neutral-2/70">Program</p>
                    <p className="mt-2 font-heading text-3xl font-normal leading-none text-lh-neutral-2 md:text-4xl">{title}</p>
                  </div>
                </div>
              </div>

              <div className="flex flex-col justify-center p-8 md:p-10 lg:p-12">
                {enrollmentDescription && (
                  <p className="body-lead text-lh-shadow">{enrollmentDescription}</p>
                )}

                <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {price !== null && (
                    <div className="rounded-[24px] border border-lh-line bg-lh-neutral-2/70 p-5">
                      <p className="font-heading text-xs font-normal uppercase tracking-[0.28em] text-lh-muted">Investment</p>
                      <p className="mt-2 font-body text-2xl font-bold text-lh-primary">{formatCad(price)}</p>
                    </div>
                  )}

                  {(availabilityLabel || isAvailable !== undefined) && (
                    <div className="rounded-[24px] border border-lh-line bg-lh-neutral-2/70 p-5">
                      <p className="font-heading text-xs font-normal uppercase tracking-[0.28em] text-lh-muted">Availability</p>
                      <p className="mt-2 font-body text-lg font-bold text-lh-shadow">
                        {availabilityLabel || (isAvailable ? "Enrollment available" : "Enrollment paused")}
                      </p>
                    </div>
                  )}
                </div>

                {inclusions.length > 0 && (
                  <div className="mt-8">
                    <p className="mb-4 font-heading text-xs font-normal uppercase tracking-[0.28em] text-lh-primary">Included</p>
                    <ul className="grid grid-cols-1 gap-3 text-lh-shadow/82 md:grid-cols-2">
                      {inclusions.map((item) => (
                        <li key={item} className="flex items-start gap-3 font-body text-sm font-bold leading-7 md:text-base">
                          <span className="mt-3 h-px w-7 shrink-0 bg-lh-light" aria-hidden="true" />
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {(safePrimaryCta || safeSecondaryCta) && (
                  <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                    {safePrimaryCta && (
                      <Link
                        href={safePrimaryCta.href}
                        className="primary-cta inline-flex items-center justify-center rounded-full bg-lh-primary px-7 py-4 font-body text-sm font-bold uppercase tracking-[0.12em] text-lh-white transition-colors hover:bg-lh-primary/90"
                        target={safePrimaryCta.href.startsWith("https://") ? "_blank" : undefined}
                        rel={safePrimaryCta.href.startsWith("https://") ? "noopener noreferrer" : undefined}
                      >
                        {safePrimaryCta.label}
                      </Link>
                    )}
                    {safeSecondaryCta && (
                      <Link
                        href={safeSecondaryCta.href}
                        className="inline-flex items-center justify-center rounded-full border border-lh-line px-7 py-4 font-body text-sm font-bold uppercase tracking-[0.12em] text-lh-shadow transition-colors hover:bg-lh-neutral"
                        target={safeSecondaryCta.href.startsWith("https://") ? "_blank" : undefined}
                        rel={safeSecondaryCta.href.startsWith("https://") ? "noopener noreferrer" : undefined}
                      >
                        {safeSecondaryCta.label}
                      </Link>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Contact View */}
        <div
          className={`transition-opacity duration-300 ${
            viewMode === "contact" ? "opacity-100 relative" : "opacity-0 absolute pointer-events-none"
          }`}
          aria-hidden={viewMode !== "contact"}
        >
          {showContact && <TrainingContactForm contactData={contactData} programSlug={programSlug} programTitle={programTitle} />}
        </div>
      </div>
    </section>
  );
}

function TrainingContactForm({
  contactData,
  programSlug,
  programTitle,
}: {
  readonly contactData?: TTrainingContactSection;
  readonly programSlug: string;
  readonly programTitle: string;
}) {
  const labels = { ...DEFAULT_CONTACT_LABELS, ...contactData };
  const [formData, setFormData] = useState<TrainingContactFormData>({
    name: "",
    email: "",
    phone: "",
    location: "",
    instagram: "",
    privacyPolicyConsent: false,
  });
  const [fieldErrors, setFieldErrors] = useState<ValidationErrors>({});
  const [touchedFields, setTouchedFields] = useState<Set<string>>(new Set());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitStatus, setSubmitStatus] = useState<{ type: "success" | "error" | null; message: string }>({
    type: null,
    message: "",
  });

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value, type, checked } = event.target;
    const fieldValue = type === "checkbox" ? checked : value;
    setFormData((current) => ({ ...current, [name]: fieldValue }));

    if (touchedFields.has(name) && TRAINING_CONTACT_VALIDATION[name]) {
      setFieldErrors((current) => ({
        ...current,
        [name]: validateField(String(fieldValue), TRAINING_CONTACT_VALIDATION[name]),
      }));
    }
  };

  const handleBlur = (event: React.FocusEvent<HTMLInputElement>) => {
    const { name, value } = event.target;
    if (!TRAINING_CONTACT_VALIDATION[name]) return;

    setTouchedFields((current) => new Set(current).add(name));
    setFieldErrors((current) => ({
      ...current,
      [name]: validateField(value, TRAINING_CONTACT_VALIDATION[name]),
    }));
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const { errors, isValid } = validateForm(
      {
        name: formData.name,
        email: formData.email,
        phone: formData.phone,
        location: formData.location,
        instagram: formData.instagram,
        privacyPolicyConsent: formData.privacyPolicyConsent,
      },
      TRAINING_CONTACT_VALIDATION,
    );
    setFieldErrors(errors);
    setTouchedFields(new Set(Object.keys(TRAINING_CONTACT_VALIDATION)));
    if (!isValid) return;

    setIsSubmitting(true);
    setSubmitStatus({ type: null, message: "" });

    const result: FormActionResult = await submitTrainingContact({
      name: formData.name,
      email: formData.email,
      phone: formData.phone,
      location: formData.location || undefined,
      instagram: formData.instagram || undefined,
      programSlug,
      programTitle,
      marketingConsent: false,
      consentText: TRAINING_CONTACT_CONSENT_TEXT,
      privacyPolicyConsent: formData.privacyPolicyConsent,
      sourcePath: window.location.pathname,
    });

    if (result.success) {
      setSubmitStatus({ type: "success", message: labels.successMessage });
      setFormData({ name: "", email: "", phone: "", location: "", instagram: "", privacyPolicyConsent: false });
      setFieldErrors({});
      setTouchedFields(new Set());
    } else {
      if (result.fieldErrors) {
        setFieldErrors(result.fieldErrors);
        setTouchedFields(new Set(Object.keys(result.fieldErrors)));
      }
      setSubmitStatus({ type: "error", message: result.error ?? "Something went wrong, please try again." });
    }

    setIsSubmitting(false);
  };

  return (
    <div className="overflow-hidden rounded-[28px] border border-lh-line bg-lh-white shadow-[0_24px_70px_rgba(28,19,24,0.08)]">
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)]">
        <div className="relative overflow-hidden bg-lh-shadow p-8 text-lh-neutral-2 md:p-10 lg:p-12">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_18%,var(--lh-light-soft),transparent_30%),linear-gradient(145deg,var(--lh-shadow),var(--lh-accent)_58%,var(--lh-primary))]" aria-hidden="true" />
          <div className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-lh-shadow to-transparent" aria-hidden="true" />
          <div className="relative z-10">
            <p className="eyebrow-label mb-4 text-lh-light">Training Contact</p>
            <h2 className="section-heading text-balance text-lh-neutral-2">{labels.heading}</h2>
            {labels.subHeading && (
              <p className="mt-5 font-body text-base font-bold leading-8 text-lh-neutral-2/78 md:text-lg">
                {labels.subHeading}
              </p>
            )}
            <div className="mt-10 border-t border-lh-neutral-2/20 pt-6">
              <p className="font-heading text-xs font-normal uppercase tracking-[0.28em] text-lh-light">Program</p>
              <p className="mt-2 font-heading text-3xl font-normal leading-none text-lh-neutral-2 md:text-4xl">
                {programTitle}
              </p>
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-8 md:p-10 lg:p-12">
          <FieldGroup className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="training-contact-name">{labels.name}*</FieldLabel>
              <Input
                id="training-contact-name"
                name="name"
                required
                type="text"
                value={formData.name}
                onChange={handleChange}
                onBlur={handleBlur}
                aria-invalid={touchedFields.has("name") && !!fieldErrors.name}
                aria-describedby={fieldErrors.name ? "training-contact-name-error" : undefined}
                placeholder="Enter your full name"
              />
              {touchedFields.has("name") && fieldErrors.name && (
                <FieldError id="training-contact-name-error">{fieldErrors.name}</FieldError>
              )}
            </Field>

            <Field>
              <FieldLabel htmlFor="training-contact-email">{labels.email}*</FieldLabel>
              <Input
                id="training-contact-email"
                name="email"
                required
                type="email"
                value={formData.email}
                onChange={handleChange}
                onBlur={handleBlur}
                aria-invalid={touchedFields.has("email") && !!fieldErrors.email}
                aria-describedby={fieldErrors.email ? "training-contact-email-error" : undefined}
                placeholder="you@example.com"
              />
              {touchedFields.has("email") && fieldErrors.email && (
                <FieldError id="training-contact-email-error">{fieldErrors.email}</FieldError>
              )}
            </Field>

            <Field>
              <FieldLabel htmlFor="training-contact-phone">{labels.phone}*</FieldLabel>
              <Input
                id="training-contact-phone"
                name="phone"
                required
                type="tel"
                value={formData.phone}
                onChange={handleChange}
                onBlur={handleBlur}
                aria-invalid={touchedFields.has("phone") && !!fieldErrors.phone}
                aria-describedby={fieldErrors.phone ? "training-contact-phone-error" : undefined}
                placeholder="(123) 456-7890"
              />
              {touchedFields.has("phone") && fieldErrors.phone && (
                <FieldError id="training-contact-phone-error">{fieldErrors.phone}</FieldError>
              )}
            </Field>

            <Field>
              <FieldLabel htmlFor="training-contact-location">{labels.location}</FieldLabel>
              <Input
                id="training-contact-location"
                name="location"
                type="text"
                value={formData.location}
                onChange={handleChange}
                placeholder="City or region"
              />
            </Field>

            <Field className="md:col-span-2">
              <FieldLabel htmlFor="training-contact-instagram">{labels.instagram}</FieldLabel>
              <Input
                id="training-contact-instagram"
                name="instagram"
                type="text"
                value={formData.instagram}
                onChange={handleChange}
                placeholder="@yourhandle"
              />
            </Field>
          </FieldGroup>

          {labels.privacyPolicyText && labels.privacyPolicyText.length > 0 && (
            <div className="mt-6">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  name="privacyPolicyConsent"
                  checked={formData.privacyPolicyConsent}
                  onChange={handleChange}
                  onBlur={handleBlur}
                  className="mt-1 h-4 w-4 rounded border-lh-line text-lh-primary focus:ring-lh-primary"
                  aria-invalid={touchedFields.has("privacyPolicyConsent") && !!fieldErrors.privacyPolicyConsent}
                  aria-describedby={
                    fieldErrors.privacyPolicyConsent ? "training-contact-privacy-error" : undefined
                  }
                />
                <div className="text-sm text-lh-shadow/80">
                  <PortableTextRenderer content={labels.privacyPolicyText} />
                </div>
              </label>
              {touchedFields.has("privacyPolicyConsent") && fieldErrors.privacyPolicyConsent && (
                <FieldError id="training-contact-privacy-error" className="mt-2">
                  {fieldErrors.privacyPolicyConsent}
                </FieldError>
              )}
            </div>
          )}

          <div aria-live="polite" role="status">
            {submitStatus.type && (
              <div
                className={`mt-6 rounded-[22px] border p-4 font-body text-sm font-bold ${
                  submitStatus.type === "success"
                    ? "border-lh-line bg-lh-neutral-2 text-lh-shadow"
                    : "border-lh-accent/25 bg-lh-accent/5 text-lh-accent"
                }`}
              >
                {submitStatus.message}
              </div>
            )}
          </div>

          <Button type="submit" variant="dark" size="lg" className="mt-8 w-full rounded-full py-6" disabled={isSubmitting}>
            {isSubmitting ? "Submitting..." : labels.submitLabel}
          </Button>
        </form>
      </div>
    </div>
  );
}
