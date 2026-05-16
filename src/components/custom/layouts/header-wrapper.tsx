"use client";

import { useEffect, useState, createContext, useContext } from "react";
import { usePathname } from "next/navigation";

interface HeaderWrapperProps {
  children: React.ReactNode;
}

const HeaderContext = createContext({ isActive: false });

export const useHeaderContext = () => useContext(HeaderContext);

export function HeaderWrapper({ children }: HeaderWrapperProps) {
  const [isScrolled, setIsScrolled] = useState(false);
  const pathname = usePathname();
  const isHome = pathname === "/";
  const isActive = isScrolled || !isHome;

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 50);
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

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
