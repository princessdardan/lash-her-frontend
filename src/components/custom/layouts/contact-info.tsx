import type { TContactInfo, TContact } from "@/types";
import { MailIcon, MapPinIcon, PhoneIcon } from "lucide-react";

export type { TContactInfo as IContactInfoProps } from "@/types";

export function ContactInfo({ data }: { data: TContactInfo }) {
    if (!data?.contact) return null;

    const { heading, subHeading, contact } = data;
    return (
        <div className="w-full max-w-lg md:max-w-none mx-auto px-4 py-6 md:px-0 md:py-0 xl:max-w-xl xl:py-0">
            <div className="dark-panel relative flex flex-col p-6 md:p-4 xl:p-8">
                <h2 className="text-2xl xl:text-3xl text-lh-neutral-2 font-heading mb-2">{heading}</h2>
                <p className="text-lh-light font-heading tracking-widest uppercase mb-4 xl:mb-8">{subHeading}</p>
                <div className="space-y-4 xl:space-y-8">
                    {contact.map((item: TContact, index: number) => (
                        <div key={item._key || index} className="space-y-3 xl:space-y-6">
                            <div className="flex items-start gap-3 xl:gap-4">
                                <PhoneIcon className="w-5 h-5 mt-1 text-lh-light shrink-0" aria-hidden="true" />
                                <div>
                                    <h3 className="font-heading text-lg xl:text-xl text-lh-neutral-2 mb-1">Phone Number</h3>
                                    <a href={`tel:${item.phone.replace(/\s+/g, '')}`} className="text-lh-neutral-2/80 hover:text-lh-light transition-colors font-body">
                                      {item.phone}
                                    </a>
                                </div>
                            </div>
                            <div className="w-full h-[1px] bg-lh-light/20" />
                            <div className="flex items-start gap-3 xl:gap-4">
                                <MailIcon className="w-5 h-5 mt-1 text-lh-light shrink-0" aria-hidden="true" />
                                <div>
                                    <h3 className="font-heading text-lg xl:text-xl text-lh-neutral-2 mb-1">Email</h3>
                                    <a href={`mailto:${item.email}`} className="text-lh-neutral-2/80 hover:text-lh-light transition-colors font-body">
                                      {item.email}
                                    </a>
                                </div>
                            </div>
                            <div className="w-full h-[1px] bg-lh-light/20" />
                            <div className="flex items-start gap-3 xl:gap-4">
                                <MapPinIcon className="w-5 h-5 mt-1 text-lh-light shrink-0" aria-hidden="true" />
                                <div>
                                    <h3 className="font-heading text-lg xl:text-xl text-lh-neutral-2 mb-1">Location</h3>
                                    <address className="text-lh-neutral-2/80 not-italic font-body">{item.location}</address>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
