"use client"

import { useState } from "react";
import type { TPhotoGallery } from "@/types";
import { SanityImage } from "../../ui/sanity-image";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";

export type { TPhotoGallery as IGalleryProps } from "@/types";

export function Gallery({ data }: { data: TPhotoGallery }) {
    const [currentIndex, setCurrentIndex] = useState(0);

    if (!data) return null;

    const { heading, subHeading, description, images } = data;
    const hasImages = images && images.length > 0;

    const next = () => {
        setCurrentIndex((prev: number) => (prev + 1) % images.length);
    };

    const prev = () => {
        setCurrentIndex((prev: number) => (prev - 1 + images.length) % images.length);
    };

    const gotoPage = (index: number) => {
        setCurrentIndex(index);
    };

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
            {hasImages && (
                <div className="container mx-auto overflow-hidden">
                    <div className="flex items-center justify-center min-h-[550px] md:min-h-[700px] pb-16 relative">
                        <div className="relative w-full max-w-[1000px] h-[500px] md:h-[640px] flex items-center justify-center" style={{ perspective: 1000 }}>
                            {images.map((img, index) => {
                                let offset = index - currentIndex;
                                if (offset > images.length / 2) offset -= images.length;
                                if (offset < -images.length / 2) offset += images.length;

                                const isActive = offset === 0;
                                const isVisible = Math.abs(offset) <= 2;

                                if (!isVisible) return null;

                                const scale = isActive ? 1 : 0.7;
                                const rotateY = offset * -20;
                                const zIndex = 10 - Math.abs(offset);
                                const x = `${offset * 60}%`;

                                return (
                                    <motion.div
                                        key={img.asset?._ref || index}
                                        className="absolute w-[min(400px,90vw)] h-[500px] md:w-[480px] md:h-[640px] rounded-[24px] shadow-sm overflow-hidden cursor-pointer"
                                        initial={false}
                                        animate={{
                                            x,
                                            scale,
                                            rotateY,
                                            zIndex,
                                            opacity: 1 - Math.abs(offset) * 0.2
                                        }}
                                        transition={{ duration: 0.4, ease: "easeOut" }}
                                        onClick={() => gotoPage(index)}
                                    >
                                        <SanityImage
                                            image={img}
                                            alt={img.alt || `Gallery image showcasing lash artistry ${index + 1}`}
                                            className="object-cover pointer-events-none select-none"
                                            fill
                                            sizes="(min-width: 768px) 480px, min(400px, 90vw)"
                                        />
                                    </motion.div>
                                );
                            })}
                        </div>

                        {images.length > 1 && (
                            <>
                                <div className="absolute top-1/2 -translate-y-1/2 w-full max-w-[1000px] flex justify-between px-4 md:px-0 pointer-events-none z-20">
                                    <button
                                        onClick={prev}
                                        className="w-12 h-12 rounded-full bg-white/80 backdrop-blur-sm shadow-md flex items-center justify-center pointer-events-auto hover:bg-white transition-colors text-lh-shadow md:-ml-6"
                                        aria-label="Previous image"
                                    >
                                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
                                    </button>
                                    <button
                                        onClick={next}
                                        className="w-12 h-12 rounded-full bg-white/80 backdrop-blur-sm shadow-md flex items-center justify-center pointer-events-auto hover:bg-white transition-colors text-lh-shadow md:-mr-6"
                                        aria-label="Next image"
                                    >
                                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6"/></svg>
                                    </button>
                                </div>

                                <div
                                    className="absolute -bottom-12 left-1/2 -translate-x-1/2 flex gap-3 z-10"
                                    role="tablist"
                                    aria-label="Gallery pages"
                                >
                                    {images.map((_, i) => (
                                        <button
                                            key={i}
                                            role="tab"
                                            aria-selected={currentIndex === i}
                                            aria-label={`Go to page ${i + 1}`}
                                            onClick={() => gotoPage(i)}
                                            className={cn(
                                                "w-2 h-2 rounded-full transition-all duration-300",
                                                currentIndex === i
                                                    ? "bg-lh-shadow w-6"
                                                    : "bg-lh-shadow/20 hover:bg-lh-shadow/40"
                                            )}
                                        />
                                    ))}
                                </div>
                            </>
                        )}
                    </div>
                </div>
            )}
        </section>
    );
}
