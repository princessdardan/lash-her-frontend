"use client";

import { Suspense, useState } from "react";
import type { TContactFormLabels } from "@/types";
import { Button } from "@/components/ui/button";
import { ScrollToForm } from "@/components/ui/scroll-to-form";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldError,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "../../ui/textarea";
import { Input } from "../../ui/input";
import { ContactInfo, IContactInfoProps } from "../layouts/contact-info";
import { IScheduleProps, Schedule } from "../layouts/schedule";
import {
  validateField,
  validateForm,
  type FieldValidationConfig,
  type ValidationErrors,
} from "@/lib/form-validation";


export type { TContactFormLabels as IContactFormLabelsProps } from "@/types";

type FormData = {
  name: string;
  email: string;
  phone: string;
  location: string;
  instagram: string;
  experience: string;
  interest: string;
  clients: string;
  info: string;
};

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
  experience: [{ type: "required", message: "Please select your experience level" }],
  interest: [{ type: "required", message: "Please select your training interest" }],
};

export function ContactFormLabels({ data }: { data: TContactFormLabels }) {
  const [formData, setFormData] = useState<FormData>({
    name: "",
    email: "",
    phone: "",
    location: "",
    instagram: "",
    experience: "",
    interest: "",
    clients: "",
    info: "",
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

  const handleSelectChange = (name: string, value: string) => {
    setFormData((prev) => ({ ...prev, [name]: value }));
    setTouchedFields((prev) => new Set(prev).add(name));
    if (CONTACT_VALIDATION_CONFIG[name]) {
      setFieldErrors((prev) => ({
        ...prev,
        [name]: validateField(value, CONTACT_VALIDATION_CONFIG[name]),
      }));
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const { errors, isValid } = validateForm(formData, CONTACT_VALIDATION_CONFIG);
    setFieldErrors(errors);
    setTouchedFields(new Set(Object.keys(CONTACT_VALIDATION_CONFIG)));
    if (!isValid) return;

    setIsSubmitting(true);
    setSubmitStatus({ type: null, message: "" });

    // TODO: Phase 4 — replace with Server Action writing to Sanity + Resend email
    console.warn("Form submission disabled — pending Phase 4 implementation");
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
      experience: "",
      interest: "",
      clients: "",
      info: "",
    });
    setFieldErrors({});
    setTouchedFields(new Set());
    setIsSubmitting(false);
  };

    return (
      <section id="training-contact" className="bg-brand-pink scroll-mt-40">
        <Suspense fallback={null}>
          <ScrollToForm formId="training-contact" />
        </Suspense>
        <div className="w-full bg-brand-pink max-w-4xl mx-auto px-4 py-6">
          <div className="rounded-lg border bg-white text-black border-brand-red my-4 p-6 shadow-sm transition-shadow hover:shadow-md relative flex flex-col">
            <div className="mb-8">
                <h2 className="text-xl mb-2 font-heading">{data.heading}</h2>
                <p className="text-muted-foreground">{data.subHeading}</p>
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

                {/* Experience */}
                    <Field>
                        <FieldLabel htmlFor="experience">
                        {data.experience}*
                        </FieldLabel>
                        <Select
                        value={formData.experience}
                        onValueChange={(value: string) => handleSelectChange("experience", value)}
                        required
                        >
                        <SelectTrigger
                          className={styles.input}
                          id="experience"
                          aria-invalid={touchedFields.has("experience") && !!fieldErrors.experience}
                          aria-describedby={fieldErrors.experience ? "contact-experience-error" : undefined}
                        >
                            <SelectValue placeholder="Select experience level" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="Beginner - New to Lashes">Beginner - New to Lashes</SelectItem>
                            <SelectItem value="Advanced - Have Experience">Advanced - Have Experience</SelectItem>
                        </SelectContent>
                        </Select>
                        {touchedFields.has("experience") && fieldErrors.experience && (
                          <FieldError id="contact-experience-error">{fieldErrors.experience}</FieldError>
                        )}
                    </Field>

                    {/* Clients */}
                    <Field>
                        <FieldLabel htmlFor="clients">
                        {data.clients}
                        </FieldLabel>
                        <Input
                        id="clients"
                        name="clients"
                        type="number"
                        value={formData.clients}
                        onChange={handleChange}
                        placeholder="e.g., 5"
                        className={styles.input}
                        />
                    </Field>

                    {/* Interest */}
                    <Field>
                        <FieldLabel htmlFor="interest">
                        {data.interest}*
                        </FieldLabel>
                        <Select
                        value={formData.interest}
                        onValueChange={(value: string) => handleSelectChange("interest", value)}
                        required
                        >
                        <SelectTrigger
                          className={styles.input}
                          id="interest"
                          aria-invalid={touchedFields.has("interest") && !!fieldErrors.interest}
                          aria-describedby={fieldErrors.interest ? "contact-interest-error" : undefined}
                        >
                            <SelectValue placeholder="Select training interest" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="Lash Designer Academy">Lash Designer Academy</SelectItem>
                            <SelectItem value="Beginner Private Training">Beginner Private Training</SelectItem>
                            <SelectItem value="Beginner Group Training">Beginner Group Training</SelectItem>
                            <SelectItem value="Advanced Private Training">Advanced Private Training</SelectItem>
                            <SelectItem value="Not Sure Yet">Not Sure Yet</SelectItem>
                        </SelectContent>
                        </Select>
                        {touchedFields.has("interest") && fieldErrors.interest && (
                          <FieldError id="contact-interest-error">{fieldErrors.interest}</FieldError>
                        )}
                    </Field>
                </FieldGroup>

                {/* Info - Full Width */}
                <Field>
                <FieldLabel htmlFor="info">{data.info}</FieldLabel>
                <Textarea
                    id="info"
                    name="info"
                    rows={4}
                    value={formData.info}
                    onChange={handleChange}
                    placeholder="Tell us more about your goals and what you hope to achieve..."
                    className="form-textarea"
                />
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
                {isSubmitting ? "Submitting..." : "Submit"}
                </Button>
            </form>
          </div>
        </div>
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
    <section className="section-container-pink">
        <div className="content-container">
            <div className="text-container">
              <h2 className="section-heading-red">{data.title}</h2>
              <h3 className="section-subheading-white">{data.subTitle}</h3>
              <p className="section-description">{data.description}</p>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-[5fr_8fr]">
                {/* Left Column - Schedule and Contact Info */}
                <div>
                    {data.contactInfoData && <ContactInfo data={data.contactInfoData} />}
                    {data.scheduleData && <Schedule data={data.scheduleData} />}
                </div>

                {/* Right Column - Contact Form */}
                <div>
                    {data.contactFormData && <ContactFormLabels data={data.contactFormData} />}
                </div>
            </div>
        </div>
    </section>
  );
}
