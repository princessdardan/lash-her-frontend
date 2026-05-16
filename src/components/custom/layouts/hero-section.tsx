import type { THeroSection } from "@/types";
import Link from "next/link";
import { SanityImage } from "../../ui/sanity-image";
import { Button } from "../../ui/button";
import { HeroCarousel } from "./hero-carousel";
import { cn } from "@/lib/utils";
import { getSafeHref, getSafeLinks } from "./hero-links";

export type { THeroSection as IHeroSectionProps } from "@/types";

export function HeroSection({ data }: { data: THeroSection }) {
  if (!data) return null;

  const { heading, subHeading, description, image, link, onHomepage, heroSize, slides } = data;
  const safeLinks = getSafeLinks(link);

  const isHomepageStyle = onHomepage;
  
  let containerClasses = "relative w-full overflow-hidden shadow-sm";
  if (heroSize === "fullScreen") {
    containerClasses = cn(containerClasses, "min-h-screen");
  } else if (heroSize === "eighty") {
    containerClasses = cn(containerClasses, "min-h-[80vh]");
  } else if (heroSize === "compact") {
    containerClasses = cn(containerClasses, "h-[50vh] md:h-[60vh]");
  } else {
    containerClasses = cn(containerClasses, isHomepageStyle ? "min-h-[85vh]" : "h-[50vh] md:h-[60vh]");
  }

  const overlayClasses = isHomepageStyle 
    ? "bg-gradient-to-br from-lh-shadow/80 via-lh-accent/70 to-lh-primary/60"
    : "bg-lh-shadow/60 mix-blend-multiply";

  const contentHeightClasses =
    heroSize === "fullScreen"
      ? "min-h-screen"
      : heroSize === "eighty"
        ? "min-h-[80vh]"
        : heroSize === "compact"
          ? "h-full"
          : isHomepageStyle
            ? "min-h-[85vh]"
            : "h-full";

  const contentClasses = cn(
    "relative px-8 z-10 flex flex-col items-center justify-center text-center",
    isHomepageStyle ? "py-16" : "py-4",
    contentHeightClasses
  );

  const validSlides = slides?.filter((slide) => slide.image?.asset) || [];
  if (validSlides.length > 0) {
    return (
      <HeroCarousel 
        data={data} 
        containerClasses={containerClasses}
        overlayClasses={overlayClasses}
        contentClasses={contentClasses}
        isHomepageStyle={isHomepageStyle}
      />
    );
  }

  if (!image?.asset) return null;

  return (
    <section className={containerClasses}>
      <SanityImage
        image={image}
        alt={image.alt || heading || "Hero banner image"}
        className="absolute inset-0 object-cover w-full h-full"
        height={2160}
        width={3840}
        priority={true}
      />
      <div className={cn("absolute inset-0", overlayClasses)} />
      <div className={contentClasses}>
        <h1 className={cn("display-heading text-lh-neutral-2", isHomepageStyle && "max-w-[880px]")}>
          {heading}
        </h1>
        {subHeading && (
          <p className={cn("font-body text-base font-bold leading-8 text-lh-neutral-2/90 md:text-lg lg:text-xl", isHomepageStyle ? "mt-8 max-w-3xl" : "mt-6 max-w-3xl")}>
            {subHeading}
          </p>
        )}
        {description && (
          <p className={cn("font-body text-base font-bold leading-8 text-lh-neutral-2/80 lg:text-lg", isHomepageStyle ? "mt-6 max-w-2xl" : "mt-6 max-w-2xl")}>
            {description}
          </p>
        )}
        {safeLinks.length > 0 && (
          <div className={cn("flex flex-col md:flex-row gap-4", isHomepageStyle ? "mt-10" : "mt-8")}>
            {safeLinks.map((btn, index) => (
              <Link
                key={btn._key || index}
                href={getSafeHref(btn.href) ?? "/"}
                target={btn.isExternal ? "_blank" : undefined}
                rel={btn.isExternal ? "noopener noreferrer" : undefined}
              >
                <Button 
                  variant={index === 0 ? (isHomepageStyle ? "luxury" : "primary") : "ghost"} 
                  className={index !== 0 ? "text-lh-neutral-2 border-lh-neutral-2/40 hover:bg-lh-neutral-2/10" : ""}
                >
                  {btn.label}
                </Button>
              </Link>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
