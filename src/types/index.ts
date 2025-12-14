import { TContactPageBlocks } from "@/app/(site)/contact/page";
import { TGalleryPageBlocks } from "@/app/(site)/gallery/page";
import { TBlocks } from "@/app/(site)/homepage/page";
import { TrainingProgramBlocks } from "@/app/(site)/training-programs/[slug]/page";
import { TTrainingPageBlocks } from "@/app/(site)/training/page";
import { IMainMenuItems } from "@/app/main-menu";

// Strapi Block Rich Text Types
export type BlocksContent = Array<
  | ParagraphBlock
  | HeadingBlock
  | ListBlock
  | QuoteBlock
  | CodeBlock
  | ImageBlock
  | LinkBlock
>;

export interface ParagraphBlock {
  type: "paragraph";
  children: InlineNode[];
}

export interface HeadingBlock {
  type: "heading";
  level: 1 | 2 | 3 | 4 | 5 | 6;
  children: InlineNode[];
}

export interface ListBlock {
  type: "list";
  format: "ordered" | "unordered";
  children: ListItemBlock[];
}

export interface ListItemBlock {
  type: "list-item";
  children: InlineNode[];
}

export interface QuoteBlock {
  type: "quote";
  children: InlineNode[];
}

export interface CodeBlock {
  type: "code";
  children: InlineNode[];
}

export interface ImageBlock {
  type: "image";
  image: {
    name: string;
    alternativeText?: string | null;
    url: string;
    caption?: string | null;
    width: number;
    height: number;
    formats?: Record<string, unknown>;
    hash: string;
    ext: string;
    mime: string;
    size: number;
    previewUrl?: string | null;
    provider: string;
    provider_metadata?: unknown;
    createdAt: string;
    updatedAt: string;
  };
  children: [{ type: "text"; text: "" }];
}

export interface LinkBlock {
  type: "link";
  url: string;
  children: InlineNode[];
}

export type InlineNode = TextNode | LinkInline;

export interface TextNode {
  type: "text";
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  code?: boolean;
}

export interface LinkInline {
  type: "link";
  url: string;
  children: TextNode[];
}

export interface BaseParams {
  [key: string]: string | string[] | undefined;
}

export interface RouteParams extends BaseParams {
  documentId?: string;
}

export type Params = Promise<RouteParams>;
export type SearchParams = Promise<BaseParams>;

export type TImage = {
  id: number;
  documentId: string;
  url: string;
  alternativeText: string | null;
};

export type TVideo =  {
  id: number;
  documentId: string;
  url: string;
  alternativeText: string | null;
  name?: string;
  caption?: string | null;
  width?: number;
  height?: number;
  formats?: Record<string, unknown>;
  hash?: string;
  ext?: string;
  mime?: string;
  size?: number;
  previewUrl?: string | null;
  provider?: string;
  provider_metadata?: unknown;
  createdAt?: string;
  updatedAt?: string;
}

//Component Types// 
export type TMenuLink = {
  id: number;
  title: string;
  url: string;
}

export type TLink = {
  id: number;
  href: string;
  label: string;
  isExternal?: boolean;
};

export type TFeature = {
  id: number;
  heading: string;
  subHeading: string;
  icon: string;
};

export type TImageWithText = {
  id: number; 
  heading: string;
  subHeading: string;
  description: string;
  perks: BlocksContent;
  image: TImage;
  orientation: string;
  imageLocation: string;
}

export type THours = {
  id: number;
  days: string;
  times: string;
};

export type TContact = {
  id: number;
  phone: string;
  email: string;
  location: string;
};

export type TSchedule = {
  id: number;
  heading: string;
  subHeading: string;
  hours: THours[];
};

// Collection Label Types //

export type TContactFormLabels = {
  heading: string;
  subHeading: string;
  name: string;
  email: string;
  phone: string;
  location: string;
  instagram: string;
  experience: string;
  interest: string;
  clients: string;
  info: string;
};

export type TGeneralInquiryLabels = {
  heading: string;
  subHeading: string;
  name: string;
  email: string;
  phone: string;
  instagram: string;
  message: string;
};


//Page Types//

export type TMainMenu = {
  id: number;
  documentId: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string;
  MainMenuItems: IMainMenuItems[];
};

export type THomePage = {
  documentId: string;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string;
  blocks: TBlocks[]; // we will change this soon
};

export type TTrainingProgramCollection = {
  id: number;
  documentId: string;
  title: string;
  slug: string;
  description: string;
  blocks: TrainingProgramBlocks[];
  createdAt: string;
  updatedAt: string;
  publishedAt: string;
};

export type TTrainingProgramsPage = {
  id: number;
  documentId: string;
  title: string;
  description: string;
  training_programs: TTrainingProgramCollection[];
  createdAt: string;
  updatedAt: string;
  publishedAt: string;
};

export type THeader = {
  logoText: TLink;
  ctaButton: TLink[];
};

export type TFooter = {
  logoText: TLink;
  text: string;
  socialLink: TLink[];
};

export type TContactPage = {
  id: number;
  documentId: string;
  title: string;
  subTitle: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string;
  blocks: TContactPageBlocks[];
};

export type TGalleryPage = {
  id: number;
  documentId: number;
  title: string;
  description: string;
  blocks: TGalleryPageBlocks[];
};

export type TTrainingPage = {
  id: number;
  documentId: string;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string;
  blocks: TTrainingPageBlocks[];
};

export type TGlobal = {
  documentId: string;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string;
  header: THeader;
  footer: TFooter;
};

export type TMetaData = {
  documentId: string;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string;
};

export type TSummary = {
  documentId: string;
  videoId: string;
  userId: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string;
};

export type TAuthUser = {
  id: number;
  documentId: string;
  username: string;
  email: string;
  firstName?: string;
  lastName?: string;
  bio?: string;
  credits?: number;
  provider: string;
  confirmed: boolean;
  blocked: boolean;
  createdAt: string;
  updatedAt: string;
  publishedAt: string;
};

//Collection Form Types//

export type TGeneralInquiry = {
  id: number;
  documentId: string;
  name: string;
  phone?: string;
  email: string;
  instagram?: string;
  message: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string;
}

export type TContactForm = {
  id: number;
  documentId: string;
  name: string;
  email: string;
  phone: string;
  location: string;
  instagram?: string;
  experience: string;
  interest: string;
  clients?: number;
  info?: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string;
};

export type TStrapiResponse<T = null> = {
  success: boolean;
  data?: T;
  error?: {
    status: number;
    name: string;
    message: string;
    details?: Record<string, string[]>;
  };
  meta?: {
    pagination: {
      page: number;
      pageSize: number;
      pageCount: number;
      total: number;
    };
  };
  status: number;
};