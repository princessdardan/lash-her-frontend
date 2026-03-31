import { notFound } from "next/navigation";
import { loaders } from "@/data/loaders";
import { BlockRenderer } from "@/components/custom/layouts/block-renderer";
import { buildPageMetadata } from "@/lib/metadata";

// Revalidate every 30 minutes (1800 seconds)
export const revalidate = 1800;

export const metadata = buildPageMetadata({
  title: "Training Programs",
  description:
    "Professional lash training programs for beginners and advanced artists. Learn from expert lash artist Nataliea.",
});

export default async function TrainingPage() {
  const data = await loaders.getTrainingsPageData();
  if (!data) notFound();

  const { blocks } = data;

  // Check if there's a hero section with h1
  const hasHeroSection = blocks?.some(block => block._type === "heroSection");

  return (
    <>
      {!hasHeroSection && (
        <div className="container mx-auto px-4 py-8">
          <h1 className="text-4xl font-bold text-center">Training Programs</h1>
        </div>
      )}
      <BlockRenderer blocks={blocks} />
    </>
  );
}
