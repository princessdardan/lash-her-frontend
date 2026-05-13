import type { TLayoutBlock, TSchedule, TContactInfo, TGeneralInquiryLabels } from "@/types";
import { GeneralInquiryLayout, IGeneralInquiryLayoutProps } from "@/components/custom/collection/general-inquiry";

interface ContactContentProps {
  blocks: TLayoutBlock[];
  pageData: {
    title: string;
    subTitle: string;
    description: string;
  };
}

export function ContactContent({ blocks, pageData }: ContactContentProps) {
  const scheduleBlock = blocks.find(block => block._type === "schedule") as TSchedule | undefined;
  const contactInfoBlock = blocks.find(block => block._type === "contactInfo") as TContactInfo | undefined;
  const generalInquiryBlock = blocks.find(block => block._type === "generalInquiryLabels") as TGeneralInquiryLabels | undefined;

  const layoutData: IGeneralInquiryLayoutProps = {
    title: pageData.title,
    subTitle: pageData.subTitle,
    description: pageData.description,
    scheduleData: scheduleBlock!,
    contactInfoData: contactInfoBlock!,
    generalInquiryData: generalInquiryBlock!,
  };

  return <GeneralInquiryLayout data={layoutData} />;
}
