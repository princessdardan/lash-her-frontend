import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loaders } from "@/data/loaders";
import { LandingPageContent } from "@/components/custom/landing-page-content";
import { validateLandingPageSlug } from "@/lib/landing-pages/contract";

export const revalidate = 1800;
type LandingPageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({
  params,
}: LandingPageProps): Promise<Metadata> {
  const { slug } = await params;
  if (validateLandingPageSlug(slug) !== true) notFound();
  const page = await loaders.getLandingPageBySlug(slug, { stega: false });
  if (!page) notFound();
  const title = page.seo?.title || page.title;
  const description = page.seo?.description || page.description;
  return {
    title,
    description,
    alternates: { canonical: `/${slug}` },
    robots: page.seo?.noIndex ? { index: false, follow: true } : undefined,
    openGraph: { title, description, url: `/${slug}` },
    twitter: { title, description },
  };
}

export default async function LandingPage({ params }: LandingPageProps) {
  const { slug } = await params;
  if (validateLandingPageSlug(slug) !== true) notFound();
  const page = await loaders.getLandingPageBySlug(slug);
  if (!page) notFound();
  return <LandingPageContent page={page} />;
}
