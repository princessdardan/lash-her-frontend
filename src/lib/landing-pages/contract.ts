import type { CampaignAttribution } from "@/lib/highlevel/attribution";

// Keep aligned with top-level app routes and next.config.ts redirects.
export const RESERVED_LANDING_PAGE_SLUGS = new Set([
  "admin",
  "api",
  "booking",
  "checkout",
  "contact",
  "courses",
  "gallery",
  "homepage",
  "policies",
  "products",
  "services",
  "studio",
  "training",
  "training-programs",
]);

export function validateLandingPageSlug(value: unknown): true | string {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) ||
    value.length > 96
  ) {
    return "Use 1–96 lowercase letters, numbers, and single hyphens between words.";
  }
  return RESERVED_LANDING_PAGE_SLUGS.has(value)
    ? "This URL is reserved for an existing website section. Choose another slug."
    : true;
}

export interface LandingPageSignupInput {
  slug: string;
  email: string;
  marketingConsent: boolean;
  company?: string;
  attribution?: CampaignAttribution;
}

export interface LandingPageSignupResult {
  success: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
}
