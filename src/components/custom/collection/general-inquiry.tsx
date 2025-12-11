"use client";

import { api } from "@/data/data-api";
import { getStrapiURL } from "@/lib/utils";
import { TGeneralInquiry } from "@/types";
import { useState } from "react";
import { Button } from "../../ui/button";
import { Field, FieldGroup, FieldLabel } from "../../ui/field";
import { Textarea } from "../../ui/textarea";
import { Input } from "../../ui/input";
import { ContactInfo, IContactInfoProps } from "../layouts/contact-info";
import { IScheduleProps, Schedule } from "../layouts/schedule";

export interface IGeneralInquiryProps {
    id: number;
    __component: string;
    heading: string;
    subHeading: string;
    name: string;
    email: string;
    phone: string;
    instagram: string;
    message: string;
}

type InquiryData = {
    name: string;
    email: string;
    phone: string;
    instagram: string;
    message: string;
}

const styles = {
    input: "flex h-9 w-full rounded-md border border-input bg-brand-pink px-3 py-1 text-base shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
};


export function GeneralInquiryForm({data}: { data: IGeneralInquiryProps }) {
    
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
              instagram: formData.instagram || undefined,
              message: formData.message || undefined,
            },
          };
    
          const strapiURL = getStrapiURL();
          const response = await api.post<TGeneralInquiry>(
            `${strapiURL}/api/general-inquiries`,
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
              instagram: "",
              message: "",
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
      <div className="w-full max-w-4xl mx-auto px-4 py-6">
        <div className="rounded-lg border bg-white border-gray-700 my-4 p-6 shadow-sm transition-shadow hover:shadow-md relative flex flex-col">
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
                placeholder="What are you inquiring about?"
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
  );

}

export interface IGeneralInquiryLayoutProps {
    id: number;
    documentId: string;
    title: string;
    subTitle: string;
    description: string;
    scheduleData: IScheduleProps;
    contactInfoData: IContactInfoProps;
    generalInquiryData: IGeneralInquiryProps;
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
            <div className="grid grid-cols-1 lg:grid-cols-13">
                {/* Left Column - Schedule and Contact Info (2/5) */}
                <div className="lg:col-span-5">
                    {data.contactInfoData && <ContactInfo data={data.contactInfoData} />}
                    {data.scheduleData && <Schedule data={data.scheduleData} />}
                </div>

                {/* Right Column - General Inquiry Form (3/5) */}
                <div className="lg:col-span-8">
                    {data.generalInquiryData && <GeneralInquiryForm data={data.generalInquiryData} />}
                </div>
            </div>
        </div>
    </section>
  );
}
