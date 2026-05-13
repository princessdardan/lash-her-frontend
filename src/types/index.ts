// === Sanity Base Types ===

export interface TSanityImage {
  asset: { _ref: string; _type: "reference" };
  hotspot?: { x: number; y: number; width: number; height: number };
  crop?: { top: number; bottom: number; left: number; right: number };
  alt?: string;
}

// Portable Text block type — full renderer built in Phase 3
export interface TPortableTextBlock {
  _type: "block";
  _key: string;
  style?: string;
  children: Array<{ _type: "span"; _key: string; text: string; marks?: string[] }>;
  markDefs?: Array<{ _type: string; _key: string; [key: string]: unknown }>;
  listItem?: string;
  level?: number;
}

// === Shared Component Types ===

export type {
  BookingAnswerInput,
  BookingQuestion,
  BookingQuestionInputType,
  BookingRequestInput,
  BookingSettings,
  BookingSlot,
  BookingType,
  BookingTypeConfig,
  CalendarEventWindow,
} from "@/lib/booking/types";

export interface TLink {
  _key?: string;
  href: string;
  label: string;
  isExternal?: boolean;
}

export interface TMenuLink {
  _key?: string;
  name: string;
  url: string;
  description?: string;
}

export interface TFeature {
  _key?: string;
  heading: string;
  subHeading: string;
  icon: string;
}

export interface TCtaFeature {
  _key?: string;
  heading: string;
  subHeading: string;
  location: string;
  tier: string;
  features: TPortableTextBlock[];
  link: TLink;
  icon: string;
  mostPopular: boolean;
}

export interface THours {
  _key?: string;
  days: string;
  times: string;
}

export interface TContact {
  _key?: string;
  phone: string;
  email: string;
  location: string;
}

// === Layout Block Types ===
// Each block has _type and _key from Sanity arrays

export interface THeroSection {
  _type: "heroSection";
  _key: string;
  heading: string;
  subHeading: string;
  description: string;
  image: TSanityImage;
  link: TLink[];
  onHomepage: boolean;
}

export interface TFeaturesSection {
  _type: "featuresSection";
  _key: string;
  heading: string;
  subHeading: string;
  description: string;
  title: string;
  features: TFeature[];
}

export interface TCtaFeaturesSection {
  _type: "ctaFeaturesSection";
  _key: string;
  heading: string;
  subHeading: string;
  description: string;
  features: TCtaFeature[];
}

export interface TImageWithText {
  _type: "imageWithText";
  _key: string;
  heading: string;
  subHeading: string;
  description: string;
  perks: TPortableTextBlock[];
  image: TSanityImage;
  orientation: string;
}

export interface TInfoSection {
  _type: "infoSection";
  _key: string;
  heading: string;
  subHeading: string;
  info: TPortableTextBlock[];
}

export interface TPhotoGallery {
  _type: "photoGallery";
  _key: string;
  heading: string;
  subHeading: string;
  description: string;
  images: TSanityImage[];
}

export interface TSchedule {
  _type: "schedule";
  _key: string;
  heading: string;
  subHeading: string;
  hours: THours[];
}

export interface TContactInfo {
  _type: "contactInfo";
  _key: string;
  heading: string;
  subHeading: string;
  contact: TContact[];
}

export interface TContactFormLabels {
  _type: "contactFormLabels";
  _key: string;
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
}

export interface TGeneralInquiryLabels {
  _type: "generalInquiryLabels";
  _key: string;
  heading: string;
  subHeading: string;
  name: string;
  email: string;
  phone: string;
  instagram: string;
  message: string;
}

// === Block Union Types (per D-11 — moved here from page files) ===

export type TLayoutBlock =
  | THeroSection
  | TFeaturesSection
  | TCtaFeaturesSection
  | TImageWithText
  | TInfoSection
  | TPhotoGallery
  | TSchedule
  | TContactInfo
  | TContactFormLabels
  | TGeneralInquiryLabels;

// === Navigation Types ===

export interface TMenuDropdownSection {
  _key?: string;
  heading: string;
  links: TMenuLink[];
}

export interface TMenuDirectLink {
  _type: "menuDirectLink";
  _key: string;
  title: string;
  url: string;
}

export interface TMenuDropdown {
  _type: "menuDropdown";
  _key: string;
  title: string;
  sections: TMenuDropdownSection[];
}

export type TMainMenuItem = TMenuDirectLink | TMenuDropdown;

export interface TMainMenu {
  items: TMainMenuItem[];
}

// === Page / Document Types ===

export interface THomePage {
  title: string;
  description: string;
  blocks: TLayoutBlock[];
}

export interface TContactPage {
  title: string;
  subTitle: string;
  description: string;
  blocks: TLayoutBlock[];
}

export interface TGalleryPage {
  title: string;
  description: string;
  blocks: TLayoutBlock[];
}

export interface TTrainingPage {
  title: string;
  description: string;
  blocks: TLayoutBlock[];
}

export interface TTrainingProgramDetailItem {
  _key?: string;
  title: string;
  description: string;
  image?: TSanityImage;
}

export interface TTrainingProgram {
  _id: string;
  title: string;
  description: string;
  slug: string;
  detailHeading?: string;
  detailDescription?: string;
  detailItems?: TTrainingProgramDetailItem[];
  factList?: string[];
  primaryCta?: {
    label: string;
    href: string;
  };
  blocks: TLayoutBlock[];
  seo?: {
    title?: string;
    description?: string;
    image?: TSanityImage;
  };
}

export interface TTrainingProgramsPage {
  title: string;
  description: string;
  trainingPrograms: TTrainingProgram[];
}

export interface TProductCollection {
  _id: string;
  title: string;
  slug: string;
  description?: string;
  displayOrder?: number;
}

export interface TSellableProductFilterAttribute {
  _key?: string;
  label: string;
  value: string;
}

export interface TProductsPage {
  title: string;
  eyebrow?: string;
  description?: string;
  heroImage?: TSanityImage;
  featuredCollections?: TProductCollection[];
  emptyStateTitle?: string;
  emptyStateDescription?: string;
}

export type TSellableProductKind = "product" | "service" | "training" | "deposit";

export interface TSellableProductDetailSection {
  _key?: string;
  heading: string;
  content: string;
}

export interface TSellableProductVariant {
  _key: string;
  title: string;
  sku: string;
  price: number;
  isAvailable: boolean;
  availabilityLabel?: string;
}

export interface TSellableProduct {
  _id: string;
  title: string;
  description: string;
  shortDescription?: string;
  slug: string;
  sku: string;
  kind: TSellableProductKind;
  price: number;
  currency: "CAD";
  variants?: TSellableProductVariant[];
  isAvailable: boolean;
  availabilityLabel?: string;
  fulfillmentNote?: string;
  displayOrder?: number;
  image?: TSanityImage;
  gallery?: TSanityImage[];
  detailSections?: TSellableProductDetailSection[];
  seo?: {
    title?: string;
    description?: string;
    image?: TSanityImage;
  };
}

export interface THeader {
  logoText: TLink;
  ctaButton: TLink[];
}

export interface TFooter {
  logoText: TLink;
  text: string;
  socialLink: TLink[];
}

export interface TGlobalSettings {
  title: string;
  description: string;
  header: THeader;
  footer: TFooter;
}

export interface TMetaData {
  title: string;
  description: string;
  ogImageUrl: string | null;
}

// === Form Submission Types (used by Phase 4) ===

export interface TGeneralInquiry {
  _id: string;
  name: string;
  phone?: string;
  email: string;
  instagram?: string;
  message: string;
  _createdAt: string;
}

export interface TContactForm {
  _id: string;
  name: string;
  email: string;
  phone: string;
  location: string;
  instagram?: string;
  experience: string;
  interest: string;
  clients?: number;
  info?: string;
  _createdAt: string;
}
