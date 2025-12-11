import { TImage, TLink } from "@/types";

export interface CTASectionImageProps {
    id: number;
    __component: string;
    heading: string;
    description: string;
    image: TImage
    link: TLink[];
}
export function CtaSectionImage({ data }: { data: CTASectionImageProps }) {
    if (!data) return null;
    
    const { heading, description, image, link } = data;
    return (
        <div>
            
        </div>
    );
}