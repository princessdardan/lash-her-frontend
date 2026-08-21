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
  children: Array<{
    _type: "span";
    _key: string;
    text: string;
    marks?: string[];
  }>;
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
}

export interface TCtaFeature {
  _key?: string;
  format?: "standard" | "imageFeature";
  image?: TSanityImage;
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

export type THeroSize = "default" | "fullScreen" | "eighty" | "compact";

export interface THeroSlide {
  _key: string;
  image: TSanityImage;
  heading?: string;
  subHeading?: string;
  description?: string;
  link?: TLink[];
}

export interface THeroSection {
  _type: "heroSection";
  _key: string;
  heading: string;
  subHeading: string;
  description: string;
  image: TSanityImage;
  link: TLink[];
  onHomepage: boolean;
  heroSize?: THeroSize;
  slides?: THeroSlide[];
  autoRotate?: boolean;
  rotationIntervalMs?: number;
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

export interface TFeatureItem {
  _key: string;
  image?: TSanityImage;
  heading?: string;
  subHeading?: string;
  description?: string;
  link?: TLink;
  product?:
    | { _type: "reference"; _ref: string }
    | Pick<
        TProduct,
        | "_id"
        | "title"
        | "slug"
        | "shortDescription"
        | "description"
        | "cardSubtitle"
        | "image"
      >;
}

export type TFeatureLayout = "imageLeft" | "imageRight" | "imageTop";

export interface TFeatureSection {
  _type: "featureSection";
  _key: string;
  heading?: string;
  subHeading?: string;
  layout: TFeatureLayout;
  enableCarousel: boolean;
  carouselIntervalMs?: number;
  items: TFeatureItem[];
}

export interface THomeTrainingProgramsSection {
  _type: "homeTrainingProgramsSection";
  _key: string;
  trainingProgramsPage?: TTrainingProgramsPage;
}

// === Block Union Types (per D-11 — moved here from page files) ===

export type TLayoutBlock =
  | THeroSection
  | TCtaFeaturesSection
  | TImageWithText
  | TInfoSection
  | TPhotoGallery
  | TSchedule
  | TContactInfo
  | TContactFormLabels
  | TGeneralInquiryLabels
  | TFeatureSection
  | THomeTrainingProgramsSection;

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
  eyelash?: string;
  title: string;
  description?: string | TPortableTextBlock[];
}

export interface TTrainingContactSection {
  _type?: "trainingContactSection";
  enabled?: boolean;
  heading?: string;
  subHeading?: string;
  name?: string;
  email?: string;
  phone?: string;
  location?: string;
  instagram?: string;
  submitLabel?: string;
  successMessage?: string;
  privacyPolicyText?: TPortableTextBlock[];
}

export interface TTrainingProgram {
  _id: string;
  title: string;
  description: string;
  heroSubtitle?: string;
  heroImage?: TSanityImage;
  heroBadges?: string[];
  slug: string;
  detailHeading?: string;
  detailEyebrow?: string;
  detailDescription?: string;
  detailItems?: TTrainingProgramDetailItem[];
  factList?: string[];
  primaryCta?: {
    label: string;
    href: string;
  };
  secondaryCta?: {
    label: string;
    href: string;
  };
  enrollmentTitle?: string;
  enrollmentDescription?: string;
  enrollmentBackgroundImage?: TSanityImage;
  checkoutEnabled?: boolean;
  price?: number;
  discountPrice?: number;
  currency?: "CAD";
  isAvailable?: boolean;
  availabilityLabel?: string;
  fulfillmentNote?: string;
  displayOrder?: number;
  image?: TSanityImage;
  checkoutCtaLabel?: string;
  checkoutDisabledBookingCta?: {
    label: string;
    href: string;
  };
  postPurchaseInstructions?: string;
  introCallAppointmentScheduleUrl?: string;
  introCallAppointmentScheduleEmbedMode?: "link" | "embed";
  introCallSchedulingInstructions?: string;
  trainingContact?: TTrainingContactSection;
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

export type TPolicyPageType =
  | "privacy"
  | "cookie"
  | "booking"
  | "return"
  | "refund"
  | "faq"
  | "terms"
  | "general";

export interface TPolicyPage {
  _id: string;
  _updatedAt?: string;
  title: string;
  slug: string;
  pageType: TPolicyPageType;
  summary?: string;
  body: TPortableTextBlock[];
  seo?: {
    title?: string;
    description?: string;
    noIndex?: boolean;
  };
}

export interface TProductCollection {
  _id: string;
  _key?: string;
  title: string;
  slug: string;
  description?: string;
  displayOrder?: number;
}

/**
 * An authored option axis (e.g. "Curl" or "Length"). A product carries at most
 * two of these; the purchasable variants are the cartesian product of their
 * values. This is the single source of truth editors author.
 */
export interface TProductOption {
  _key?: string;
  name: string | null;
  values: Array<string | null>;
}

/**
 * A single axis selection on a variant (e.g. { name: "Curl", value: "C" }).
 * Used both on derived variants and to identify an override's target
 * combination.
 */
export interface TProductVariantOption {
  _key?: string;
  name: string | null;
  value?: string | null;
}

/**
 * Sparse, per-combination deviation from the product defaults. Editors add one
 * only when a specific combination needs its own price, stock, SKU, or
 * shipping; every unlisted combination inherits the product-level values.
 */
export interface TProductVariantOverride {
  _key?: string;
  select: TProductVariantOption[];
  image?: TSanityImage;
  price?: number | null;
  discountPrice?: number | null;
  sku?: string;
  isAvailable?: boolean;
  availabilityLabel?: string;
  /**
   * Restock set-point for this combination, authored in Sanity. Seeds/updates
   * the authoritative Postgres count via the inventory sync; blank leaves the
   * combination untracked (unlimited). Not a live readout — see product-stock.
   */
  stockQuantity?: number | null;
  shipping?: TProductShippingMetadata;
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

export type TCommerceCurrency = "CAD";

export interface TCommerceSeo {
  title?: string;
  description?: string;
  image?: TSanityImage;
}

export interface TCommerceDetailSection {
  _key?: string;
  heading: string;
  content?: string;
  body?: TPortableTextBlock[];
}

export interface TProductVariant {
  _key: string;
  title: string;
  sku?: string;
  price: number;
  discountPrice?: number | null;
  isAvailable: boolean;
  availabilityLabel?: string;
  /** Restock set-point authored on this combination's override, if any. */
  stockQuantity?: number | null;
  /**
   * Live units available to sell (`onHand - reserved`) from Postgres, merged in
   * at storefront read time. `undefined`/`null` means untracked (unlimited).
   */
  availableQuantity?: number | null;
  options?: TProductVariantOption[];
  image?: TSanityImage;
  shipping?: TProductShippingMetadata;
}

export interface TProductShippingMetadata {
  fulfillmentMode: "physical" | "manual";
  weightGrams?: number;
  lengthCm?: number;
  widthCm?: number;
  heightCm?: number;
  isRigid?: boolean;
  customsDescription?: string;
  countryOfOrigin?: string;
  usShippingApproved?: boolean;
  hsTariffCode?: string;
  manufacturerName?: string;
  manufacturerAddress?: string;
  manufacturerCity?: string;
  manufacturerProvinceCode?: string;
  manufacturerPostalCode?: string;
  manufacturerCountryCode?: string;
  usRegulatoryCertification?: TProductUsRegulatoryCertification;
  hazardousMaterial?: boolean;
}

export interface TProductUsRegulatoryCertification {
  version: string;
  usShippingContractVersion: string;
  tariffMetadataSchemaVersion: string;
  fdaRequirementsVersion: string;
  evidenceReference: string;
  reviewedAt: string;
  validUntil: string;
  additionalTariffApplicability: "not_applicable" | "required";
  additionalTariffDetails?: {
    steel?: number;
    copper?: number;
    aluminum?: number;
  };
  fdaApplicability: "not_applicable" | "provider_assessed";
}

export interface TProduct {
  _id: string;
  title: string;
  description: string;
  shortDescription?: string;
  cardSubtitle?: string;
  badgeLabel?: string;
  slug: string;
  price: number;
  discountPrice?: number | null;
  sku?: string;
  currency: TCommerceCurrency;
  collections?: TProductCollection[];
  /** Authored option axes (0, 1, or 2). The single source of truth. */
  options?: TProductOption[];
  /** Sparse per-combination overrides; empty for most products. */
  variantOverrides?: TProductVariantOverride[];
  /** Derived purchasable combinations, produced by normalizeProductVariantModel. */
  variants?: TProductVariant[];
  isAvailable: boolean;
  availabilityLabel?: string;
  /**
   * Restock set-point for a product with no options, authored in Sanity. Seeds
   * the product-level Postgres count via the inventory sync; blank leaves the
   * product untracked (unlimited). For products with options, author stock per
   * combination on the matching variant override instead.
   */
  stockQuantity?: number | null;
  /**
   * Live units available to sell for a no-option product, merged in at
   * storefront read time. `undefined`/`null` means untracked (unlimited). For a
   * product with options, availability lives on each variant instead.
   */
  availableQuantity?: number | null;
  fulfillmentNote?: string;
  shipping?: TProductShippingMetadata;
  displayOrder?: number;
  image?: TSanityImage;
  gallery?: TSanityImage[];
  detailSections?: TCommerceDetailSection[];
  seo?: TCommerceSeo;
}

export interface TServiceAddOn {
  _key: string;
  name: string;
  description: string;
  price: number;
  image?: TSanityImage;
}

export interface TServiceEditorial {
  _id: string;
  title: string;
  description: string;
  shortDescription?: string;
  slug: string;
  image?: TSanityImage;
  gallery?: TSanityImage[];
  detailSections?: TCommerceDetailSection[];
  seo?: TCommerceSeo;
}

/**
 * Legacy Sanity commerce shape retained for migration-only booking paths.
 * New service commerce data belongs to the operational database.
 */
export interface TService extends TServiceEditorial {
  showDetailPage: boolean;
  durationMinutes: number;
  fullPrice: number;
  depositAmount: number;
  addOns?: TServiceAddOn[];
  currency: TCommerceCurrency;
  isAvailable: boolean;
  displayOrder?: number;
}

export interface TTrainingProgramCatalogItem {
  _id: string;
  title: string;
  description: string;
  slug: string;
  checkoutEnabled?: boolean;
  price?: number;
  discountPrice?: number;
  currency?: TCommerceCurrency;
  isAvailable?: boolean;
  availabilityLabel?: string;
  fulfillmentNote?: string;
  displayOrder?: number;
  image?: TSanityImage;
  checkoutCtaLabel?: string;
  seo?: TCommerceSeo;
}

export type TPromotionDiscountType = "percentage" | "fixed";
export type TPromotionAppliesTo =
  | "all"
  | "products"
  | "trainingPrograms"
  | "specificItems";

export interface TPromotionCode {
  _id: string;
  title?: string;
  code: string;
  isEnabled?: boolean;
  discountType: TPromotionDiscountType;
  amount: number;
  appliesTo?: TPromotionAppliesTo;
  products?: Array<Pick<TProduct, "_id">>;
  trainingPrograms?: Array<Pick<TTrainingProgram, "_id">>;
  /** Legacy V1 booking eligibility retained during the operational cutover. */
  services?: Array<Pick<TServiceEditorial, "_id">>;
}

export interface TProductsGroupedCatalog {
  products: TProduct[];
  trainingPrograms: TTrainingProgramCatalogItem[];
  services: TServiceEditorial[];
}

export interface THeader {
  logoText: TLink;
  ctaButton: TLink[];
}

export interface TFooter {
  logoText: TLink;
  text: string;
  socialLink: TLink[];
  navigationMenus?: TFooterNavigationMenu[];
}

export type TFooterNavigationLinkType = "direct" | "external";

export interface TFooterNavigationItem {
  _key?: string;
  title: string;
  url: string;
  linkType?: TFooterNavigationLinkType;
}

export interface TFooterNavigationMenu {
  _key?: string;
  heading?: string;
  items: TFooterNavigationItem[];
}

export interface TContactPopupSettings {
  enabled?: boolean;
  variant?: "fullContact" | "emailOnly";
  heading?: string;
  description?: string;
  privacyText?: string;
  privacyLinkLabel?: string;
  privacyLinkHref?: string;
  submitLabel?: string;
  successMessage?: string;
  cookieExpiryDays?: number;
}

export interface TGlobalSettings {
  title: string;
  description: string;
  header: THeader;
  footer: TFooter;
  contactPopup?: TContactPopupSettings;
}

export interface TMetaData {
  title: string;
  description: string;
  ogImageUrl: string | null;
}
