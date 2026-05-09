"use client";

import { useEffect, useState, createContext, useContext } from "react";

interface HeaderWrapperProps {
  children: React.ReactNode;
}

const HeaderContext = createContext({ isActive: false });

export const useHeaderContext = () => useContext(HeaderContext);

export function HeaderWrapper({ children }: HeaderWrapperProps) {
  const [isScrolled, setIsScrolled] = useState(false);
  const isActive = isScrolled;

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
        className={`fixed top-0 z-50 w-full flex flex-col items-center px-4 py-4 transition-all duration-300 ${isActive ? "bg-lh-primary/30 backdrop-blur-sm border-b border-lh-line shadow-sm" : "bg-transparent"}`}
      >
        {children}
      </header>
    </HeaderContext.Provider>
  );
}
