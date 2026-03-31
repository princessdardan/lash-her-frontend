// Documents — Singletons
import { homePage } from "./documents/home-page";
import { contactPage } from "./documents/contact-page";
import { galleryPage } from "./documents/gallery-page";
import { trainingPage } from "./documents/training-page";
import { trainingProgramsPage } from "./documents/training-programs-page";
import { globalSettings } from "./documents/global-settings";
import { mainMenu } from "./documents/main-menu";

// Documents — Collections
import { trainingProgram } from "./documents/training-program";
import { contactForm } from "./documents/contact-form";
import { generalInquiry } from "./documents/general-inquiry";

// Objects — Layout blocks
import { heroSection } from "./objects/layout/hero-section";
import { featuresSection } from "./objects/layout/features-section";
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
import { header } from "./objects/layout/header";
import { footer } from "./objects/layout/footer";

// Objects — Shared sub-objects
import { link } from "./objects/shared/link";
import { menuLink } from "./objects/shared/menu-link";
import { feature } from "./objects/shared/feature";
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
  globalSettings,
  mainMenu,
  trainingProgram,
  contactForm,
  generalInquiry,
  // Layout blocks
  heroSection,
  featuresSection,
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
  header,
  footer,
  // Shared objects
  link,
  menuLink,
  feature,
  ctaFeature,
  contact,
  hours,
  // Navigation
  menuDirectLink,
  menuDropdown,
  menuDropdownSection,
];
