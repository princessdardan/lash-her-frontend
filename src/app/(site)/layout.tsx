import { loaders } from "@/data/loaders";
import { Header } from "@/components/custom/layouts/header";
import { Footer } from "@/components/custom/layouts/footer";
import { MainWrapper } from "@/components/custom/layouts/main-wrapper";
import { ContactPopup } from "@/components/custom/contact-popup/contact-popup";
import { CartSheet } from "@/components/commerce/cart-sheet";
import { ProductCartProvider } from "@/components/commerce/product-cart-provider";
import { CookieConsentBanner } from "@/components/legal/cookie-consent-banner";
import { ConsentedAnalytics } from "@/components/analytics/consented-analytics";

export default async function SiteLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
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
        <MainWrapper>
          {children}
        </MainWrapper>
        <Footer data={globalData?.footer} />
        <ContactPopup settings={globalData?.contactPopup} />
        <CartSheet />
        <CookieConsentBanner />
        <ConsentedAnalytics />
      </ProductCartProvider>
    </>
  );
}
