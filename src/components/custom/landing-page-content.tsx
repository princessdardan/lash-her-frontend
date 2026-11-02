import { PortableTextRenderer } from "@/components/ui/portable-text-renderer";
import { SanityImage } from "@/components/ui/sanity-image";
import type { TLandingPage } from "@/types";
import { LandingPageSignup } from "@/components/custom/landing-page-signup";

export function LandingPageContent({ page }: { page: TLandingPage }) {
  return (
    <article className="bg-lh-neutral-2 py-12 text-lh-shadow md:py-20">
      <div className="content-container">
        <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] lg:gap-16">
          <div>
            {page.eyebrow ? (
              <p className="eyebrow-label mb-5">{page.eyebrow}</p>
            ) : null}
            <h1 className="font-heading text-6xl leading-[0.95] text-lh-primary md:text-8xl">
              {page.heading}
            </h1>
            <p className="mt-6 max-w-2xl whitespace-pre-line text-lg leading-8 text-lh-shadow/80">
              {page.description}
            </p>
          </div>
          <LandingPageSignup
            key={page._id}
            slug={page.slug}
            settings={page.signup}
          />
        </div>
        {page.heroImage?.asset ? (
          <div className="relative mt-12 aspect-[4/3] overflow-hidden rounded-[28px] md:aspect-[2/1]">
            <SanityImage
              image={page.heroImage}
              fill
              priority
              sizes="(max-width: 1180px) 100vw, 1180px"
              className="object-cover"
            />
          </div>
        ) : null}
        {page.body?.length ? (
          <div className="prose prose-lg mt-12 max-w-3xl prose-headings:font-heading prose-headings:font-normal prose-headings:text-lh-primary prose-p:leading-8 prose-p:text-lh-shadow/80">
            <PortableTextRenderer content={page.body} />
          </div>
        ) : null}
      </div>
    </article>
  );
}
