"use client";

import { Suspense, useState } from "react";
import { usePathname } from "next/navigation";
import type { TContactFormLabels } from "@/types";
import { Button } from "@/components/ui/button";
import { ScrollToForm } from "@/components/ui/scroll-to-form";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldError,
} from "@/components/ui/field";
import { Input } from "../../ui/input";
import { ContactInfo, IContactInfoProps } from "../layouts/contact-info";
import { IScheduleProps, Schedule } from "../layouts/schedule";
import {
  validateField,
  validateForm,
  type FieldValidationConfig,
  type ValidationErrors,
} from "@/lib/form-validation";
import { submitTrainingContact, type FormActionResult } from "@/app/actions/form";


export type { TContactFormLabels as IContactFormLabelsProps } from "@/types";

type FormData = {
  name: string;
  email: string;
  phone: string;
  location: string;
  instagram: string;
  marketingConsent: boolean;
};

const TRAINING_CONTACT_CONSENT_TEXT = "I agree to receive training updates, program news, and offers from Lash Her by Nataliea.";

const styles = {
    input: "form-input",
};

const CONTACT_VALIDATION_CONFIG: FieldValidationConfig = {
  name: [{ type: "required", message: "Name is required" }],
  email: [
    { type: "required", message: "Email is required" },
    { type: "email", message: "Please enter a valid email address" },
  ],
  phone: [
    { type: "required", message: "Phone number is required" },
    { type: "phone", message: "Please enter a valid phone number" },
  ],
  location: [{ type: "required", message: "Location is required" }],
  instagram: [{ type: "required", message: "Instagram handle is required" }],
};

export function ContactFormLabels({ data }: { data: TContactFormLabels }) {
  const pathname = usePathname();
  const [formData, setFormData] = useState<FormData>({
    name: "",
    email: "",
    phone: "",
    location: "",
    instagram: "",
    marketingConsent: false,
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitStatus, setSubmitStatus] = useState<{
    type: "success" | "error" | null;
    message: string;
  }>({ type: null, message: "" });
  const [fieldErrors, setFieldErrors] = useState<ValidationErrors>({});
  const [touchedFields, setTouchedFields] = useState<Set<string>>(new Set());

  if (!data) return null;

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));
    if (touchedFields.has(name) && CONTACT_VALIDATION_CONFIG[name]) {
      setFieldErrors((prev) => ({
        ...prev,
        [name]: validateField(value, CONTACT_VALIDATION_CONFIG[name]),
      }));
    }
  };

  const handleBlur = (
    e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    const { name, value } = e.target;
    if (!CONTACT_VALIDATION_CONFIG[name]) return;
    setTouchedFields((prev) => new Set(prev).add(name));
    setFieldErrors((prev) => ({
      ...prev,
      [name]: validateField(value, CONTACT_VALIDATION_CONFIG[name]),
    }));
  };

  const handleMarketingConsentChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData((prev) => ({ ...prev, marketingConsent: e.target.checked }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const { errors, isValid } = validateForm({
      name: formData.name,
      email: formData.email,
      phone: formData.phone,
      location: formData.location,
      instagram: formData.instagram,
    }, CONTACT_VALIDATION_CONFIG);
    setFieldErrors(errors);
    setTouchedFields(new Set(Object.keys(CONTACT_VALIDATION_CONFIG)));
    if (!isValid) return;

    setIsSubmitting(true);
    setSubmitStatus({ type: null, message: "" });

    const result: FormActionResult = await submitTrainingContact({
      name: formData.name,
      email: formData.email,
      phone: formData.phone,
      location: formData.location || undefined,
      instagram: formData.instagram || undefined,
      programSlug: "legacy-training-contact",
      programTitle: "Training Inquiry",
      marketingConsent: formData.marketingConsent,
      consentText: TRAINING_CONTACT_CONSENT_TEXT,
      sourcePath: pathname,
    });

    if (result.success) {
      setSubmitStatus({
        type: "success",
        message: "Thank you! Your submission has been received.",
      });
      setFormData({
        name: "",
        email: "",
        phone: "",
        location: "",
        instagram: "",
        marketingConsent: false,
      });
      setFieldErrors({});
      setTouchedFields(new Set());
    } else {
      // D-03: Hydrate field-level errors from server-side validation
      if (result.fieldErrors) {
        setFieldErrors(result.fieldErrors);
        setTouchedFields(new Set(Object.keys(result.fieldErrors)));
      }
      setSubmitStatus({
        type: "error",
        message: result.error ?? "Something went wrong, please try again.",
      });
    }

    setIsSubmitting(false);
  };

    return (
      <section id="training-contact" className="w-full max-w-4xl mx-auto scroll-mt-40">
        <Suspense fallback={null}>
          <ScrollToForm formId="training-contact" />
        </Suspense>
        <section className="soft-panel relative flex flex-col">
          <header className="mb-10">
              <h2 className="section-heading text-lh-primary mb-3">{data.heading}</h2>
              <p className="body-lead text-lh-shadow">{data.subHeading}</p>
          </header>

            <form onSubmit={handleSubmit} className="space-y-6">
                <FieldGroup className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Name */}
                <Field>
                    <FieldLabel htmlFor="name">{data.name}*</FieldLabel>
                    <Input
                    id="name"
                    name="name"
                    type="text"
                    required
                    value={formData.name}
                    onChange={handleChange}
                    onBlur={handleBlur}
                    aria-invalid={touchedFields.has("name") && !!fieldErrors.name}
                    aria-describedby={fieldErrors.name ? "contact-name-error" : undefined}
                    placeholder="Enter your full name"
                    className={styles.input}
                    />
                    {touchedFields.has("name") && fieldErrors.name && (
                      <FieldError id="contact-name-error">{fieldErrors.name}</FieldError>
                    )}
                </Field>

                {/* Email */}
                <Field>
                    <FieldLabel htmlFor="email">{data.email}*</FieldLabel>
                    <Input
                    id="email"
                    name="email"
                    type="email"
                    required
                    value={formData.email}
                    onChange={handleChange}
                    onBlur={handleBlur}
                    aria-invalid={touchedFields.has("email") && !!fieldErrors.email}
                    aria-describedby={fieldErrors.email ? "contact-email-error" : undefined}
                    placeholder="your.email@example.com"
                    className={styles.input}
                    />
                    {touchedFields.has("email") && fieldErrors.email && (
                      <FieldError id="contact-email-error">{fieldErrors.email}</FieldError>
                    )}
                </Field>

                {/* Phone */}
                <Field>
                    <FieldLabel htmlFor="phone">{data.phone}*</FieldLabel>
                    <Input
                    id="phone"
                    name="phone"
                    type="tel"
                    required
                    value={formData.phone}
                    onChange={handleChange}
                    onBlur={handleBlur}
                    aria-invalid={touchedFields.has("phone") && !!fieldErrors.phone}
                    aria-describedby={fieldErrors.phone ? "contact-phone-error" : undefined}
                    placeholder="(123) 456-7890"
                    className={styles.input}
                    />
                    {touchedFields.has("phone") && fieldErrors.phone && (
                      <FieldError id="contact-phone-error">{fieldErrors.phone}</FieldError>
                    )}
                </Field>

                {/* Location */}
                <Field>
                    <FieldLabel htmlFor="location">{data.location}*</FieldLabel>
                    <Input
                    id="location"
                    name="location"
                    type="text"
                    required
                    value={formData.location}
                    onChange={handleChange}
                    onBlur={handleBlur}
                    aria-invalid={touchedFields.has("location") && !!fieldErrors.location}
                    aria-describedby={fieldErrors.location ? "contact-location-error" : undefined}
                    placeholder="Your City"
                    className={styles.input}
                    />
                    {touchedFields.has("location") && fieldErrors.location && (
                      <FieldError id="contact-location-error">{fieldErrors.location}</FieldError>
                    )}
                </Field>

                {/* Instagram */}
                <Field>
                    <FieldLabel htmlFor="instagram">{data.instagram}*</FieldLabel>
                    <Input
                    id="instagram"
                    name="instagram"
                    type="text"
                    required
                    value={formData.instagram}
                    onChange={handleChange}
                    onBlur={handleBlur}
                    aria-invalid={touchedFields.has("instagram") && !!fieldErrors.instagram}
                    aria-describedby={fieldErrors.instagram ? "contact-instagram-error" : undefined}
                    placeholder="@your_username"
                    className={styles.input}
                    />
                    {touchedFields.has("instagram") && fieldErrors.instagram && (
                      <FieldError id="contact-instagram-error">{fieldErrors.instagram}</FieldError>
                    )}
                </Field>

                </FieldGroup>

                <div className="flex items-start gap-3 rounded-2xl border border-lh-line bg-lh-neutral-2/40 p-4">
                  <input
                    id="training-marketing-consent"
                    name="marketingConsent"
                    type="checkbox"
                    checked={formData.marketingConsent}
                    onChange={handleMarketingConsentChange}
                    className="mt-1 h-4 w-4 rounded border-lh-line text-lh-primary focus:ring-lh-primary"
                  />
                  <label htmlFor="training-marketing-consent" className="body-small text-lh-shadow leading-snug">
                    {TRAINING_CONTACT_CONSENT_TEXT}
                  </label>
                </div>

                {/* Submit Status */}
                <div aria-live="polite" role="status">
                  {submitStatus.type && (
                    <div
                      className={`p-4 rounded-md border ${
                        submitStatus.type === "success"
                          ? "bg-lh-neutral-2 text-lh-shadow border-lh-line"
                          : "bg-lh-white text-lh-accent border-lh-accent-soft"
                      }`}
                    >
                      {submitStatus.message}
                    </div>
                  )}
                </div>

                {/* Submit Button */}
                <Button type="submit" disabled={isSubmitting} className="w-full rounded-full bg-lh-primary px-6 py-3 font-body font-bold text-lh-white transition-colors hover:bg-lh-accent">
                {isSubmitting ? "Submitting..." : "Send Application"}
                </Button>
            </form>
        </section>
      </section>
  );
}

// ============================================
// COMBINED CONTACT PAGE LAYOUT
// ============================================

export interface IContactPageLayoutProps {
    title: string;
    subTitle: string;
    description: string;
    scheduleData: IScheduleProps;
    contactInfoData: IContactInfoProps;
    contactFormData: TContactFormLabels;
}

export function ContactPageLayout({data}:{data: IContactPageLayoutProps}) {
  return (
    <section className="section-shell">
        <div className="content-container">
            <header className="text-container">
              <h2 className="section-heading">{data.title}</h2>
              <h3 className="section-subheading">{data.subTitle}</h3>
              <p className="section-description">{data.description}</p>
            </header>
            <div className="grid grid-cols-1 lg:grid-cols-[5fr_8fr] gap-12 lg:gap-24">
                {/* Left Column - Schedule and Contact Info */}
                <aside>
                    {data.contactInfoData && <ContactInfo data={data.contactInfoData} />}
                    {data.scheduleData && <Schedule data={data.scheduleData} />}
                </aside>

                {/* Right Column - Contact Form */}
                <section>
                    {data.contactFormData && <ContactFormLabels data={data.contactFormData} />}
                </section>
            </div>
        </div>
    </section>
  );
}
