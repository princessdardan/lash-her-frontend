import type { TSchedule, THours } from "@/types";

export type { TSchedule as IScheduleProps } from "@/types";

export function Schedule({ data }: { data: TSchedule }) {
    if (!data?.hours) return null;

    const { heading, subHeading, hours } = data;
    return (
        <div className="w-full max-w-lg md:max-w-xl mx-auto px-4 pb-6">
            <div className="rounded-lg bg-white border border-brand-red p-6 shadow-sm transition-shadow hover:shadow-md relative flex flex-col">
                <h2 className="text-2xl font-bold text-brand-red mb-4 font-serif">{heading}</h2>
                <p className="text-center text-brand-red mb-4">{subHeading}</p>
                <div>
                    {hours.map((item: THours, index: number) => (
                        <div key={item._key || index} className="flex justify-between py-2">
                            <div className="font-bold text-xl font-serif text-brand-red">{item.days}</div>
                            <div className="font-sans font-light text-black">{item.times}</div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    )
}
