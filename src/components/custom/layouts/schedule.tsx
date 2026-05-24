import type { TSchedule, THours } from "@/types";

export type { TSchedule as IScheduleProps } from "@/types";

export function Schedule({ data }: { data: TSchedule }) {
    if (!data?.hours) return null;

    const { heading, subHeading, hours } = data;
    return (
        <div className="w-full max-w-lg md:max-w-none mx-auto px-4 pb-4 md:px-0 md:pb-0 xl:max-w-xl">
            <div className="soft-panel relative flex flex-col p-5 md:p-4 xl:p-6">
                <h2 className="text-2xl xl:text-3xl font-heading text-lh-shadow mb-1">{heading}</h2>
                <p className="text-lh-primary font-heading tracking-widest uppercase mb-3 xl:mb-5">{subHeading}</p>
                <div className="space-y-0.5 xl:space-y-2">
                    {hours.map((item: THours, index: number) => (
                        <div key={item._key || index} className="flex justify-between items-center gap-4 py-1.5 xl:py-2 border-b border-lh-line last:border-0">
                            <div className="font-heading text-base xl:text-lg text-lh-shadow">{item.days}</div>
                            <div className="font-body text-sm xl:text-base text-lh-shadow/80">{item.times}</div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    )
}
