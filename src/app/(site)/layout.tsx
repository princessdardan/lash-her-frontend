import { loaders } from "@/data/loaders";
import { Header } from "@/components/custom/layouts/header";
import { Footer } from "@/components/custom/layouts/footer";
import { MainWrapper } from "@/components/custom/layouts/main-wrapper";
import { ContactPopup } from "@/components/custom/contact-popup/contact-popup";
import { ProductCartProvider } from "@/components/commerce/product-cart-provider";
import { CartSheet } from "@/components/commerce/cart-sheet";

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "BeautySalon",
  "name": "Lash Her by Nataliea",
  "description": "Elevating beauty through bespoke lash artistry and professional education.",
  "url": "https://lashher.com",
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
  "priceRange": "$$",
};

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
      <script
        id="lash-her-local-business-json-ld"
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
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
      </ProductCartProvider>
    </>
  );
}
