import type { TContactInfo, TContact } from "@/types";
import { MailIcon, MapPinIcon, PhoneIcon } from "lucide-react";

export type { TContactInfo as IContactInfoProps } from "@/types";

export function ContactInfo({ data }: { data: TContactInfo }) {
    if (!data?.contact) return null;

    const { heading, subHeading, contact } = data;
    return (
        <div className="w-full max-w-lg md:max-w-none mx-auto px-4 py-4 md:px-0 md:py-0 xl:max-w-xl xl:py-0">
            <div className="dark-panel relative flex flex-col p-5 md:p-4 xl:p-6">
                <h2 className="text-2xl xl:text-3xl text-lh-neutral-2 font-heading mb-1">{heading}</h2>
                <p className="text-lh-light font-heading tracking-widest uppercase mb-3 xl:mb-5">{subHeading}</p>
                <div className="space-y-3 xl:space-y-5">
                    {contact.map((item: TContact, index: number) => (
                        <div key={item._key || index} className="space-y-2.5 xl:space-y-4">
                            <div className="flex items-start gap-3">
                                <PhoneIcon className="w-4.5 h-4.5 mt-1 text-lh-light shrink-0" aria-hidden="true" />
                                <div>
                                    <h3 className="font-heading text-base xl:text-lg text-lh-neutral-2 mb-0.5">Phone Number</h3>
                                    <a href={`tel:${item.phone.replace(/\s+/g, '')}`} className="text-lh-neutral-2/80 hover:text-lh-light transition-colors font-body">
                                      {item.phone}
                                    </a>
                                </div>
                            </div>
                            <div className="w-full h-[1px] bg-lh-light/20" />
                            <div className="flex items-start gap-3">
                                <MailIcon className="w-4.5 h-4.5 mt-1 text-lh-light shrink-0" aria-hidden="true" />
                                <div>
                                    <h3 className="font-heading text-base xl:text-lg text-lh-neutral-2 mb-0.5">Email</h3>
                                    <a href={`mailto:${item.email}`} className="text-lh-neutral-2/80 hover:text-lh-light transition-colors font-body">
                                      {item.email}
                                    </a>
                                </div>
                            </div>
                            <div className="w-full h-[1px] bg-lh-light/20" />
                            <div className="flex items-start gap-3">
                                <MapPinIcon className="w-4.5 h-4.5 mt-1 text-lh-light shrink-0" aria-hidden="true" />
                                <div>
                                    <h3 className="font-heading text-base xl:text-lg text-lh-neutral-2 mb-0.5">Location</h3>
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
