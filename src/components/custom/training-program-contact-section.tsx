"use client";

import { usePathname } from "next/navigation";
import { useState } from "react";

import { submitTrainingContact, type FormActionResult } from "@/app/actions/form";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { validateField, validateForm, type FieldValidationConfig, type ValidationErrors } from "@/lib/form-validation";
import type { TTrainingContactSection } from "@/types";

interface TrainingProgramContactSectionProps {
  readonly data?: TTrainingContactSection;
  readonly programSlug: string;
  readonly programTitle: string;
  readonly hasPurchaseUi?: boolean;
}

type TrainingContactFormData = {
  name: string;
  email: string;
  phone: string;
  location: string;
  instagram: string;
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
};

const DEFAULT_LABELS = {
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

export function TrainingProgramContactSection({
  data,
  programSlug,
  programTitle,
  hasPurchaseUi = false,
}: TrainingProgramContactSectionProps) {
  const pathname = usePathname();
  const labels = { ...DEFAULT_LABELS, ...data };
  const [formData, setFormData] = useState<TrainingContactFormData>({
    name: "",
    email: "",
    phone: "",
    location: "",
    instagram: "",
  });
  const [fieldErrors, setFieldErrors] = useState<ValidationErrors>({});
  const [touchedFields, setTouchedFields] = useState<Set<string>>(new Set());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitStatus, setSubmitStatus] = useState<{ type: "success" | "error" | null; message: string }>({
    type: null,
    message: "",
  });

  if (data?.enabled === false) return null;

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = event.target;
    setFormData((current) => ({ ...current, [name]: value }));

    if (touchedFields.has(name) && TRAINING_CONTACT_VALIDATION[name]) {
      setFieldErrors((current) => ({
        ...current,
        [name]: validateField(value, TRAINING_CONTACT_VALIDATION[name]),
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
      sourcePath: pathname,
    });

    if (result.success) {
      setSubmitStatus({ type: "success", message: labels.successMessage });
      setFormData({ name: "", email: "", phone: "", location: "", instagram: "" });
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
    <section id="contact" className="scroll-mt-32 py-8 md:py-12 lg:py-16" data-training-contact-section="true">
      <div className={hasPurchaseUi ? "lg:pr-[24rem] xl:pr-[26rem]" : undefined}>
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
      </div>
    </section>
  );
}
