import type { Metadata } from "next";
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

export default async function SiteLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const globalDataResponse = await loaders.getGlobalData();
  const globalData = validateApiResponse(globalDataResponse, "global page");
  
  const mainMenuDataResponse = await loaders.getMainMenuData();
  const mainMenuData = validateApiResponse(mainMenuDataResponse, "main menu");
  
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
