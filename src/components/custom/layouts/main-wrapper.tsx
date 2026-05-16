"use client";

import { usePathname } from "next/navigation";

interface MainWrapperProps {
  children: React.ReactNode;
}

export function MainWrapper({ children }: MainWrapperProps) {
  const pathname = usePathname();
  const isHome = pathname === "/";

  return (
    <main id="main-content" className={!isHome ? "pt-28" : ""}>
      {children}
    </main>
  );
}
