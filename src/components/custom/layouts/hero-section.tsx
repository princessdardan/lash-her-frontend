import { TImage, TLink } from "@/types";
import Link from "next/link";
import { StrapiImage } from "../../ui/strapi-image";
import { Button } from "../../ui/button";


export interface IHeroSectionProps {
  id: number;
  documentId: string;
  __component: string;
  heading: string;
  subHeading: string;
  description: string;
  image: TImage;
  link: TLink[];
  onHomepage: boolean;
}

export function HeroSection({ data }: { data: IHeroSectionProps }) {
    if (!data) return null;

    const { heading, subHeading, description, image, link, onHomepage } = data;

  console.dir(data, { depth: null });

  // Page variant for internal pages
  if (!onHomepage) {
    return (
      <section className="relative h-[50vh] md:h-[60vh] overflow-hidden">
        <StrapiImage
          alt={image.alternativeText || heading || "Hero banner image"}
          className="absolute inset-0 object-cover w-full h-full"
          src={image.url}
          height={2160}
          width={3840}
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
              {link.map((btn) => (
                  <Link key={btn.id} href={btn.href}>
                      <Button className= "inline-flex border-[1.5px] border-brand-red italic items-center text-lift-subtle text-brand-red font-serif text-xl justify-center px-10 py-8 font-bold bg-brand-pink hover:bg-brand-pink/90" variant="secondary" >
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
    <section className="relative h-screen overflow-hidden">
      <StrapiImage
        alt={image.alternativeText || heading || "Hero banner image"}
        className="absolute inset-0 object-cover w-full h-full aspect/16:9"
        src={image.url}
        height={2160}
        width={3840}
      />
      <div className="relative px-8 py-4 z-10 flex flex-col items-center justify-center h-full bg-black/50 text-center">
        <h1 className="hero-heading-home">{heading}</h1>
        {subHeading && <p className="hero-subheading">{subHeading}</p>}
        {description && <p className="hero-description">{description}</p>}
        <div className="flex flex-col md:flex-row gap-4 mt-8">
            {link.map((btn) => (
                <Link key={btn.id} href={btn.href}>
                    <Button className= "inline-flex border-[1.5px] border-brand-red italic items-center text-lift-subtle text-brand-red font-serif text-xl justify-center px-10 py-8 font-bold bg-brand-pink hover:bg-brand-pink/90" variant="secondary" >
                        {btn.label}
                    </Button>
                </Link>
            ))}
        </div>
      </div>
    </section>
  )
}