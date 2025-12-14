import { THours } from "@/types";

export interface IScheduleProps {
  id: number;
  __component: string;
  heading: string;
  subHeading: string;
  hours: THours[];
}

export function Schedule({ data }: { data: IScheduleProps }) {
    if (!data?.hours) return null;

    const { heading, subHeading, hours } = data;
    return (
        <div className="w-full max-w-xl md:max-w-lg mx-auto px-4 pb-6">
            <div className="rounded-lg bg-white border border-brand-red p-6 shadow-sm transition-shadow hover:shadow-md relative flex flex-col">
                <h2 className="text-2xl font-bold text-brand-red mb-4 font-serif">{heading}</h2>
                <p className="text-center text-brand-red mb-4">{subHeading}</p>
                <div>
                    {hours.map((item: THours) => (
                        <div key={item.id} className="flex justify-between py-2">
                            <div className="font-bold text-xl font-serif text-brand-red">{item.days}</div>
                            <div className="font-sans font-light text-black">{item.times}</div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    )
}