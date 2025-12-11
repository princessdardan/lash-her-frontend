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


interface IHeaderProps {
  data?: THeader | null;
  menuItems?: IMainMenuItems[];
}

function HeaderButton({ href, label }: { href: string; label: string }) {
  const { isActive } = useHeaderContext();
  
  return (
    <Link href={href}>
      <Button className={`font-sans font-light text-2xl text-md italic px-4 py-3 transition-colors duration-300 ${
        isActive 
          ? "bg-brand-red text-white hover:bg-brand-red/90" 
          : "bg-brand-pink text-brand-red hover:bg-brand-red/90"
      }`}>
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
        
        {/* Desktop CTA buttons - top right, hidden on mobile */}
        <div className="hidden md:flex absolute right-4 gap-2">
          {ctaButton.map((button, index) => (
            <HeaderButton key={index} href={button.href} label={button.label} />
          ))}
        </div>
        
        {/* Logo - centered */}
        <Logo data={logoText} />
      </div>
      
      {/* Desktop navigation - hidden on mobile */}
      <div className="hidden md:flex items-center gap-4 mt-4">
        <NavigationMenu>
          <NavigationMenuList>
            {menuItems && menuItems.length > 0 && (
              <MainMenu data={menuItems} isHeaderActive={isActive} />
            )}
          </NavigationMenuList>
        </NavigationMenu>
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