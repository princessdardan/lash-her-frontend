import type { Metadata } from "next";
import { loaders } from "@/data/loaders";
import { Cardo, Luxurious_Script, Montserrat, Playfair_Display } from "next/font/google";
import "./globals.css";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next"

const luxuriousScript = Luxurious_Script({
  variable: "--font-luxurious-script",
  subsets: ["latin"],
  weight: "400",
  display: 'swap',
});

const playfairDisplay = Playfair_Display({
  variable: "--font-playfair-display",
  subsets: ["latin"],
  weight: ["400", "700"],
  style: "normal",
  display: 'swap',
});

const cardo = Cardo({
  variable: "--font-cardo",
  subsets: ["latin"],
  weight: ["400", "700"],
  style: "normal",
  display: 'swap',
});

const montserrat = Montserrat({
  variable: "--font-montserrat",
  subsets: ["latin"],
  weight: ["100", "200", "300", "400", "500", "600", "700", "800", "900"],
  style: ["normal", "italic"],
  display: 'swap',
});

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
    title: {
      default: title,
      template: "%s | Lash Her by Nataliea",
    },
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

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode,
}>) {
  return (
    <html lang="en">
      <body
        className={`${montserrat.variable} ${cardo.variable} ${luxuriousScript.variable} ${playfairDisplay.variable} antialiased`}
      >
        {children}
        <SpeedInsights />
        <Analytics />
      </body>
    </html>
  );
}