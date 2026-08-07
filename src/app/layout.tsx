import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Bebas_Neue, Inter } from "next/font/google";
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

const fallbackTitle = "Lash Her by Nataliea";
const fallbackDescription =
  "Elevating beauty through bespoke lash artistry and professional education.";

export const metadata: Metadata = {
  metadataBase: new URL("https://lashher.com"),
  title: { default: fallbackTitle, template: "%s | Lash Her by Nataliea" },
  description: fallbackDescription,
  openGraph: {
    type: "website",
    locale: "en_US",
    siteName: "Lash Her by Nataliea",
    title: fallbackTitle,
    description: fallbackDescription,
    images: [
      { url: "/og-default.jpg", width: 1200, height: 630, alt: fallbackTitle },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: fallbackTitle,
    description: fallbackDescription,
    images: ["/og-default.jpg"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${bebasNeue.variable} ${inter.variable} antialiased`}>
        {children}
        <SpeedInsights />
      </body>
    </html>
  );
}
