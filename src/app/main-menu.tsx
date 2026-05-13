import { NavigationMenuContent, NavigationMenuItem, NavigationMenuLink, NavigationMenuTrigger } from "@/components/ui/navigation-menu";
import type { TMainMenuItem, TMenuDirectLink, TMenuDropdown, TMenuDropdownSection, TMenuLink } from "@/types";
import { cn } from "@/lib/utils";
import Link from "next/link";

export type { TMainMenuItem as IMainMenuItems } from "@/types";

function MenuLink({ data, isHeaderActive }: { data: TMenuDirectLink; isHeaderActive: boolean }) {
    if (!data) return null;

    const { title, url } = data;

    return (
        <Link
            href={url}
            className={cn(
                "text-lg font-heading tracking-wide transition-colors px-4 py-2 block no-underline",
                isHeaderActive
                    ? "text-lh-shadow hover:text-lh-primary"
                    : "text-white hover:text-lh-light"
            )}
        >
            {title}
        </Link>
    )
}
function Dropdown({ data, isHeaderActive }: { data: TMenuDropdown; isHeaderActive: boolean }) {
    if (!data) return null;

    const { title, sections } = data;
    if (!sections || sections.length === 0) return null;

    return (
        <>
            <NavigationMenuTrigger
                className={cn(
                    "text-lg font-heading tracking-wide transition-colors bg-transparent! data-[state=open]:bg-transparent!",
                    isHeaderActive
                        ? "text-lh-shadow hover:text-lh-primary data-[state=open]:text-lh-primary"
                        : "text-white hover:text-lh-light data-[state=open]:text-white"
                )}
            >
                {title}
            </NavigationMenuTrigger>
            <NavigationMenuContent>
                <div className="min-w-[280px] rounded-[18px] bg-lh-white p-6 shadow-lg border border-lh-line">
                    {sections.map((section: TMenuDropdownSection, index: number) => (
                        <div key={section._key || index} className="mb-6 last:mb-0">
                            {section.heading && (
                                <h3 className="px-3 py-2 text-[11px] font-heading text-lh-light uppercase tracking-[0.28em]">
                                    {section.heading}
                                </h3>
                            )}
                            {section.links && section.links.length > 0 && (
                                <ul className="flex flex-col gap-1 mt-1">
                                    {section.links.map((link: TMenuLink, linkIndex: number) => (
                                        <li key={link._key || linkIndex}>
                                            <NavigationMenuLink asChild>
                                                <Link
                                                    href={link.url}
                                                    className="flex items-start gap-3 px-3 py-2 rounded-md transition-colors text-lh-shadow hover:bg-lh-neutral hover:text-lh-primary no-underline"
                                                >
                                                    <div className="flex-1 min-w-0">
                                                        <div className="text-lg font-heading">
                                                            {link.name}
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

function mainMenuRenderer(MainMenuItem: TMainMenuItem, index: number, isHeaderActive: boolean) {
    switch (MainMenuItem._type) {
        case "menuDirectLink":
            return <MenuLink key={MainMenuItem._key || index} data={MainMenuItem as TMenuDirectLink} isHeaderActive={isHeaderActive} />;
        case "menuDropdown":
            return <Dropdown key={MainMenuItem._key || index} data={MainMenuItem as TMenuDropdown} isHeaderActive={isHeaderActive} />;
        default:
            return null;
    }
}

export function MainMenu({ data, isHeaderActive }: { data: TMainMenuItem[]; isHeaderActive: boolean }) {
    if (!data || data.length === 0) return null;

    return (
        <>
            {data.map((item, index) => (
                <NavigationMenuItem key={item._key || index}>
                    {mainMenuRenderer(item, index, isHeaderActive)}
                </NavigationMenuItem>
            ))}
        </>
    )
}
