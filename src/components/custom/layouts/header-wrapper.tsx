"use client";

import { useEffect, useState, createContext, useContext } from "react";
import { usePathname } from "next/navigation";

interface HeaderWrapperProps {
  children: React.ReactNode;
}

const HeaderContext = createContext({ isActive: false });

export const useHeaderContext = () => useContext(HeaderContext);

export function HeaderWrapper({ children }: HeaderWrapperProps) {
  const pathname = usePathname();
  const isGalleryPage = pathname === "/gallery";
  
  const [isScrolled, setIsScrolled] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isVisible, setIsVisible] = useState(true);
  const [lastScrollY, setLastScrollY] = useState(0);
  const [scrollTimeout, setScrollTimeout] = useState<NodeJS.Timeout | null>(null);
  const isActive = isScrolled || isHovered;

  useEffect(() => {
    const handleScroll = () => {
      const currentScrollY = window.scrollY;
      
      // Update scrolled state
      setIsScrolled(currentScrollY > 50);
      
      if (isGalleryPage) {
        // Clear existing timeout
        if (scrollTimeout) {
          clearTimeout(scrollTimeout);
        }

        // Gallery page: hide when scrolling down past 100px, show on scroll up
        if (currentScrollY > 100) {
          if (currentScrollY > lastScrollY) {
            // Scrolling down - hide
            setIsVisible(false);
          } else {
            // Scrolling up - show
            setIsVisible(true);
            
            // Set timeout to hide after 2 seconds of no scrolling (only if scrolled down)
            if (currentScrollY > 100) {
              const timeout = setTimeout(() => {
                setIsVisible(false);
              }, 2000);
              setScrollTimeout(timeout);
            }
          }
        } else {
          // At top of page - always show and clear any timeout
          setIsVisible(true);
          if (scrollTimeout) {
            clearTimeout(scrollTimeout);
            setScrollTimeout(null);
          }
        }
      } else {
        // Other pages: show/hide header on mobile based on scroll direction
        if (currentScrollY > lastScrollY && currentScrollY > 100) {
          // Scrolling down - hide on mobile
          setIsVisible(false);
        } else {
          // Scrolling up - show
          setIsVisible(true);
        }
      }
      
      setLastScrollY(currentScrollY);
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", handleScroll);
      if (scrollTimeout) {
        clearTimeout(scrollTimeout);
      }
    };
  }, [lastScrollY, isGalleryPage, scrollTimeout]);

  return (
    <HeaderContext.Provider value={{ isActive }}>
      <div
        className={`z-50 w-full flex flex-col items-center px-4 py-4 shadow-md transition-all duration-300 ${isGalleryPage ? "fixed top-0" : "fixed md:sticky top-0"} ${isActive ? "bg-brand-pink" : "bg-black"} ${!isVisible ? (isGalleryPage ? "-translate-y-full" : "md:translate-y-0 -translate-y-full") : ""}`}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {children}
      </div>
    </HeaderContext.Provider>
  );
}
