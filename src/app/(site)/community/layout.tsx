import type { Metadata } from "next";
import type { ReactNode } from "react";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Community",
  robots: { index: false, follow: false },
};

export default function CommunityLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-4xl px-6 py-12 text-lh-shadow sm:px-8">
      {children}
    </div>
  );
}
