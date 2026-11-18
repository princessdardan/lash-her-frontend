import "server-only";

import { isIntegrationFeatureEnabled } from "@/lib/api-integration/rollout-flags";
import { courseTaxReady } from "./tax";

export const courseRecoveryEnabled = () =>
  isIntegrationFeatureEnabled("entitlementRecovery");
export const coursePurchaseAccountEnabled = () =>
  isIntegrationFeatureEnabled("courseReads") &&
  isIntegrationFeatureEnabled("customerAccess") &&
  process.env.CUSTOMER_AUTH_ENABLED === "true";
export const courseCheckoutEnabled = () =>
  coursePurchaseAccountEnabled() &&
  courseRecoveryEnabled() &&
  isIntegrationFeatureEnabled("checkout") &&
  courseTaxReady() &&
  Boolean(process.env.RESEND_API_KEY);
