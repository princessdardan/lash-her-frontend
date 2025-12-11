import { TContact } from "@/types";
import { MailIcon, MapPinIcon, PhoneIcon } from "lucide-react";

export interface IContactInfoProps {
  id: number;
  __component: string;
  heading: string;
  subHeading: string;
  contact: TContact[];
}

export function ContactInfo({ data }: { data: IContactInfoProps }) {
    if (!data?.contact) return null;

    const { heading, subHeading, contact } = data;
    return (
        <div className="w-full max-w-lg mx-auto px-8 py-6">
            <div className="rounded-lg bg-white border border-brand-red text-black p-6 my-4 shadow-sm transition-shadow hover:shadow-md relative flex flex-col">
                <h2 className="text-2xl text-brand-red font-bold font-serif">{heading}</h2>
                <p className="text-md text-black mb-2">{subHeading}</p>
                <div className="py-4">
                    {contact.map((item: TContact) => (
                        <div key={item.id} className="mb-4 space-y-3">
                            <div className="flex items-start gap-3">
                                <PhoneIcon className="w-5 h-5 mt-0.5 pt-1 text-black shrink-0" />
                                <div>
                                    <h3 className="font-bold text-brand-red text-xl font-serif">Phone Number</h3>
                                    <p className="text-black">{item.phone}</p>
                                </div>
                            </div>
                            <div className="flex items-start gap-3">
                                <MailIcon className="w-5 h-5 mt-0.5 pt-1 text-black shrink-0" />
                                <div>
                                    <h3 className="font-bold text-brand-red text-xl font-serif">Email</h3>
                                    <p className="text-black">{item.email}</p>
                                </div>
                            </div>
                            <div className="flex items-start gap-3">
                                <MapPinIcon className="w-5 h-5 mt-0.5 pt-1 text-black shrink-0" />
                                <div>
                                    <h3 className="font-bold text-brand-red text-xl font-serif">Location</h3>
                                    <p className="text-black">{item.location}</p>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
