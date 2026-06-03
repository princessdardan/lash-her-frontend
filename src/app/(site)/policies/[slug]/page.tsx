import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PolicyPageContent } from "@/components/legal/policy-page-content";
import { loaders } from "@/data/loaders";

export const revalidate = 1800;

type PolicyPageProps = {
  params: Promise<{ slug: string }>;
};

export async function generateStaticParams() {
  return loaders.getAllPolicyPageSlugs();
}

export async function generateMetadata({ params }: PolicyPageProps): Promise<Metadata> {
  const { slug } = await params;
  const page = await loaders.getPolicyPageBySlug(slug, { stega: false });

  if (!page) return {};

  const title = page.seo?.title || page.title;
  const description = page.seo?.description || page.summary || "";

  return {
    title,
    description,
    robots: page.seo?.noIndex ? "noindex" : undefined,
    openGraph: { title, description },
    twitter: { title, description },
  };
}

export default async function PolicyPage({ params }: PolicyPageProps) {
  const { slug } = await params;
  const page = await loaders.getPolicyPageBySlug(slug);

  if (!page) notFound();

  return <PolicyPageContent page={page} />;
}
