import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  robots: {
    follow: false,
    index: false,
  },
  title: "Admin",
};

export default function AdminRootLayout({ children }: { children: ReactNode }) {
  return children;
}
