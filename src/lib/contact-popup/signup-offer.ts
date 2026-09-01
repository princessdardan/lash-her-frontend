import "server-only";

import type { ContactPopupSignupOfferConfigSource } from "@/data/loaders";
import {
  parsePromotionCodeInput,
  type DiscountType,
} from "@/lib/commerce/discounts";
import {
  CONTACT_POPUP_OFFER_CTA_LABEL_MAX_LENGTH,
  CONTACT_POPUP_OFFER_CTA_URL_MAX_LENGTH,
  CONTACT_POPUP_OFFER_IDENTITY_MAX_LENGTH,
  CONTACT_POPUP_OFFER_LABEL_MAX_LENGTH,
  CONTACT_POPUP_OFFER_TERMS_MAX_LENGTH,
} from "./signup-offer-contract";

export interface ContactPopupSignupOfferSnapshot {
  promotionId: string;
  promotionRevision: string;
  promotionCode: string;
  discountType: DiscountType;
  discountAmount: number;
  appliesTo: "all";
  offerLabel: string;
  offerTerms: string;
  ctaLabel: string;
  ctaUrl: string;
  resolvedAt: string;
}

export type ContactPopupSignupOfferInvalidReason =
  | "configuration_unavailable"
  | "invalid_enabled_flag"
  | "missing_promotion_reference"
  | "promotion_unavailable"
  | "promotion_reference_mismatch"
  | "invalid_promotion_revision"
  | "invalid_offer_label"
  | "invalid_offer_terms"
  | "invalid_offer_cta_label"
  | "invalid_offer_cta_url"
  | "invalid_promotion_code"
  | "promotion_code_not_unique"
  | "promotion_disabled"
  | "promotion_not_sitewide"
  | "invalid_discount_type"
  | "invalid_discount_amount";

export type ContactPopupSignupOfferResolution =
  | { status: "disabled" }
  | { status: "available"; offer: ContactPopupSignupOfferSnapshot }
  | { status: "invalid"; reason: ContactPopupSignupOfferInvalidReason };

export interface ContactPopupSignupOfferDependencies {
  loadConfig: () => Promise<ContactPopupSignupOfferConfigSource | null>;
  now: () => Date;
}

const defaultDependencies: ContactPopupSignupOfferDependencies = {
  loadConfig: async () => {
    const { loaders } = await import("@/data/loaders");
    return loaders.getContactPopupSignupOfferConfig();
  },
  now: () => new Date(),
};

export async function resolveContactPopupSignupOffer(
  dependencies: ContactPopupSignupOfferDependencies = defaultDependencies,
): Promise<ContactPopupSignupOfferResolution> {
  let config: ContactPopupSignupOfferConfigSource | null;

  try {
    config = await dependencies.loadConfig();
  } catch {
    return { status: "invalid", reason: "configuration_unavailable" };
  }

  if (config === null || config.signupOfferEnabled == null) {
    return { status: "disabled" };
  }
  if (config.signupOfferEnabled === false) {
    return { status: "disabled" };
  }
  if (config.signupOfferEnabled !== true) {
    return { status: "invalid", reason: "invalid_enabled_flag" };
  }

  const promotionReferenceId = nonEmptyString(
    config.signupPromotionReferenceId,
    CONTACT_POPUP_OFFER_IDENTITY_MAX_LENGTH,
  );
  if (promotionReferenceId === null) {
    return { status: "invalid", reason: "missing_promotion_reference" };
  }

  const promotion = config.promotion;
  if (promotion == null) {
    return { status: "invalid", reason: "promotion_unavailable" };
  }

  const promotionId = nonEmptyString(
    promotion._id,
    CONTACT_POPUP_OFFER_IDENTITY_MAX_LENGTH,
  );
  if (promotionId === null || promotionId !== promotionReferenceId) {
    return { status: "invalid", reason: "promotion_reference_mismatch" };
  }

  const promotionRevision = nonEmptyString(
    promotion._rev,
    CONTACT_POPUP_OFFER_IDENTITY_MAX_LENGTH,
  );
  if (promotionRevision === null) {
    return { status: "invalid", reason: "invalid_promotion_revision" };
  }

  const label = nonEmptyString(
    config.signupOfferLabel,
    CONTACT_POPUP_OFFER_LABEL_MAX_LENGTH,
  );
  if (label === null) {
    return { status: "invalid", reason: "invalid_offer_label" };
  }

  const terms = nonEmptyString(
    config.signupOfferTerms,
    CONTACT_POPUP_OFFER_TERMS_MAX_LENGTH,
  );
  if (terms === null) {
    return { status: "invalid", reason: "invalid_offer_terms" };
  }

  const ctaLabel = nonEmptyString(
    config.signupOfferCtaLabel,
    CONTACT_POPUP_OFFER_CTA_LABEL_MAX_LENGTH,
  );
  if (ctaLabel === null) {
    return { status: "invalid", reason: "invalid_offer_cta_label" };
  }

  const ctaUrl = validHttpsUrl(config.signupOfferCtaUrl);
  if (ctaUrl === null) {
    return { status: "invalid", reason: "invalid_offer_cta_url" };
  }

  const code =
    typeof promotion.code === "string"
      ? parsePromotionCodeInput(promotion.code)
      : null;
  if (code == null || code !== promotion.code) {
    return { status: "invalid", reason: "invalid_promotion_code" };
  }

  if (
    promotion.matchingPromotionIds.length !== 1 ||
    promotion.matchingPromotionIds[0] !== promotionId
  ) {
    return { status: "invalid", reason: "promotion_code_not_unique" };
  }

  if (promotion.isEnabled !== true) {
    return { status: "invalid", reason: "promotion_disabled" };
  }
  if (promotion.appliesTo !== "all") {
    return { status: "invalid", reason: "promotion_not_sitewide" };
  }

  const discountType = promotion.discountType;
  if (discountType !== "percentage" && discountType !== "fixed") {
    return { status: "invalid", reason: "invalid_discount_type" };
  }

  const amount = promotion.amount;
  if (
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    (discountType === "percentage" && amount > 100)
  ) {
    return { status: "invalid", reason: "invalid_discount_amount" };
  }

  return {
    status: "available",
    offer: {
      promotionId,
      promotionRevision,
      promotionCode: code,
      discountType,
      discountAmount: amount,
      appliesTo: "all",
      offerLabel: label,
      offerTerms: terms,
      ctaLabel,
      ctaUrl,
      resolvedAt: dependencies.now().toISOString(),
    },
  };
}

function nonEmptyString(
  value: unknown,
  maxLength = Number.MAX_SAFE_INTEGER,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength
    ? normalized
    : null;
}

function validHttpsUrl(value: unknown): string | null {
  const normalized = nonEmptyString(
    value,
    CONTACT_POPUP_OFFER_CTA_URL_MAX_LENGTH,
  );
  if (normalized === null) return null;

  try {
    const url = new URL(normalized);
    return url.protocol === "https:" && Boolean(url.hostname)
      ? normalized
      : null;
  } catch {
    return null;
  }
}
