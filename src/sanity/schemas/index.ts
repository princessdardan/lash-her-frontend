// Documents — Singletons
import { homePage } from "./documents/home-page";
import { contactPage } from "./documents/contact-page";
import { galleryPage } from "./documents/gallery-page";
import { trainingPage } from "./documents/training-page";
import { trainingProgramsPage } from "./documents/training-programs-page";
import { productsPage } from "./documents/products-page";
import { globalSettings } from "./documents/global-settings";
import { mainMenu } from "./documents/main-menu";
import { bookingSettings } from "./documents/booking-settings";

// Documents — Collections
import { product } from "./documents/product";
import { productCollection } from "./documents/product-collection";
import { promotionCode } from "./documents/promotion-code";
import { service } from "./documents/service";
import { trainingProgram } from "./documents/training-program";

// Objects — Layout blocks
import { heroSection } from "./objects/layout/hero-section";
import { ctaFeaturesSection } from "./objects/layout/cta-features-section";
import { ctaSectionImage } from "./objects/layout/cta-section-image";
import { ctaSectionVideo } from "./objects/layout/cta-section-video";
import { imageWithText } from "./objects/layout/image-with-text";
import { infoSection } from "./objects/layout/info-section";
import { photoGallery } from "./objects/layout/photo-gallery";
import { schedule } from "./objects/layout/schedule";
import { contactInfo } from "./objects/layout/contact-info";
import { contactFormLabels } from "./objects/layout/contact-form-labels";
import { generalInquiryLabels } from "./objects/layout/general-inquiry-labels";
import { featureSection } from "./objects/layout/feature-section";
import { trainingContactSection } from "./objects/layout/training-contact-section";
import { header } from "./objects/layout/header";
import { footer } from "./objects/layout/footer";

// Objects — Shared sub-objects
import { link } from "./objects/shared/link";
import { menuLink } from "./objects/shared/menu-link";
import { ctaFeature } from "./objects/shared/cta-feature";
import { contact } from "./objects/shared/contact";
import { hours } from "./objects/shared/hours";

// Objects — Navigation
import { menuDirectLink } from "./objects/shared/menu-direct-link";
import { menuDropdown } from "./objects/shared/menu-dropdown";
import { menuDropdownSection } from "./objects/shared/menu-dropdown-section";

export const schemaTypes = [
  // Documents
  homePage,
  contactPage,
  galleryPage,
  trainingPage,
  trainingProgramsPage,
  productsPage,
  globalSettings,
  mainMenu,
  bookingSettings,
  product,
  productCollection,
  promotionCode,
  service,
  trainingProgram,
  // Layout blocks
  heroSection,
  ctaFeaturesSection,
  ctaSectionImage,
  ctaSectionVideo,
  imageWithText,
  infoSection,
  photoGallery,
  schedule,
  contactInfo,
  contactFormLabels,
  generalInquiryLabels,
  featureSection,
  trainingContactSection,
  header,
  footer,
  // Shared objects
  link,
  menuLink,
  ctaFeature,
  contact,
  hours,
  // Navigation
  menuDirectLink,
  menuDropdown,
  menuDropdownSection,
];
