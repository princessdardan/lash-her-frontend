import type { Metadata } from "next";
import { draftMode } from "next/headers";
import type { ReactNode } from "react";
import { loaders } from "@/data/loaders";
import { Bebas_Neue, Inter } from "next/font/google";
import { VisualEditing } from "next-sanity/visual-editing";
import "./globals.css";
import { SpeedInsights } from "@vercel/speed-insights/next";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const bebasNeue = Bebas_Neue({
  variable: "--font-bebas-neue",
  subsets: ["latin"],
  weight: ["400"],
  display: "swap",
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
  children: ReactNode;
}>) {
  const { isEnabled } = await draftMode();

  return (
    <html lang="en">
      <body
        className={`${bebasNeue.variable} ${inter.variable} antialiased`}
      >
        {children}
        {isEnabled && <VisualEditing />}
        <SpeedInsights />
      </body>
    </html>
  );
}
