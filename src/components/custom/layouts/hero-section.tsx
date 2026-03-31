import type { THeroSection } from "@/types";
import Link from "next/link";
import { SanityImage } from "../../ui/sanity-image";
import { Button } from "../../ui/button";

export type { THeroSection as IHeroSectionProps } from "@/types";

export function HeroSection({ data }: { data: THeroSection }) {
    if (!data) return null;

    const { heading, subHeading, description, image, link, onHomepage } = data;

  // Page variant for internal pages
  if (!onHomepage) {
    return (
      <section className="relative h-[50vh] md:h-[60vh] overflow-hidden">
        <SanityImage
          image={image}
          alt={image.alt || heading || "Hero banner image"}
          className="absolute inset-0 object-cover w-full h-full"
          height={2160}
          width={3840}
          priority={true}
        />
        <div className="relative px-8 py-4 z-10 flex flex-col items-center justify-center h-full bg-black/60 text-center">
          <h1 className="hero-heading">
            {heading}
          </h1>
          {subHeading && (
            <p className="hero-subheading">
              {subHeading}
            </p>
          )}
          {description && (
            <p className="hero-description">{description}</p>
          )}
          {link && link.length > 0 && (
            <div className="flex flex-col md:flex-row gap-4 mt-8">
              {link.map((btn, index) => (
                  <Link key={btn._key || index} href={btn.href}>
                      <Button className="btn-hero" variant="secondary">
                          {btn.label}
                      </Button>
                  </Link>
              ))}
            </div>)}
        </div>
      </section>
    );
  }

  // Homepage variant (default)
  return (
    <section className="relative h-dvh overflow-hidden">
      <SanityImage
        image={image}
        alt={image.alt || heading || "Hero banner image"}
        className="absolute inset-0 object-cover w-full h-full aspect-video"
        height={2160}
        width={3840}
        priority={true}
      />
      <div className="relative px-8 py-4 z-10 flex flex-col items-center justify-center h-full bg-black/50 text-center">
        <h1 className="hero-heading-home">{heading}</h1>
        {subHeading && <p className="hero-subheading">{subHeading}</p>}
        {description && <p className="hero-description">{description}</p>}
        <div className="flex flex-col md:flex-row gap-4 mt-8">
            {link.map((btn, index) => (
                <Link key={btn._key || index} href={btn.href}>
                    <Button className="btn-hero" variant="secondary">
                        {btn.label}
                    </Button>
                </Link>
            ))}
        </div>
      </div>
    </section>
  )
}
