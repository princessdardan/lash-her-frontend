"use client"

import { TImage } from "@/types";
import { StrapiImage } from "../../ui/strapi-image";
import { Carousel, useTickerItem } from "motion-plus/react";
import { motion, useTransform } from "motion/react";

export interface IGalleryProps {
    id: number;
    documentId: string;
    __component: string;
    heading: string;
    subHeading: string;
    description: string;
    image: TImage[];
}

function CoverflowItem({ img, index }: { img: TImage; index: number }) {
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
                className="w-[400px] h-[600px] md:w-[480px] md:h-[720px] rounded-xl shadow-[0_10px_40px_rgba(0,0,0,0.3)]"
                style={{ transformPerspective: 500, x, rotateY, scale, willChange: 'transform, opacity' }}
            >
                <StrapiImage
                    src={img.url}
                    alt={img.alternativeText || `Gallery image ${index + 1}`}
                    className="w-full h-full object-cover rounded-lg shadow-lg"
                    width={480}
                    height={720}
                />
            </motion.div>
        </motion.li>
    );
}

export function Gallery({ data }: { data: IGalleryProps }) {
    if (!data) return null;

    const { heading, subHeading, description, image } = data;
    
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
                <div className="mask-gradient flex items-center justify-center min-h-[800px] md:min-h-[800px]">
                    <Carousel
                        className="w-[400px] h-[600px] md:w-[480px] md:h-[720px] flex items-center justify-center mx-auto"
                        items={image.map((img, index) => (
                            <CoverflowItem key={img.id} img={img} index={index} />
                        ))}
                        overflow
                        gap={0}
                        itemSize="manual"
                        safeMargin={200}
                    />
                </div>
            </div>
        </section>
    );
}