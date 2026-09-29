"use client";

import { useSyncExternalStore, createContext, useContext } from "react";
import { useIsHomepage } from "@/components/custom/layouts/use-is-homepage";

interface HeaderWrapperProps {
  children: React.ReactNode;
}

const HeaderContext = createContext({ isActive: false });

export const useHeaderContext = () => useContext(HeaderContext);

function subscribeToScroll(onChange: () => void) {
  window.addEventListener("scroll", onChange, { passive: true });
  return () => window.removeEventListener("scroll", onChange);
}

const getScrollSnapshot = () => window.scrollY > 50;
const getServerScrollSnapshot = () => false;

export function HeaderWrapper({ children }: HeaderWrapperProps) {
  const isScrolled = useSyncExternalStore(
    subscribeToScroll,
    getScrollSnapshot,
    getServerScrollSnapshot,
  );
  const isHome = useIsHomepage();
  const isActive = isScrolled || !isHome;

  return (
    <HeaderContext.Provider value={{ isActive }}>
      <header
        className={`fixed top-0 z-50 w-full flex flex-col items-center px-4 py-4 transition-all duration-300 ${isActive ? "bg-lh-white border-b border-lh-light/50 shadow-[0_8px_30px_-4px_rgba(28,19,24,0.06)]" : "bg-transparent"}`}
      >
        {children}
      </header>
    </HeaderContext.Provider>
  );
}
