"use client";

import type { TGeneralInquiryLabels, TSchedule, TContactInfo } from "@/types";
import { Suspense, useState } from "react";
import { usePathname } from "next/navigation";
import { Button } from "../../ui/button";
import { Field, FieldGroup, FieldLabel, FieldError } from "../../ui/field";
import { Textarea } from "../../ui/textarea";
import { Input } from "../../ui/input";
import { ScrollToForm } from "@/components/ui/scroll-to-form";
import { ContactInfo } from "../layouts/contact-info";
import { Schedule } from "../layouts/schedule";
import {
  validateField,
  validateForm,
  type FieldValidationConfig,
  type ValidationErrors,
} from "@/lib/form-validation";
import { submitGeneralInquiry, type FormActionResult } from "@/app/actions/form";

export type { TGeneralInquiryLabels as IGeneralInquiryProps } from "@/types";

type InquiryData = {
    name: string;
    email: string;
    phone: string;
    instagram: string;
    message: string;
    marketingConsent: boolean;
}

const GENERAL_INQUIRY_CONSENT_TEXT = "I agree to receive lash care tips, service updates, and offers from Lash Her by Nataliea.";

const styles = {
    input: "form-input",
};

const VALIDATION_CONFIG: FieldValidationConfig = {
  name: [{ type: "required", message: "Name is required" }],
  email: [
    { type: "required", message: "Email is required" },
    { type: "email", message: "Please enter a valid email address" },
  ],
  message: [{ type: "required", message: "Message is required" }],
};

export function GeneralInquiryForm({data}: { data: TGeneralInquiryLabels }) {
    const pathname = usePathname();

    const [formData, setFormData] = useState<InquiryData>({
        name: "",
        email: "",
        phone: "",
        instagram: "",
        message: "",
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
        // Re-validate on change if field was already touched
        if (touchedFields.has(name) && VALIDATION_CONFIG[name]) {
          setFieldErrors((prev) => ({
            ...prev,
            [name]: validateField(value, VALIDATION_CONFIG[name]),
          }));
        }
      };

      const handleMarketingConsentChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setFormData((prev) => ({
          ...prev,
          marketingConsent: e.target.checked,
        }));
      };

      const handleBlur = (
        e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>
      ) => {
        const { name, value } = e.target;
        if (!VALIDATION_CONFIG[name]) return;
        setTouchedFields((prev) => new Set(prev).add(name));
        setFieldErrors((prev) => ({
          ...prev,
          [name]: validateField(value, VALIDATION_CONFIG[name]),
        }));
      };

      const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        // Validate all fields
        const { errors, isValid } = validateForm({
          name: formData.name,
          email: formData.email,
          phone: formData.phone,
          instagram: formData.instagram,
          message: formData.message,
        }, VALIDATION_CONFIG);
        setFieldErrors(errors);
        setTouchedFields(new Set(Object.keys(VALIDATION_CONFIG)));
        if (!isValid) return;

        setIsSubmitting(true);
        setSubmitStatus({ type: null, message: "" });

        const result: FormActionResult = await submitGeneralInquiry({
          name: formData.name,
          email: formData.email,
          phone: formData.phone || undefined,
          instagram: formData.instagram || undefined,
          message: formData.message,
          marketingConsent: formData.marketingConsent,
          consentText: GENERAL_INQUIRY_CONSENT_TEXT,
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
            instagram: "",
            message: "",
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
      <div id="general-inquiry" className="w-full scroll-mt-40 xl:max-w-4xl xl:mx-auto">
        <Suspense fallback={null}>
          <ScrollToForm formId="general-inquiry" />
        </Suspense>
        <div className="soft-panel relative flex flex-col p-4 xl:p-6">
          <div className="mb-4 xl:mb-6">
            <h2 className="section-heading text-lh-primary mb-1.5 md:text-3xl xl:text-5xl">{data.heading}</h2>
            <p className="body-lead text-lh-shadow max-w-xl md:text-sm md:leading-6 xl:text-base xl:leading-7">{data.subHeading}</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-3 xl:space-y-4">
            <FieldGroup className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:gap-4">
              {/* Name */}
              <Field className="gap-1.5">
                <FieldLabel htmlFor="name" className="text-sm">{data.name}*</FieldLabel>
                <Input
                  id="name"
                  name="name"
                  type="text"
                  required
                  value={formData.name}
                  onChange={handleChange}
                  onBlur={handleBlur}
                  aria-invalid={touchedFields.has("name") && !!fieldErrors.name}
                  aria-describedby={fieldErrors.name ? "name-error" : undefined}
                  placeholder="Enter your full name"
                  className={`${styles.input} h-10 xl:h-10`}
                />
                {touchedFields.has("name") && fieldErrors.name && (
                  <FieldError id="name-error" className="text-xs">{fieldErrors.name}</FieldError>
                )}
              </Field>

              {/* Email */}
              <Field className="gap-1.5">
                <FieldLabel htmlFor="email" className="text-sm">{data.email}*</FieldLabel>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  required
                  value={formData.email}
                  onChange={handleChange}
                  onBlur={handleBlur}
                  aria-invalid={touchedFields.has("email") && !!fieldErrors.email}
                  aria-describedby={fieldErrors.email ? "email-error" : undefined}
                  placeholder="your.email@example.com"
                  className={`${styles.input} h-10 xl:h-10`}
                />
                {touchedFields.has("email") && fieldErrors.email && (
                  <FieldError id="email-error" className="text-xs">{fieldErrors.email}</FieldError>
                )}
              </Field>

              {/* Phone */}
              <Field className="gap-1.5">
                <FieldLabel htmlFor="phone" className="text-sm">{data.phone}</FieldLabel>
                <Input
                  id="phone"
                  name="phone"
                  type="tel"
                  value={formData.phone}
                  onChange={handleChange}
                  placeholder="(123) 456-7890"
                  className={`${styles.input} h-10 xl:h-10`}
                />
              </Field>

              {/* Instagram */}
              <Field className="gap-1.5">
                <FieldLabel htmlFor="instagram" className="text-sm">{data.instagram}</FieldLabel>
                <Input
                  id="instagram"
                  name="instagram"
                  type="text"
                  value={formData.instagram}
                  onChange={handleChange}
                  placeholder="@your_username"
                  className={`${styles.input} h-10 xl:h-10`}
                />
              </Field>
            </FieldGroup>

            {/* Message - Full Width */}
            <Field className="gap-1.5">
              <FieldLabel htmlFor="message" className="text-sm">{data.message}*</FieldLabel>
              <Textarea
                id="message"
                name="message"
                rows={3}
                required
                value={formData.message}
                onChange={handleChange}
                onBlur={handleBlur}
                aria-invalid={touchedFields.has("message") && !!fieldErrors.message}
                aria-describedby={fieldErrors.message ? "message-error" : undefined}
                placeholder="What are you inquiring about?"
                className="form-textarea min-h-20 md:min-h-20 xl:min-h-24"
              />
              {touchedFields.has("message") && fieldErrors.message && (
                <FieldError id="message-error" className="text-xs">{fieldErrors.message}</FieldError>
              )}
            </Field>

            <div className="flex items-start gap-2.5 rounded-lg border border-lh-line bg-lh-neutral-2/40 p-2.5 xl:p-3">
              <input
                id="general-marketing-consent"
                name="marketingConsent"
                type="checkbox"
                checked={formData.marketingConsent}
                onChange={handleMarketingConsentChange}
                className="mt-1 h-4 w-4 rounded border-lh-line text-lh-primary focus:ring-lh-primary"
              />
              <label htmlFor="general-marketing-consent" className="body-small text-lh-shadow leading-snug">
                {GENERAL_INQUIRY_CONSENT_TEXT}
              </label>
            </div>

            {/* Submit Status */}
            <div aria-live="polite" role="status">
              {submitStatus.type && (
                <div
                  className={`rounded-md border p-3 text-sm ${
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
            <Button type="submit" disabled={isSubmitting} className="w-full rounded-full bg-lh-primary px-6 py-2.5 font-body font-bold text-lh-white transition-colors hover:bg-lh-accent">
              {isSubmitting ? "Submitting..." : "Send Inquiry"}
            </Button>
          </form>
      </div>
    </div>
  );

}

export interface IGeneralInquiryLayoutProps {
    title: string;
    subTitle: string;
    description: string;
    scheduleData: TSchedule;
    contactInfoData: TContactInfo;
    generalInquiryData: TGeneralInquiryLabels;
}

export function GeneralInquiryLayout({data}:{data: IGeneralInquiryLayoutProps}) {
  return (
    <section className="section-shell">
        <div className="content-container">
            <div className="text-container">
            <h1 className="section-heading">{data.title}</h1>
            <p className="section-subheading">{data.subTitle}</p>
            <p className="section-description">{data.description}</p>
            </div>
            <div className="grid grid-cols-1 gap-6 md:grid-cols-[minmax(15rem,0.82fr)_minmax(0,1.35fr)] md:items-start md:gap-5 xl:grid-cols-[5fr_8fr] xl:gap-16">
                {/* Left Column - Schedule and Contact Info */}
                <div className="grid gap-4 md:gap-4 xl:gap-5">
                    {data.contactInfoData && <ContactInfo data={data.contactInfoData} />}
                    {data.scheduleData && <Schedule data={data.scheduleData} />}
                </div>

                {/* Right Column - General Inquiry Form */}
                <div>
                    {data.generalInquiryData && <GeneralInquiryForm data={data.generalInquiryData} />}
                </div>
            </div>
        </div>
    </section>
  );
}
