import { createHash } from "node:crypto";

/**
 * Source-controlled Terms-of-sale assent presented at product checkout.
 *
 * Ontario Reg. 17/05 (Internet agreements), ss. 31–33, requires that the
 * checkout — not merely a standalone Terms page — disclose the transaction
 * terms, give the customer an express opportunity to accept or decline, and
 * deliver a retainable copy. This constant is the acceptance statement the
 * customer affirmatively agrees to; order creation records the accepted
 * `version` + a SHA-256 of `text` + the presented/accepted timestamps so the
 * assent is provable after the fact.
 *
 * ✅ LEGALLY REVIEWED (2026-08-19): the wording below (and the full Terms it
 * points to) has been confirmed by the business/legal owner as final for
 * production. Bump `version` on ANY future wording change — checkout re-validates
 * the accepted assent against `version` + the text hash, so a silent text edit
 * would reject in-flight and previously-recorded assents, and any such change
 * requires a fresh legal sign-off.
 */
export const PRODUCT_CHECKOUT_TERMS = {
  version: "product-checkout-terms-2026-08-18",
  text: "I have read and agree to the Lash Her Terms and Conditions and to the cancellation and refund policy shown at checkout. I understand that a copy of these terms and my order details will be provided to me for my records after payment.",
} as const;

export interface ProductCheckoutTermsRequirement {
  version: string;
  text: string;
  textHash: string;
}

/**
 * The current Terms assent the checkout must present and order creation must
 * re-validate. The hash is computed from the trimmed `text` so the client can
 * echo it without ever authoring the canonical value.
 */
export function getProductCheckoutTermsRequirement(): ProductCheckoutTermsRequirement {
  const text = PRODUCT_CHECKOUT_TERMS.text.trim();
  return {
    version: PRODUCT_CHECKOUT_TERMS.version,
    text,
    textHash: createHash("sha256").update(text, "utf8").digest("hex"),
  };
}
