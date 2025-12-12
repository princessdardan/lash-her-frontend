"use client";

import { useState } from "react";
import { TContactForm } from "@/types";
import { api } from "@/data/data-api";
import { getStrapiURL } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldGroup,
  FieldLabel,
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


export interface IContactFormLabelsProps {
  id: number;
  __component: string;
  heading: string;
  subHeading: string;
  name: string;
  email: string;
  phone: string;
  location: string;
  instagram: string;
  experience: string;
  interest: string;
  clients: string;
  info: string;
}

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
    input: "flex h-9 w-full rounded-md border border-input bg-brand-pink px-3 py-1 text-base shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
};

export function ContactFormLabels({ data }: { data: IContactFormLabelsProps }) {
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

  if (!data) return null;

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    setFormData((prev) => ({
      ...prev,
      [e.target.name]: e.target.value,
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setSubmitStatus({ type: null, message: "" });

    try {
      const payload = {
        data: {
          name: formData.name,
          email: formData.email,
          phone: formData.phone,
          location: formData.location,
          instagram: formData.instagram || undefined,
          experience: formData.experience,
          interest: formData.interest,
          clients: formData.clients ? parseInt(formData.clients) : undefined,
          info: formData.info || undefined,
        },
      };

      const strapiURL = getStrapiURL();
      const response = await api.post<TContactForm>(
        `${strapiURL}/api/contact-forms`,
        payload
      );

      if (response.success) {
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
      } else {
        setSubmitStatus({
          type: "error",
          message:
            response.error?.message || "Something went wrong. Please try again.",
        });
      }
    } catch {
      setSubmitStatus({
        type: "error",
        message: "Failed to submit form. Please try again.",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

    return (
      <section className="bg-brand-pink">
        <div className="w-full bg-brand-pink max-w-4xl mx-auto px-4 py-6">
          <div className="rounded-lg border bg-white text-black border-gray-700 my-4 p-6 shadow-sm transition-shadow hover:shadow-md relative flex flex-col">
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
                    placeholder="Enter your full name"
                    className={styles.input}
                    />
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
                    placeholder="your.email@example.com"
                    className={styles.input}
                    />
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
                    placeholder="(123) 456-7890"
                    className={styles.input}
                    />
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
                    placeholder="Your City"
                    className={styles.input}
                    />
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
                    placeholder="@your_username"
                    className={styles.input}
                    />
                </Field>

                {/* Experience */}
                    <Field>
                        <FieldLabel htmlFor="experience">
                        {data.experience}*
                        </FieldLabel>
                        <Select
                        value={formData.experience}
                        onValueChange={(value: string) =>
                            setFormData((prev) => ({ ...prev, experience: value }))
                        }
                        required
                        >
                        <SelectTrigger className={styles.input} id="experience">
                            <SelectValue placeholder="Select experience level" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="Beginner - New to Lashes">Beginner - New to Lashes</SelectItem>
                            <SelectItem value="Advanced - Have Experience">Advanced - Have Experience</SelectItem>
                        </SelectContent>
                        </Select>
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
                        onValueChange={(value: string) =>
                            setFormData((prev) => ({ ...prev, interest: value }))
                        }
                        required
                        >
                        <SelectTrigger className={styles.input} id="interest">
                            <SelectValue placeholder="Select training interest" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="Two-Week Mentorship Course">Two-Week Mentorship Course</SelectItem>
                            <SelectItem value="Beginner Private Training">Beginner Private Training</SelectItem>
                            <SelectItem value="Advanced Private Training">Advanced Private Training</SelectItem>
                            <SelectItem value="Not Sure Yet">Not Sure Yet</SelectItem>
                        </SelectContent>
                        </Select>
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
                    className="flex min-h-20 bg-brand-pink w-full rounded-md border border-input px-3 py-2 text-base shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm"
                />
                </Field>

                {/* Submit Status */}
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

                {/* Submit Button */}
                <Button type="submit" disabled={isSubmitting} className="w-full">
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
    id: number;
    documentId: string;
    title: string;
    subTitle: string;
    description: string;
    scheduleData: IScheduleProps;
    contactInfoData: IContactInfoProps;
    contactFormData: IContactFormLabelsProps;
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
            <div className="grid grid-cols-1 lg:grid-cols-13">
                {/* Left Column - Schedule and Contact Info (2/5) */}
                <div className="lg:col-span-5">
                    {data.contactInfoData && <ContactInfo data={data.contactInfoData} />}
                    {data.scheduleData && <Schedule data={data.scheduleData} />}
                </div>

                {/* Right Column - Contact Form (3/5) */}
                <div className="lg:col-span-8">
                    {data.contactFormData && <ContactFormLabels data={data.contactFormData} />}
                </div>
            </div>
        </div>
    </section>
  );
}
