"use client";

import Link from "next/link";
import type { THeader } from "@/types";
import type { IMainMenuItems } from "@/app/main-menu";

import { Logo } from "@/components/ui/logo";
import { MainMenu } from "@/app/main-menu";
import { MobileNavigation } from "@/components/ui/mobile-navigation";
import { Button } from "@/components/ui/button";
import { HeaderWrapper, useHeaderContext } from "@/components/custom/layouts/header-wrapper";
import { NavigationMenu, NavigationMenuList } from "@/components/ui/navigation-menu";
import { cn } from "@/lib/utils";

interface IHeaderProps {
  data?: THeader | null;
  menuItems?: IMainMenuItems[];
}

function HeaderButton({ href, label, isPrimary }: { href: string; label: string; isPrimary?: boolean }) {
  const { isActive } = useHeaderContext();
  
  if (isPrimary) {
    return (
      <Link href={href}>
        <Button variant="primary" className="font-sans font-bold text-sm px-6 py-2 transition-colors duration-300">
          {label}
        </Button>
      </Link>
    );
  }

  return (
    <Link href={href}>
      <Button variant="ghost" className={cn(
        "font-sans font-bold text-sm px-4 py-2 transition-colors duration-300 border-transparent",
        isActive ? "text-lh-shadow hover:text-lh-primary hover:bg-lh-neutral" : "text-lh-white hover:text-lh-light hover:bg-white/10"
      )}>
        {label}
      </Button>
    </Link>
  );
}

function HeaderContent({ data, menuItems }: IHeaderProps) {
  const { isActive } = useHeaderContext();
  
  if (!data) return null;

  const { logoText, ctaButton } = data;
  const primaryCta = ctaButton[0]; // Use first CTA button for mobile
  
  return (
    <>
      <div className="w-full relative flex items-center justify-center">
        {/* Mobile hamburger - top left */}
        <div className="absolute left-4 md:hidden">
          <MobileNavigation ctaButton={primaryCta} menuItems={menuItems} />
        </div>

        {/* Desktop navigation - left */}
        <nav className="hidden md:flex absolute left-4 items-center gap-4" aria-label="Main navigation">
          <NavigationMenu>
            <NavigationMenuList>
              {menuItems && menuItems.length > 0 && (
                <MainMenu data={menuItems} isHeaderActive={isActive} />
              )}
            </NavigationMenuList>
          </NavigationMenu>
        </nav>
        
        {/* Desktop CTA buttons - right, hidden on mobile */}
        <div className="hidden md:flex absolute right-4 gap-2">
          {ctaButton.map((button, index) => (
            <HeaderButton key={index} href={button.href} label={button.label} isPrimary={index === 0} />
          ))}
        </div>
        
        {/* Logo - centered */}
        <Logo data={logoText} />
      </div>
    </>
  );
}

export function Header({ data, menuItems }: IHeaderProps) {
  return (
    <HeaderWrapper>
      <HeaderContent data={data} menuItems={menuItems} />
    </HeaderWrapper>
  );
}
