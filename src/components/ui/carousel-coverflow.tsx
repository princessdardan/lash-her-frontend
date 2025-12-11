"use client"

import { Carousel, useTickerItem } from "motion-plus/react"
import { motion, useTransform } from "motion/react"

function CoverflowItem({ src, index }: { src: string; index: number }) {
    const { offset, props } = useTickerItem()

    const rotateY = useTransform(offset, [-200, 0, 200], [20, 0, -20])
    const scale = useTransform(offset, [-200, 0, 200], [0.7, 1, 0.7])
    const x = useTransform(
        offset,
        [-800, -200, 200, 800],
        ["100%", "0%", "0%", "-100%"]
    )
    const zIndex = useTransform(offset, (value) =>
        Math.max(0, Math.round(1000 - Math.abs(value)))
    )

    return (
        <motion.li {...props} style={{ ...props.style, zIndex }}>
            <motion.img
                draggable={false}
                src={`/photos/prague/${src}.jpg`}
                alt={`Photo ${index + 1}`}
                className="coverflow-item"
                style={{ transformPerspective: 500, x, rotateY, scale }}
            />
        </motion.li>
    )
}

export default function CarouselCoverflowExample() {
    const images = [
        "image-01",
        "image-02",
        "image-03",
        "image-04",
        "image-05",
        "image-06",
        "image-07",
        "image-08",
        "image-09",
    ]

    return (
        <div className="mask">
            <Carousel
                className="coverflow-carousel"
                items={images.map((src, index) => (
                    <CoverflowItem key={src} src={src} index={index} />
                ))}
                overflow
                gap={0}
                itemSize="manual"
                safeMargin={200}
            />
            <Stylesheet />
        </div>
    )
}

/**
 * ==============   Styles   ================
 */
function Stylesheet() {
    return (
        <style>
            {`
        body {
            overflow-x: hidden;
        }

        #sandbox {
            align-items: stretch;
            justify-content: stretch;
        }
              
        .coverflow-carousel {
          width: 350px;
          height: 350px;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .coverflow-item {
          width: 350px;
          height: 350px;
          object-fit: cover;
          border-radius: 12px;
          box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
          will-change: transform, opacity;
        }

        @media (max-width: 600px) {
          .coverflow-carousel {
            width: 250px;
            height: 250px;
          }
          .coverflow-item {
            width: 250px;
            height: 250px;
          }
        }

        .mask {
          mask-image: linear-gradient(to right, transparent 10%, black 25%, black 75%, transparent 90%);
          webkit-mask-image: linear-gradient(to right, transparent 10%, black 25%, black 75%, transparent 90%);
          display: flex;
          align-items: center;
          justify-content: center;
          flex: 1;
        }
      `}
        </style>
    )
}
