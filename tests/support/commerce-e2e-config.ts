import { PRODUCT_MANUAL_CANCELLATION_POLICY } from "@/lib/shipping/product-shipping-config";
import { getProductCheckoutTermsRequirement } from "@/lib/commerce/product-checkout-terms";
import { getShippedRefundPolicyRequirement } from "@/lib/commerce/product-shipped-refund-policy";

// Derived from the config so the fixture cannot drift from the policy text the
// checkout re-validates (version + SHA-256 of text). The policy may be null
// (manual checkout disabled); the E2E suite enables it, so the sentinel only
// guards the type.
export const COMMERCE_E2E_MANUAL_POLICY_TEXT =
  PRODUCT_MANUAL_CANCELLATION_POLICY?.text ?? "";

// Terms-of-sale assent required on every product checkout (Reg. 17/05).
// Derived from the source-controlled requirement so version + text hash always
// match what the checkout re-validates. Spread into each checkout POST body.
const COMMERCE_E2E_TERMS = getProductCheckoutTermsRequirement();
export const COMMERCE_E2E_TERMS_DISCLOSURE = {
  termsAccepted: true as const,
  termsVersion: COMMERCE_E2E_TERMS.version,
  termsTextHash: COMMERCE_E2E_TERMS.textHash,
};

// Shipped-order refund/cancellation policy assent required on every automated
// (shipped) product checkout. Derived from the source-controlled requirement so
// version + text hash always match what the checkout re-validates. Spread into
// automated_shipping checkout POST bodies (manual pickup uses the manual policy).
const COMMERCE_E2E_SHIPPED_REFUND = getShippedRefundPolicyRequirement();
export const COMMERCE_E2E_SHIPPED_REFUND_DISCLOSURE = {
  cancellationPolicyAccepted: true as const,
  cancellationPolicyVersion: COMMERCE_E2E_SHIPPED_REFUND.version,
  cancellationPolicyTextHash: COMMERCE_E2E_SHIPPED_REFUND.textHash,
};
