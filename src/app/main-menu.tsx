import { NavigationMenuContent, NavigationMenuItem, NavigationMenuLink, NavigationMenuTrigger } from "@/components/ui/navigation-menu";
import { TMenuLink } from "@/types";
import { cn } from "@/lib/utils";
import Link from "next/link";

export interface MenuLinkProps {
    id: number;
    __component: string;
    title: string;
    url: string;
}

export interface TSection {
    id: number;
    documentId: string;
    createdAt: string;
    updatedAt: string;
    publishedAt: string;
    heading: string;
    links: TMenuLink[];
}

export interface DropdownMenuProps {
    id: number;
    __component: string;
    title: string;
    sections: TSection[];
}

export type IMainMenuItems = MenuLinkProps | DropdownMenuProps;

function MenuLink({ data, isHeaderActive }: { data: MenuLinkProps; isHeaderActive: boolean }) {
    if (!data) return null;

    const { title, url } = data;

    return (
        <NavigationMenuLink asChild>
            <Link 
                href={url} 
                className={cn(
                    "text-md font-normal transition-colors px-4 py-2 block",
                    isHeaderActive
                        ? "text-brand-red hover:text-brand-red/70"
                        : "text-brand-pink hover:text-brand-red"
                )}
            >
                {title}
            </Link>
        </NavigationMenuLink>
    )
}
function Dropdown({ data, isHeaderActive }: { data: DropdownMenuProps; isHeaderActive: boolean }) {
    if (!data) return null;

    const { title, sections } = data;
    if (!sections || sections.length === 0) return null;
    
    return (
        <>
            <NavigationMenuTrigger 
                className={cn(
                    "text-md font-normal transition-colors bg-transparent! data-[state=open]:bg-transparent!",
                    isHeaderActive
                        ? "text-brand-red hover:text-brand-red/70 data-[state=open]:text-brand-red"
                        : "text-brand-pink hover:text-brand-red data-[state=open]:text-brand-pink"
                )}
            >
                {title}
            </NavigationMenuTrigger>
            <NavigationMenuContent>
                <div className="min-w-[280px] rounded-md bg-white p-4">
                    {sections.map((section) => (
                        <div key={section.id} className="mb-2 last:mb-0">
                            {section.heading && (
                                <h3 className="px-2 py-2 text-xs font-semibold text-black uppercase tracking-wider">
                                    {section.heading}
                                </h3>   
                            )}
                            {section.links && section.links.length > 0 && (
                                <ul className="flex flex-col gap-1">
                                    {section.links.map((link) => (
                                        <li key={link.id}>
                                            <NavigationMenuLink asChild>
                                                <Link
                                                    href={link.url}
                                                    className="flex items-start gap-3 px-4 py-2.5 rounded-md transition-colors text-brand-red hover:bg-brand-pink/5 hover:text-brand-red/70"
                                                >
                                                    <div className="flex-1 min-w-0">
                                                        <div className="text-md font-normal">
                                                            {link.title}
                                                        </div>
                                                    </div>
                                                </Link>
                                            </NavigationMenuLink>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    ))}
                </div>
            </NavigationMenuContent>
        </>
    )
}

function mainMenuRenderer(MainMenuItem: IMainMenuItems, index: number, isHeaderActive: boolean) {
    switch (MainMenuItem.__component) {
        case "menu.menu-link":
            return <MenuLink key={index} data={MainMenuItem as MenuLinkProps} isHeaderActive={isHeaderActive} />;
        case "menu.dropdown":
            return <Dropdown key={index} data={MainMenuItem as DropdownMenuProps} isHeaderActive={isHeaderActive} />;
        default:
            return null;
    }
}

export function MainMenu({ data, isHeaderActive }: { data: IMainMenuItems[]; isHeaderActive: boolean }) {
    if (!data || data.length === 0) return null;
    
    return (
        <>
            {data.map((item, index) => (
                <NavigationMenuItem key={item.id}>
                    {mainMenuRenderer(item, index, isHeaderActive)}
                </NavigationMenuItem>
            ))}
        </>
    )
}
