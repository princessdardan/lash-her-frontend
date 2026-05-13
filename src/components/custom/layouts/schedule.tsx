import type { TSchedule, THours } from "@/types";

export type { TSchedule as IScheduleProps } from "@/types";

export function Schedule({ data }: { data: TSchedule }) {
    if (!data?.hours) return null;

    const { heading, subHeading, hours } = data;
    return (
        <div className="w-full max-w-lg md:max-w-xl mx-auto px-4 pb-6">
            <div className="soft-panel relative flex flex-col p-8 md:p-10">
                <h2 className="text-3xl font-heading text-lh-shadow mb-2">{heading}</h2>
                <p className="text-lh-primary font-heading tracking-widest uppercase mb-8">{subHeading}</p>
                <div className="space-y-4">
                    {hours.map((item: THours, index: number) => (
                        <div key={item._key || index} className="flex justify-between items-center py-3 border-b border-lh-line last:border-0">
                            <div className="font-heading text-xl text-lh-shadow">{item.days}</div>
                            <div className="font-body text-lh-shadow/80">{item.times}</div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    )
}
