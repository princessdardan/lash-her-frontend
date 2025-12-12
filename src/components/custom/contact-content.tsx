import { IContactInfoProps } from "@/components/custom/layouts/contact-info";
import { GeneralInquiryLayout, IGeneralInquiryLayoutProps, IGeneralInquiryProps } from "@/components/custom/collection/general-inquiry";
import { IScheduleProps } from "@/components/custom/layouts/schedule";

export type TContactPageBlocks = IScheduleProps | IContactInfoProps | IGeneralInquiryProps;

interface ContactContentProps {
  blocks: TContactPageBlocks[];
  pageData: {
    id: number;
    documentId: string;
    title: string;
    subTitle: string;
    description: string;
  };
}

export function ContactContent({ blocks, pageData }: ContactContentProps) {
    const scheduleBlock = blocks.find(block => block.__component === "layout.schedule") as IScheduleProps;
    const contactInfoBlock = blocks.find(block => block.__component === "layout.contact-info") as IContactInfoProps;
    const generalInquiryBlock = blocks.find(block => block.__component === "layout.general-inquiry-labels") as IGeneralInquiryProps;

    const layoutData: IGeneralInquiryLayoutProps = {
        id: pageData.id,
        documentId: pageData.documentId,
        title: pageData.title,
        subTitle: pageData.subTitle,
        description: pageData.description,
        scheduleData: scheduleBlock,
        contactInfoData: contactInfoBlock,
        generalInquiryData: generalInquiryBlock
    };

    return <GeneralInquiryLayout data={layoutData} />;
}
