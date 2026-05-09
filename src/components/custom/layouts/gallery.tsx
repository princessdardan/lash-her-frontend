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
                className="w-[min(400px,90vw)] h-[500px] md:w-[480px] md:h-[640px] rounded-[24px] shadow-sm cursor-grab active:cursor-grabbing overflow-hidden"
                style={{ transformPerspective: 800, x, rotateY, scale, willChange: 'transform, opacity' }}
            >
                <SanityImage
                    image={img}
                    alt={img.alt || `Gallery image showcasing lash artistry ${index + 1}`}
                    className="w-full h-full object-cover pointer-events-none select-none"
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
            className="absolute -bottom-12 left-1/2 -translate-x-1/2 flex gap-3 z-10"
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
                        "w-2 h-2 rounded-full transition-all duration-300",
                        currentPage === i
                            ? "bg-lh-shadow w-6"
                            : "bg-lh-shadow/20 hover:bg-lh-shadow/40"
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
        <section className="section-shell overflow-hidden">
            <div className="container mx-auto max-w-2xl">
                <div className="text-container max-w-4xl mx-auto text-center mb-16">
                    <h2 className="section-heading">{heading}</h2>
                    <p className="font-heading text-lh-primary text-xl md:text-2xl lg:text-3xl mt-4">{subHeading}</p>
                    {description && (
                        <p className="mx-auto mt-6 max-w-2xl text-lh-shadow/80 leading-relaxed">{description}</p>
                    )}
                </div>
            </div>
            <div className="container mx-auto overflow-hidden">
                <div className="flex items-center justify-center min-h-[550px] md:min-h-[700px] pb-16">
                    <div className="relative">
                        <Carousel
                            className="w-[min(400px,90vw)] h-[500px] md:w-[480px] md:h-[640px] flex items-center justify-center mx-auto"
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
