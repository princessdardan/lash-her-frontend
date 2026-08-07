import type { Metadata } from "next";
import { draftMode } from "next/headers";
import { VisualEditing } from "next-sanity/visual-editing";
import { loaders } from "@/data/loaders";
import { Header } from "@/components/custom/layouts/header";
import { Footer } from "@/components/custom/layouts/footer";
import { MainWrapper } from "@/components/custom/layouts/main-wrapper";
import { ContactPopup } from "@/components/custom/contact-popup/contact-popup";
import { CartSheet } from "@/components/commerce/cart-sheet";
import { ProductCartProvider } from "@/components/commerce/product-cart-provider";
import { CookieConsentBanner } from "@/components/legal/cookie-consent-banner";
import { ConsentedAnalytics } from "@/components/analytics/consented-analytics";

export async function generateMetadata(): Promise<Metadata> {
  const metadata = await loaders.getMetaData();
  const title = metadata?.title ?? "Lash Her by Nataliea";
  const description =
    metadata?.description ??
    "Elevating beauty through bespoke lash artistry and professional education.";
  const ogImage = metadata?.ogImageUrl
    ? { url: metadata.ogImageUrl, width: 1200, height: 630, alt: title }
    : { url: "/og-default.jpg", width: 1200, height: 630, alt: title };

  return {
    metadataBase: new URL("https://lashher.com"),
    title: { default: title, template: "%s | Lash Her by Nataliea" },
    description,
    openGraph: {
      type: "website",
      locale: "en_US",
      siteName: "Lash Her by Nataliea",
      title,
      description,
      images: [ogImage],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [ogImage.url],
    },
  };
}

export default async function SiteLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { isEnabled } = await draftMode();
  const [globalData, mainMenuData] = await Promise.all([
    loaders.getGlobalData(),
    loaders.getMainMenuData(),
  ]);

  return (
    <>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-4 focus:bg-lh-primary focus:text-white focus:top-0 focus:left-0"
      >
        Skip to main content
      </a>
      <ProductCartProvider>
        <Header data={globalData?.header} menuItems={mainMenuData?.items} />
        <MainWrapper>{children}</MainWrapper>
        <Footer data={globalData?.footer} />
        <ContactPopup settings={globalData?.contactPopup} />
        <CartSheet />
        <CookieConsentBanner />
        <ConsentedAnalytics />
      </ProductCartProvider>
      {isEnabled && <VisualEditing />}
    </>
  );
}
