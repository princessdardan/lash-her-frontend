import type { Metadata } from "next";
import { unstable_cache } from "next/cache";
import { loaders } from "@/data/loaders";
import { validateApiResponse } from "@/lib/error-handler";
import { Header } from "@/components/custom/layouts/header";
import { Footer } from "@/components/custom/layouts/footer";

export async function generateMetadata(): Promise<Metadata> {
  const metadata = await loaders.getMetaData();

  return {
    title: metadata?.data?.title ?? "Lash Her by Nataliea",
    description: metadata?.data?.description ?? "Elevating beauty through bespoke lash artistry and professional education.",
  };
}

// Cache global data for 1 hour (header, footer, social links)
const getGlobalDataCached = unstable_cache(
  async () => {
    const globalDataResponse = await loaders.getGlobalData();
    return validateApiResponse(globalDataResponse, "global page");
  },
  ['global-data'],
  { revalidate: 3600, tags: ['global'] }
);

// Cache main menu data for 1 hour (navigation items)
const getMainMenuDataCached = unstable_cache(
  async () => {
    const mainMenuDataResponse = await loaders.getMainMenuData();
    return validateApiResponse(mainMenuDataResponse, "main menu");
  },
  ['main-menu-data'],
  { revalidate: 3600, tags: ['menu'] }
);

export default async function SiteLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const globalData = await getGlobalDataCached();
  const mainMenuData = await getMainMenuDataCached();
  
  return (
    <>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-4 focus:bg-brand-red focus:text-white focus:top-0 focus:left-0"
      >
        Skip to main content
      </a>
      <Header data={globalData?.header} menuItems={mainMenuData?.MainMenuItems} />
      <main id="main-content">
        {children}
      </main>
      <Footer data={globalData?.footer} />
    </>
  );
}
