import { notFound } from "next/navigation";
import { loaders } from "@/data/loaders";
import { BlockRenderer } from "@/components/custom/layouts/block-renderer";
import { ContactContent } from "@/components/custom/contact-content";
import { buildPageMetadata } from "@/lib/metadata";

// Revalidate every 30 minutes (1800 seconds)
export const revalidate = 1800;

export const metadata = buildPageMetadata({
  title: "Lash Her by Nataliea | Lash Artistry & Training",
  description:
    "Elevating beauty through bespoke lash artistry and professional lash training programs. Book your appointment or enroll in training today.",
  absolute: true,
});

export default async function Home() {
  // Fetch all data in parallel to avoid sequential waterfall
  const [homeData, trainingData, contactData] = await Promise.all([
    loaders.getHomePageData(),
    loaders.getTrainingsPageData(),
    loaders.getContactPageData(),
  ]);

  if (!homeData) notFound();

  return (
    <>
      <BlockRenderer blocks={homeData.blocks} />
      {trainingData && <BlockRenderer blocks={trainingData.blocks} />}
      {contactData && (
        <ContactContent
          blocks={contactData.blocks}
          pageData={{
            title: contactData.title,
            subTitle: contactData.subTitle,
            description: contactData.description,
          }}
        />
      )}
    </>
  );
}
