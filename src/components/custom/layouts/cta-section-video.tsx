import { TLink, TVideo } from "@/types";

export interface CTASectionVideoProps {
    id: number;
    __component: string;
    heading: string;
    description: string;
    image: TVideo
    link: TLink[];
}