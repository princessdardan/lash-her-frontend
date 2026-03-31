import { notFound } from "next/navigation";
import { loaders } from "@/data/loaders";
import { GeneralInquiryLayout, IGeneralInquiryLayoutProps } from "@/components/custom/collection/general-inquiry";
import type { TSchedule, TContactInfo, TGeneralInquiryLabels } from "@/types";
import { buildPageMetadata } from "@/lib/metadata";

// Revalidate every 30 minutes (1800 seconds)
export const revalidate = 1800;

export const metadata = buildPageMetadata({
  title: "Contact Us",
  description:
    "Get in touch with Lash Her by Nataliea for inquiries about lash services, training programs, and appointments.",
});

export default async function ContactPage() {
  const data = await loaders.getContactPageData();
  if (!data) notFound();

  const { blocks } = data;

  const scheduleBlock = blocks.find(block => block._type === "schedule") as TSchedule | undefined;
  const contactInfoBlock = blocks.find(block => block._type === "contactInfo") as TContactInfo | undefined;
  const generalInquiryBlock = blocks.find(block => block._type === "generalInquiryLabels") as TGeneralInquiryLabels | undefined;

  const layoutData: IGeneralInquiryLayoutProps = {
    title: data.title,
    subTitle: data.subTitle,
    description: data.description,
    scheduleData: scheduleBlock!,
    contactInfoData: contactInfoBlock!,
    generalInquiryData: generalInquiryBlock!,
  };

  return <GeneralInquiryLayout data={layoutData} />;
}
