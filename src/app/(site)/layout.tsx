import { loaders } from "@/data/loaders";
import { Header } from "@/components/custom/layouts/header";
import { Footer } from "@/components/custom/layouts/footer";

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "BeautySalon",
  "name": "Lash Her by Nataliea",
  "description": "Elevating beauty through bespoke lash artistry and professional education.",
  "url": "https://lashher.com",
  "image": "https://lashherbynataliea.com/logo.png", // TODO: replace with actual logo URL
  "telephone": "+1-000-000-0000", // TODO: replace with actual phone
  "email": "info@lashherbynataliea.com", // TODO: replace with actual email
  "address": {
    "@type": "PostalAddress",
    "addressLocality": "", // TODO: fill in city
    "addressRegion": "", // TODO: fill in state
    "addressCountry": "US",
  },
  "openingHoursSpecification": [], // TODO: populate from CMS schedule data
  "makesOffer": [
    {
      "@type": "Offer",
      "itemOffered": {
        "@type": "Service",
        "name": "Lash Extensions",
        "description": "Professional lash extension services",
      },
    },
    {
      "@type": "Offer",
      "itemOffered": {
        "@type": "Service",
        "name": "Lash Training",
        "description": "Professional lash artistry training and education",
      },
    },
  ],
  "priceRange": "$$", // TODO: adjust as needed
};

export default async function SiteLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const globalData = await loaders.getGlobalData();
  const mainMenuData = await loaders.getMainMenuData();

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-4 focus:bg-brand-red focus:text-white focus:top-0 focus:left-0"
      >
        Skip to main content
      </a>
      <Header data={globalData?.header} menuItems={mainMenuData?.items} />
      <main id="main-content">
        {children}
      </main>
      <Footer data={globalData?.footer} />
    </>
  );
}
