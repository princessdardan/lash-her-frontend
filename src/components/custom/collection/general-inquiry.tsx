"use client";

import type { TGeneralInquiryLabels, TSchedule, TContactInfo } from "@/types";
import { Suspense, useState } from "react";
import { Button } from "../../ui/button";
import { Field, FieldGroup, FieldLabel, FieldError } from "../../ui/field";
import { Textarea } from "../../ui/textarea";
import { Input } from "../../ui/input";
import { ScrollToForm } from "@/components/ui/scroll-to-form";
import { ContactInfo, IContactInfoProps } from "../layouts/contact-info";
import { IScheduleProps, Schedule } from "../layouts/schedule";
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
}

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

    const [formData, setFormData] = useState<InquiryData>({
        name: "",
        email: "",
        phone: "",
        instagram: "",
        message: "",
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
        const { errors, isValid } = validateForm(formData, VALIDATION_CONFIG);
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
      <div id="general-inquiry" className="w-full max-w-4xl mx-auto px-4 py-6 scroll-mt-40">
        <Suspense fallback={null}>
          <ScrollToForm formId="general-inquiry" />
        </Suspense>
        <div className="rounded-lg border bg-white border-brand-red my-4 p-6 shadow-sm transition-shadow hover:shadow-md relative flex flex-col">
          <div className="mb-8">
            <h2 className="text-2xl font-bold text-brand-red font-serif mb-2">{data.heading}</h2>
            <p className="text-black max-w-xl">{data.subHeading}</p>
          </div>

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
                  aria-describedby={fieldErrors.name ? "name-error" : undefined}
                  placeholder="Enter your full name"
                  className={styles.input}
                />
                {touchedFields.has("name") && fieldErrors.name && (
                  <FieldError id="name-error">{fieldErrors.name}</FieldError>
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
                  aria-describedby={fieldErrors.email ? "email-error" : undefined}
                  placeholder="your.email@example.com"
                  className={styles.input}
                />
                {touchedFields.has("email") && fieldErrors.email && (
                  <FieldError id="email-error">{fieldErrors.email}</FieldError>
                )}
              </Field>

              {/* Phone */}
              <Field>
                <FieldLabel htmlFor="phone">{data.phone}</FieldLabel>
                <Input
                  id="phone"
                  name="phone"
                  type="tel"
                  value={formData.phone}
                  onChange={handleChange}
                  placeholder="(123) 456-7890"
                  className={styles.input}
                />
              </Field>

              {/* Instagram */}
              <Field>
                <FieldLabel htmlFor="instagram">{data.instagram}</FieldLabel>
                <Input
                  id="instagram"
                  name="instagram"
                  type="text"
                  value={formData.instagram}
                  onChange={handleChange}
                  placeholder="@your_username"
                  className={styles.input}
                />
              </Field>
            </FieldGroup>

            {/* Message - Full Width */}
            <Field>
              <FieldLabel htmlFor="message">{data.message}*</FieldLabel>
              <Textarea
                id="message"
                name="message"
                rows={4}
                required
                value={formData.message}
                onChange={handleChange}
                onBlur={handleBlur}
                aria-invalid={touchedFields.has("message") && !!fieldErrors.message}
                aria-describedby={fieldErrors.message ? "message-error" : undefined}
                placeholder="What are you inquiring about?"
                className="form-textarea"
              />
              {touchedFields.has("message") && fieldErrors.message && (
                <FieldError id="message-error">{fieldErrors.message}</FieldError>
              )}
            </Field>

            {/* Submit Status */}
            <div aria-live="polite" role="status">
              {submitStatus.type && (
                <div
                  className={`p-4 rounded-md ${
                    submitStatus.type === "success"
                      ? "bg-green-50 text-green-800 dark:bg-green-900/20 dark:text-green-400"
                      : "bg-red-50 text-red-800 dark:bg-red-900/20 dark:text-red-400"
                  }`}
                >
                  {submitStatus.message}
                </div>
              )}
            </div>

            {/* Submit Button */}
            <Button type="submit" disabled={isSubmitting} className="btn-primary-red">
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
    <section className="px-8 py-4 mx-auto md:px-6 lg:py-12 bg-brand-pink">
        <div className="content-container">
            <div className="text-container">
            <h2 className="section-heading-red ">{data.title}</h2>
            <p className="section-subheading-white">{data.subTitle}</p>
            <p className="section-description">{data.description}</p>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-[5fr_8fr]">
                {/* Left Column - Schedule and Contact Info */}
                <div>
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
