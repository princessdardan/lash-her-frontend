import type { Metadata } from "next";
import { loaders } from "@/data/loaders";
import { Cardo, Cormorant_Garamond, Luxurious_Script, Montserrat, Playfair_Display, Poppins } from "next/font/google";
import "./globals.css";
import { Analytics } from "@vercel/analytics/next";


const luxuriousScript = Luxurious_Script({
  variable: "--font-luxurious-script",
  subsets: ["latin"],
  weight: "400",
  display: 'swap',
});

const cormorantGaramond = Cormorant_Garamond({
  variable: "--font-cormorant-garamond",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  style: "normal",
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

const poppins = Poppins({
  variable: "--font-poppins",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
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

  return {
    title: metadata?.data?.title ?? "Lash Her by Nataliea",
    description: metadata?.data?.description ?? "Elevating beauty through bespoke lash artistry and professional education.",
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode,
}>) {
  return (
    <html lang="en">
      <head>
        <link
          rel="preload"
          href="https://xm0ufgpuvv6lszhy.public.blob.vercel-storage.com/landing-1.avif"
          as="image"
          type="image/avif"
          fetchPriority="high"
        />
      </head>
      <body
        className={`${montserrat.variable} ${cardo.variable} ${cormorantGaramond.variable} ${luxuriousScript.variable} ${poppins.variable} ${playfairDisplay.variable} antialiased`}
      >
        {children}
        <Analytics />
      </body>
    </html>
  );
}