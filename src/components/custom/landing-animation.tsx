"use client";

import { motion, AnimatePresence } from "motion/react";
import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import Image from "next/image";
import blobUrls from "@/config/blob-urls.json";

// Use blob URLs from Vercel Blob Storage for optimal performance
const images = blobUrls.landingFrames;
const logoUrl = blobUrls.logo;

export function LandingAnimation() {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [renderedFrames, setRenderedFrames] = useState<Set<number>>(new Set([0]));
  const [firstFrameLoaded, setFirstFrameLoaded] = useState(false);
  const [isHoveringButton, setIsHoveringButton] = useState(false);
  const buttonRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const handleFirstFrameLoad = () => {
    setFirstFrameLoaded(true);
  };

  // Preload frames 1-2 ahead of current index for smooth animation
  useEffect(() => {
    if (!firstFrameLoaded) return;

    const framesToPreload = [currentIndex + 1, currentIndex + 2];

    framesToPreload.forEach(frameIndex => {
      if (frameIndex < images.length && !renderedFrames.has(frameIndex)) {
        setRenderedFrames(prev => new Set([...prev, frameIndex]));
      }
    });
  }, [currentIndex, renderedFrames, firstFrameLoaded]);

  useEffect(() => {
    if (!firstFrameLoaded) return;

    const interval = setInterval(() => {
      setCurrentIndex((prev) => {
        const next = prev + 1;
        if (next >= images.length) {
          clearInterval(interval);
          return prev; // Stay on last frame
        }
        return next;
      });
    }, 240); // Change every 240ms for smoother video-like speed with more frames

    return () => clearInterval(interval);
  }, [firstFrameLoaded]);

  const handleEnter = () => {
    router.push("/homepage");
  };

  return (
    <div className="relative h-screen w-full overflow-hidden bg-black">
      {/* Image Stack with Z-axis Pop Effect */}
      <div className="absolute inset-0">
        <AnimatePresence mode="sync">
          {images.map((image, index) => {
            // Only render frames that should be rendered (progressive loading)
            if (!renderedFrames.has(index)) return null;

            const isVisible = index <= currentIndex;
            const isCurrent = index === currentIndex;

            return (
              <motion.div
                key={index}
                initial={{
                  z: -100
                }}
                animate={isVisible ? {
                  z: isCurrent ? 0 : -50,
                } : {
                  z: -100
                }}
                transition={{
                  duration: 0
                }}
                className="absolute inset-0"
                style={{
                  zIndex: index,
                  opacity: isCurrent ? 1 : 0,
                  backfaceVisibility: 'hidden',
                  transform: 'translateZ(0)'
                }}
              >
                <Image
                  src={image}
                  alt={`Frame ${index + 1}`}
                  fill
                  className="object-cover"
                  priority={index === 0}
                  onLoad={index === 0 ? handleFirstFrameLoad : undefined}
                  unoptimized
                  {...(index === 0 && { fetchPriority: 'high' as const })}
                />
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      {/* Overlay Content */}
      <div className="relative flex h-full bg-grey flex-col items-center justify-center gap-4 mt-24 px-4 z-50">
        {/* Logo or Title */}
        <motion.div
          initial={{ opacity: 0, y: -30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1, delay: 4.0 }}
          className="text-center p-2 rounded-xl backdrop-blur-xs">
          <motion.h1
            initial={{ opacity: 0, y: -30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 1, delay: 4.0 }}
            className="text-6xl font-bold text-brand-dark-red font-stretch-90% text-lift-dynamic font-serif drop-shadow-2xl md:text-7xl"
          >
            Lash Her
          </motion.h1>
          <motion.h2
            initial={{ opacity: 0, y: -30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 1, delay: 4.2 }}
            className="-mt-2 text-3xl font-stretch-150% text-black text-lift-subtle-dynamic font-script font-light text-lift-dynamic drop-shadow-2xl md:text-4xl"
          >
            By Nataliea
          </motion.h2>
          <motion.p
            initial={{ opacity: 0, y: -30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 1, delay: 4.4 }}
            className="mt-4 text-xl font-stretch-75% text-brand-more-pink font-light text-lift-dynamic drop-shadow-2xl md:text-2xl"
          >
            Elevate Your Beauty
          </motion.p>
        </motion.div>

        {/* Enter Button */}
        <motion.div
          ref={buttonRef}
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1, delay: 4.6 }}
          className="relative"
          onMouseEnter={() => setIsHoveringButton(true)}
          onMouseLeave={() => setIsHoveringButton(false)}
        >
          <Button
            onClick={handleEnter}
            size="lg"
            className="group relative h-30 w-30 overflow-hidden rounded-full border-4 border-brand-dark-red/50 bg-transparent text-lg font-semibold text-brand-dark-red/70 shadow-2xl transition-all hover:scale-105"
          >
            <span className="relative z-10">
              Enter
            </span>
          </Button>
          
          {/* Floating Target Image */}
          {isHoveringButton && (
            <motion.div
              className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden rounded-full"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              transition={{ duration: 0.3 }}
              style={{ zIndex: 10000 }}
            >
              <Image
                src={logoUrl}
                alt="Lash Her Logo"
                width={240}
                height={240}
                className="object-fill md:object-cover scale-150"
                unoptimized
              />
            </motion.div>
          )}
        </motion.div>
      </div>
    </div>
  );
}
