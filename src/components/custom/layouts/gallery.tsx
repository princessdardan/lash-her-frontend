"use client"

import type { TPhotoGallery, TSanityImage } from "@/types";
import { SanityImage } from "../../ui/sanity-image";
import { Carousel, useCarousel, useTickerItem } from "motion-plus/react";
import { motion, useTransform } from "motion/react";
import { cn } from "@/lib/utils";

export type { TPhotoGallery as IGalleryProps } from "@/types";

function CoverflowItem({ img, index }: { img: TSanityImage; index: number }) {
    const { offset, props } = useTickerItem();

    const rotateY = useTransform(offset, [-200, 0, 200], [20, 0, -20]);
    const scale = useTransform(offset, [-200, 0, 200], [0.7, 1, 0.7]);
    const x = useTransform(
        offset,
        [-800, -200, 200, 800],
        ["100%", "0%", "0%", "-100%"]
    );
    const zIndex = useTransform(offset, (value) =>
        Math.max(0, Math.round(1000 - Math.abs(value)))
    );

    return (
        <motion.li {...props} style={{ ...props.style, zIndex }}>
            <motion.div
                className="w-[min(400px,90vw)] h-[600px] md:w-[480px] md:h-[720px] rounded-xl shadow-[0_10px_40px_rgba(0,0,0,0.3)] cursor-grab active:cursor-grabbing"
                style={{ transformPerspective: 500, x, rotateY, scale, willChange: 'transform, opacity' }}
            >
                <SanityImage
                    image={img}
                    alt={img.alt || `Gallery image showcasing lash artistry ${index + 1}`}
                    className="w-full h-full object-cover rounded-lg shadow-lg pointer-events-none select-none"
                    width={480}
                    height={720}
                />
            </motion.div>
        </motion.li>
    );
}

function PaginationDots() {
    const { currentPage, totalPages, gotoPage } = useCarousel();

    if (totalPages <= 1) return null;

    return (
        <div
            className="absolute -bottom-10 left-1/2 -translate-x-1/2 flex gap-2 z-10"
            role="tablist"
            aria-label="Gallery pages"
        >
            {Array.from({ length: totalPages }, (_, i) => (
                <button
                    key={i}
                    role="tab"
                    aria-selected={currentPage === i}
                    aria-label={`Go to page ${i + 1}`}
                    onClick={() => gotoPage(i)}
                    className={cn(
                        "w-2.5 h-2.5 rounded-full transition-all",
                        currentPage === i
                            ? "bg-brand-red scale-110"
                            : "bg-brand-red/30 hover:bg-brand-red/60"
                    )}
                />
            ))}
        </div>
    );
}

export function Gallery({ data }: { data: TPhotoGallery }) {
    if (!data) return null;

    const { heading, subHeading, description, images } = data;

    return (
        <section className="px-2 py-4 mx-auto md:px-6 lg:pt-12 lg:pb-16 bg-brand-pink overflow-hidden">
            <div className="container mx-auto max-w-2xl">
                <div className="text-container max-w-4xl mx-auto">
                    <h2 className="section-heading-red ">{heading}</h2>
                    <p className="font-light text-black text-xl md:text-2xl lg:text-3xl">{subHeading}</p>
                    {description && (
                        <p className="mx-auto mt-4 max-w-2xl text-brand-black">{description}</p>
                    )}
                </div>
            </div>
            <div className="container mx-auto overflow-hidden">
                <div className="mask-gradient flex items-center justify-center min-h-[650px] md:min-h-[780px] pb-12">
                    <div className="relative">
                        <Carousel
                            className="w-[min(400px,90vw)] h-[600px] md:w-[480px] md:h-[720px] flex items-center justify-center mx-auto"
                            items={images.map((img, index) => (
                                <CoverflowItem key={img.asset?._ref || index} img={img} index={index} />
                            ))}
                            overflow
                            gap={0}
                            itemSize="manual"
                            safeMargin={200}
                        >
                            <PaginationDots />
                        </Carousel>
                    </div>
                </div>
            </div>
        </section>
    );
}
