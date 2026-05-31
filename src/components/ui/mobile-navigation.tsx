"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, ChevronDown, ShoppingBag } from "lucide-react";
import { cn } from "@/lib/utils";
import { useHeaderContext } from "../custom/layouts/header-wrapper";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";
import { LashHerLogo } from "./logo";
import type { TMainMenuItem, TMenuDirectLink, TMenuDropdown } from "@/types";
import { useProductCart } from "@/components/commerce/product-cart-provider";

// Type guards
function isMenuLink(item: TMainMenuItem): item is TMenuDirectLink {
  return item._type === "menuDirectLink";
}

function isMenuDropdown(item: TMainMenuItem): item is TMenuDropdown {
  return item._type === "menuDropdown";
}

interface MobileNavigationProps {
  ctaButton: {
    href: string;
    label: string;
  };
  menuItems?: TMainMenuItem[];
  showCartButton?: boolean;
}

export function MobileNavigation({ ctaButton, menuItems = [], showCartButton = true }: MobileNavigationProps) {
  const pathname = usePathname();
  const { isActive: isHeaderActive } = useHeaderContext();
  const { items, openCart } = useProductCart();
  const [open, setOpen] = useState(false);
  const [expandedItem, setExpandedItem] = useState<string | null>(null);

  const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);

  const toggleExpanded = (key: string) => {
    setExpandedItem(expandedItem === key ? null : key);
  };

  useEffect(() => {
    const desktopQuery = window.matchMedia("(min-width: 1301px)");

    const closeOnDesktop = () => {
      if (!desktopQuery.matches) return;

      setOpen(false);
      setExpandedItem(null);
    };

    closeOnDesktop();
    desktopQuery.addEventListener("change", closeOnDesktop);

    return () => desktopQuery.removeEventListener("change", closeOnDesktop);
  }, []);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          className={cn(
            "p-2 rounded-md transition-colors min-w-11 min-h-11 flex items-center justify-center",
              isHeaderActive
              ? "text-lh-shadow hover:bg-lh-neutral"
              : "text-lh-white hover:bg-white/10"
          )}
          aria-label="Toggle menu"
        >
          <Menu className="h-6 w-6" aria-hidden="true" />
        </button>
      </SheetTrigger>
      <SheetContent side="right" className="w-[300px] sm:w-[400px] flex flex-col h-full">
        <SheetHeader>
          <SheetTitle className="text-lh-primary">
            <Link href="/" onClick={() => setOpen(false)}>
              <LashHerLogo className="mx-auto w-46 h-46" />
            </Link>
          </SheetTitle>
          <SheetDescription className="sr-only">
            Mobile navigation links, cart access, and booking shortcut.
          </SheetDescription>
        </SheetHeader>
        <nav className="flex flex-col gap-2 flex-1 overflow-y-auto py-4" aria-label="Mobile navigation">
          {menuItems.map((item) => {
            // Render simple menu link
            if (isMenuLink(item)) {
              const isActive = pathname === item.url;
              return (
                <Link
                  key={item._key}
                  href={item.url}
                  onClick={() => setOpen(false)}
                  className={cn(
                    "text-xl font-heading tracking-wide transition-colors py-3 px-4 rounded-md",
                    isActive
                      ? "bg-lh-neutral text-lh-primary"
                      : "text-lh-shadow hover:bg-lh-neutral hover:text-lh-primary"
                  )}
                >
                  {item.title}
                </Link>
              );
            }

            // Render dropdown menu
            if (isMenuDropdown(item)) {
              const { sections } = item;
              if (!sections || sections.length === 0) return null;
              
              const isSubLinkActive = sections.some((section) => 
                section.links?.some((link) => pathname === link.url)
              );
              const isExpanded = expandedItem === item._key;

              return (
                <div key={item._key}>
                  {/* Dropdown Header */}
                  <div className="flex items-center">
                    <button
                      onClick={() => toggleExpanded(item._key)}
                      aria-expanded={isExpanded}
                      aria-controls={`mobile-submenu-${item._key}`}
                      className={cn(
                        "text-xl font-heading tracking-wide transition-colors py-3 px-4 rounded-md flex-1 text-left",
                        isSubLinkActive
                          ? "bg-lh-neutral text-lh-primary"
                          : "text-lh-shadow hover:bg-lh-neutral hover:text-lh-primary"
                      )}
                    >
                      {item.title}
                    </button>
                    <button
                      onClick={() => toggleExpanded(item._key)}
                      aria-expanded={isExpanded}
                      aria-controls={`mobile-submenu-${item._key}`}
                      className="p-2 text-lh-shadow hover:text-lh-primary transition-colors"
                      aria-label={`Toggle ${item.title} submenu`}
                    >
                      <ChevronDown
                        className={cn(
                          "h-5 w-5 transition-transform",
                          isExpanded && "rotate-180"
                        )}
                        aria-hidden="true"
                      />
                    </button>
                  </div>

                  {/* Dropdown Content */}
                  {isExpanded && (
                    <div id={`mobile-submenu-${item._key}`} className="ml-4 mt-1 flex flex-col gap-1" role="region" aria-label={`${item.title} submenu`}>
                      {sections.map((section, index) => (
                        <div key={section._key || index} className="mb-2 last:mb-0">
                          {section.heading && (
                            <div className="px-4 py-2 text-[11px] font-heading text-lh-light uppercase tracking-[0.28em]">
                              {section.heading}
                            </div>
                          )}
                          <div className="flex flex-col gap-1">
                            {section.links && section.links.length > 0 && section.links.map((link, linkIndex) => {
                              const isLinkActive = pathname === link.url;
                              return (
                                <Link
                                  key={link._key || linkIndex}
                                  href={link.url}
                                  onClick={() => setOpen(false)}
                                  className={cn(
                                    "text-lg font-heading transition-colors py-2.5 px-4 rounded-md block",
                                    isLinkActive
                                      ? "bg-lh-neutral text-lh-primary"
                                      : "text-lh-shadow hover:bg-lh-neutral hover:text-lh-primary"
                                  )}
                                >
                                  {link.name}
                                </Link>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            }

            return null;
          })}
        </nav>
        <SheetFooter className="mt-0 pt-4 pb-4 border-t border-lh-line">
          {showCartButton ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                openCart();
                setOpen(false);
              }}
              className={cn(
                "relative w-full justify-center gap-2 font-sans font-bold text-base px-4 py-6",
                isHeaderActive ? "text-lh-shadow" : "text-lh-white",
              )}
            >
              <ShoppingBag className="h-4 w-4" aria-hidden="true" />
              <span>Cart</span>
              {itemCount > 0 ? (
                <span className="absolute right-4 inline-flex min-w-5 items-center justify-center rounded-full bg-lh-primary px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
                  {itemCount}
                </span>
              ) : null}
            </Button>
          ) : null}
          <Button asChild variant="primary" className="w-full font-sans font-bold text-base px-4 py-6">
            <Link href={ctaButton.href} onClick={() => setOpen(false)}>
              {ctaButton.label}
            </Link>
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
