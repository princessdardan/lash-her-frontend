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
      <Header data={globalData?.header} menuItems={mainMenuData?.MainMenuItems} />
      {children}
      <Footer data={globalData?.footer} />
    </>
  );
}
