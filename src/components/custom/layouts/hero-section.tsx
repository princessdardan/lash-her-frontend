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
      <section className="relative h-[50vh] md:h-[60vh] w-full overflow-hidden shadow-sm">
        <SanityImage
          image={image}
          alt={image.alt || heading || "Hero banner image"}
          className="absolute inset-0 object-cover w-full h-full"
          height={2160}
          width={3840}
          priority={true}
        />
        <div className="absolute inset-0 bg-lh-shadow/60 mix-blend-multiply" />
        <div className="relative px-8 py-4 z-10 flex flex-col items-center justify-center h-full text-center">
          <h1 className="display-heading text-lh-neutral-2">
            {heading}
          </h1>
          {subHeading && (
            <p className="mt-6 max-w-3xl font-body text-base font-bold leading-8 text-lh-neutral-2/90 md:text-lg lg:text-xl">
              {subHeading}
            </p>
          )}
          {description && (
            <p className="mt-6 max-w-2xl font-body text-base font-bold leading-8 text-lh-neutral-2/80 lg:text-lg">{description}</p>
          )}
          {link && link.length > 0 && (
            <div className="flex flex-col md:flex-row gap-4 mt-8">
              {link.map((btn, index) => (
                  <Link key={btn._key || index} href={btn.href}>
                      <Button variant={index === 0 ? "primary" : "ghost"} className={index !== 0 ? "text-lh-neutral-2 border-lh-neutral-2/40 hover:bg-lh-neutral-2/10" : ""}>
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
    <section className="relative min-h-[85vh] w-full overflow-hidden shadow-sm">
      <SanityImage
        image={image}
        alt={image.alt || heading || "Hero banner image"}
        className="absolute inset-0 object-cover w-full h-full"
        height={2160}
        width={3840}
        priority={true}
      />
      <div className="absolute inset-0 bg-gradient-to-br from-lh-shadow/80 via-lh-accent/70 to-lh-primary/60" />
      <div className="relative px-8 py-16 z-10 flex flex-col items-center justify-center h-full min-h-[85vh] text-center">
        <h1 className="display-heading text-lh-neutral-2 max-w-[880px]">{heading}</h1>
        {subHeading && <p className="mt-8 max-w-3xl font-body text-base font-bold leading-8 text-lh-neutral-2/90 md:text-lg lg:text-xl">{subHeading}</p>}
        {description && <p className="mt-6 max-w-2xl font-body text-base font-bold leading-8 text-lh-neutral-2/80 lg:text-lg">{description}</p>}
        <div className="flex flex-col md:flex-row gap-4 mt-10">
            {link.map((btn, index) => (
                <Link key={btn._key || index} href={btn.href}>
                    <Button variant={index === 0 ? "luxury" : "ghost"} className={index !== 0 ? "text-lh-neutral-2 border-lh-neutral-2/40 hover:bg-lh-neutral-2/10" : ""}>
                        {btn.label}
                    </Button>
                </Link>
            ))}
        </div>
      </div>
    </section>
  )
}
