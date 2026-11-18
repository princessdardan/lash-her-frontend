import { Button } from "@/components/ui/button";
import { PortableTextRenderer } from "@/components/ui/portable-text-renderer";
import { SanityImage } from "@/components/ui/sanity-image";
import type { TLandingPage } from "@/types";
import { LandingPageSignup } from "@/components/custom/landing-page-signup";

export function LandingPageContent({ page }: { page: TLandingPage }) {
  return (
    <article className="bg-lh-neutral-2 py-10 text-lh-shadow md:py-16">
      <div className="content-container">
        <div className="mx-auto grid max-w-2xl items-start gap-6 lg:max-w-none lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:gap-12">
          <div className="min-w-0 space-y-8 wrap-anywhere">
            <header>
              {page.eyebrow ? (
                <p className="eyebrow-label mb-4">{page.eyebrow}</p>
              ) : null}
              <h1 className="font-heading text-5xl leading-[0.95] text-lh-primary sm:text-6xl xl:text-8xl">
                {page.heading}
              </h1>
              <p className="mt-5 whitespace-pre-line text-lg leading-8 text-lh-shadow/80">
                {page.description}
              </p>
            </header>
            {page.heroImage?.asset ? (
              <div className="relative aspect-[4/3] overflow-hidden rounded-[28px] sm:aspect-[3/2]">
                <SanityImage
                  image={page.heroImage}
                  fill
                  sizes="(min-width: 1180px) 641px, (min-width: 1024px) calc(60vw - 67px), (min-width: 720px) 672px, calc(100vw - 48px)"
                  className="size-full object-cover"
                />
              </div>
            ) : null}
            {page.body?.length ? (
              <div className="prose prose-lg max-w-none prose-headings:font-heading prose-headings:font-normal prose-headings:text-lh-primary prose-p:leading-8 prose-p:text-lh-shadow/80">
                <PortableTextRenderer content={page.body} />
              </div>
            ) : null}
          </div>
          <div className="sticky bottom-[max(1rem,env(safe-area-inset-bottom))] z-40 mx-auto w-full max-w-xs rounded-[28px] border border-lh-line bg-lh-white p-1.5 shadow-lg lg:hidden">
            <Button
              asChild
              className="h-auto min-h-11 w-full whitespace-normal wrap-anywhere px-5 py-2 text-center"
            >
              <a href="#email-signup">
                {page.signup?.mobileDockLabel?.trim() || "Sign Up!"}
              </a>
            </Button>
          </div>
          <LandingPageSignup
            key={page._id}
            slug={page.slug}
            settings={page.signup}
          />
        </div>
      </div>
    </article>
  );
}
