"use client";

import { useIsHomepage } from "@/components/custom/layouts/use-is-homepage";

interface MainWrapperProps {
  children: React.ReactNode;
}

export function MainWrapper({ children }: MainWrapperProps) {
  const isHome = useIsHomepage();

  return (
    <main id="main-content" className={!isHome ? "pt-28" : ""}>
      {children}
    </main>
  );
}
