import type { TContactInfo, TContact } from "@/types";
import { MailIcon, MapPinIcon, PhoneIcon } from "lucide-react";

export type { TContactInfo as IContactInfoProps } from "@/types";

export function ContactInfo({ data }: { data: TContactInfo }) {
    if (!data?.contact) return null;

    const { heading, subHeading, contact } = data;
    return (
        <div className="w-full max-w-lg md:max-w-xl mx-auto px-4 py-6">
            <div className="dark-panel relative flex flex-col p-8 md:p-10">
                <h2 className="text-3xl text-lh-neutral-2 font-heading mb-2">{heading}</h2>
                <p className="text-lh-light font-heading tracking-widest uppercase mb-8">{subHeading}</p>
                <div className="space-y-8">
                    {contact.map((item: TContact, index: number) => (
                        <div key={item._key || index} className="space-y-6">
                            <div className="flex items-start gap-4">
                                <PhoneIcon className="w-5 h-5 mt-1 text-lh-light shrink-0" aria-hidden="true" />
                                <div>
                                    <h3 className="font-heading text-xl text-lh-neutral-2 mb-1">Phone Number</h3>
                                    <a href={`tel:${item.phone.replace(/\s+/g, '')}`} className="text-lh-neutral-2/80 hover:text-lh-light transition-colors font-body">
                                      {item.phone}
                                    </a>
                                </div>
                            </div>
                            <div className="w-full h-[1px] bg-lh-light/20" />
                            <div className="flex items-start gap-4">
                                <MailIcon className="w-5 h-5 mt-1 text-lh-light shrink-0" aria-hidden="true" />
                                <div>
                                    <h3 className="font-heading text-xl text-lh-neutral-2 mb-1">Email</h3>
                                    <a href={`mailto:${item.email}`} className="text-lh-neutral-2/80 hover:text-lh-light transition-colors font-body">
                                      {item.email}
                                    </a>
                                </div>
                            </div>
                            <div className="w-full h-[1px] bg-lh-light/20" />
                            <div className="flex items-start gap-4">
                                <MapPinIcon className="w-5 h-5 mt-1 text-lh-light shrink-0" aria-hidden="true" />
                                <div>
                                    <h3 className="font-heading text-xl text-lh-neutral-2 mb-1">Location</h3>
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
