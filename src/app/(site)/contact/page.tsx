import { IContactInfoProps } from "@/components/custom/layouts/contact-info";
import { GeneralInquiryLayout, IGeneralInquiryLayoutProps, IGeneralInquiryProps } from "@/components/custom/collection/general-inquiry";
import { IScheduleProps } from "@/components/custom/layouts/schedule";
import { loaders } from "@/data/loaders";
import { validateApiResponse } from "@/lib/error-handler";

export type TContactPageBlocks = IScheduleProps | IContactInfoProps | IGeneralInquiryProps;

export default async function ContactPage() {
    const contactPageData  = await loaders.getContactPageData();
    const data = validateApiResponse(contactPageData, "contact page");
    const {blocks} = data;

    const scheduleBlock = blocks.find(block => block.__component === "layout.schedule") as IScheduleProps;
    const contactInfoBlock = blocks.find(block => block.__component === "layout.contact-info") as IContactInfoProps;
    const generalInquiryBlock = blocks.find(block => block.__component === "layout.general-inquiry-labels") as IGeneralInquiryProps;

    const layoutData: IGeneralInquiryLayoutProps = {
        id: data.id,
        documentId: data.documentId,
        title: data.title,
        subTitle: data.subTitle,
        description: data.description,
        scheduleData: scheduleBlock,
        contactInfoData: contactInfoBlock,
        generalInquiryData: generalInquiryBlock
    };

    return (
        <main>
            <GeneralInquiryLayout data={layoutData} />
        </main>
    );
}