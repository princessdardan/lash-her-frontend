"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useHeaderContext } from "../custom/layouts/header-wrapper";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { LashHerLogo } from "./logo";
import type { IMainMenuItems, MenuLinkProps, DropdownMenuProps } from "@/app/main-menu";

// Type guards
function isMenuLink(item: IMainMenuItems): item is MenuLinkProps {
  return item.__component === "menu.menu-link";
}

function isMenuDropdown(item: IMainMenuItems): item is DropdownMenuProps {
  return item.__component === "menu.dropdown";
}

interface MobileNavigationProps {
  ctaButton: {
    href: string;
    label: string;
  };
  menuItems?: IMainMenuItems[];
}

export function MobileNavigation({ ctaButton, menuItems = [] }: MobileNavigationProps) {
  const pathname = usePathname();
  const { isActive: isHeaderActive } = useHeaderContext();
  const [open, setOpen] = useState(false);
  const [expandedItem, setExpandedItem] = useState<number | null>(null);

  const toggleExpanded = (id: number) => {
    setExpandedItem(expandedItem === id ? null : id);
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          className={cn(
            "p-2 rounded-md transition-colors min-w-11 min-h-11 flex items-center justify-center",
            isHeaderActive
              ? "text-brand-red hover:bg-brand-red/10"
              : "text-brand-pink hover:bg-brand-pink/10"
          )}
          aria-label="Toggle menu"
        >
          <Menu className="h-6 w-6" aria-hidden="true" />
        </button>
      </SheetTrigger>
      <SheetContent side="left" className="w-[300px] sm:w-[400px] flex flex-col h-full">
        <SheetHeader>
          <SheetTitle className="text-brand-red">
            <Link href="/" onClick={() => setOpen(false)}><LashHerLogo className="mx-auto w-46 h-46"/></Link>
          </SheetTitle>
        </SheetHeader>
        <nav className="flex flex-col gap-2 flex-1 overflow-y-auto py-4" aria-label="Mobile navigation">
          {menuItems.map((item) => {
            // Render simple menu link
            if (isMenuLink(item)) {
              const isActive = pathname === item.url;
              return (
                <Link
                  key={item.id}
                  href={item.url}
                  onClick={() => setOpen(false)}
                  className={cn(
                    "text-lg font-light transition-colors py-2 px-4 rounded-md",
                    isActive
                      ? "font-semibold bg-brand-red/10 text-brand-red"
                      : "text-brand-black hover:bg-brand-pink hover:text-brand-red"
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
              const isExpanded = expandedItem === item.id;

              return (
                <div key={item.id}>
                  {/* Dropdown Header */}
                  <div className="flex items-center">
                    <button
                      onClick={() => toggleExpanded(item.id)}
                      aria-expanded={isExpanded}
                      aria-controls={`mobile-submenu-${item.id}`}
                      className={cn(
                        "text-lg font-light transition-colors py-2 px-4 rounded-md flex-1 text-left",
                        isSubLinkActive
                          ? "font-semibold bg-brand-red/10 text-brand-red"
                          : "text-brand-black hover:bg-brand-pink hover:text-brand-red"
                      )}
                    >
                      {item.title}
                    </button>
                    <button
                      onClick={() => toggleExpanded(item.id)}
                      aria-expanded={isExpanded}
                      aria-controls={`mobile-submenu-${item.id}`}
                      className="p-2 text-brand-black hover:text-brand-red transition-colors"
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
                    <div id={`mobile-submenu-${item.id}`} className="ml-4 mt-1 flex flex-col gap-1" role="region" aria-label={`${item.title} submenu`}>
                      {sections.map((section) => (
                        <div key={section.id} className="mb-2 last:mb-0">
                          {section.heading && (
                            <div className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                              {section.heading}
                            </div>
                          )}
                          <div className="flex flex-col gap-1">
                            {section.links && section.links.length > 0 && section.links.map((link) => {
                              const isLinkActive = pathname === link.url;
                              return (
                                <Link
                                  key={link.id}
                                  href={link.url}
                                  onClick={() => setOpen(false)}
                                  className={cn(
                                    "text-base font-light transition-colors py-2 px-4 rounded-md block",
                                    isLinkActive
                                      ? "font-semibold bg-brand-red/10 text-brand-red"
                                      : "text-gray-700 hover:bg-brand-pink/5 hover:text-brand-red"
                                  )}
                                >
                                  {link.title}
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
        <SheetFooter className="mt-0 pt-4 pb-4 border-t border-gray-200">
          <Link href={ctaButton.href} className="w-full" onClick={() => setOpen(false)}>
            <Button className="w-full font-sans font-light text-lg italic px-4 py-6 bg-brand-red text-white hover:bg-brand-red/90">
              {ctaButton.label}
            </Button>
          </Link>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
