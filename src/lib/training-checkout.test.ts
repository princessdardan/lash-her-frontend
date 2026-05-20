import assert from "node:assert";
import { describe, it } from "node:test";
import type { TTrainingProgram } from "@/types";
import {
  buildTrainingConfirmationUrl,
  getTrainingCta,
  isTrainingPurchasable,
  TRAINING_CHECKOUT_TAX_RATE,
  TRAINING_PAID_BOOKING_TYPE,
  TRAINING_SCHEDULING_LINK_TTL_DAYS,
  validateTrainingCheckoutRequest,
  type TrainingCheckoutRequest,
} from "./training-checkout";

function buildProgram(overrides: Partial<TTrainingProgram> = {}): TTrainingProgram {
  return {
    _id: "program-classic-lash-training",
    title: "Classic Lash Training",
    description: "A focused classic lash training program.",
    slug: "classic-lash-training",
    checkoutEnabled: true,
    price: 1200,
    currency: "CAD",
    isAvailable: true,
    blocks: [],
    ...overrides,
  };
}

function buildRequest(overrides: Partial<TrainingCheckoutRequest> = {}): TrainingCheckoutRequest {
  return {
    programSlug: "classic-lash-training",
    customerName: "  Nataliea Tester  ",
    customerEmail: "  NATALIEA@EXAMPLE.COM  ",
    ...overrides,
  };
}

function assertRejected(request: unknown, program: TTrainingProgram | null, code: string): void {
  const result = validateTrainingCheckoutRequest(program, request);
  assert.strictEqual(result.ok, false);
  if (!result.ok) {
    assert.strictEqual(result.code, code);
  }
}

describe("training-checkout", () => {
  describe("isTrainingPurchasable", () => {
    it("returns false if program is null", () => {
      assert.strictEqual(isTrainingPurchasable(null), false);
    });

    it("returns false if checkoutEnabled is false", () => {
      assert.strictEqual(isTrainingPurchasable(buildProgram({ checkoutEnabled: false })), false);
    });

    it("returns false if native price is missing", () => {
      assert.strictEqual(isTrainingPurchasable(buildProgram({ price: undefined })), false);
    });

    it("returns true when native commerce fields are valid without a legacy checkoutProduct", () => {
      assert.strictEqual(
        isTrainingPurchasable(
          buildProgram({
            checkoutProduct: undefined,
            price: 1200,
            currency: "CAD",
            isAvailable: true,
          }),
        ),
        true,
      );
    });

    it("returns false if native availability is false", () => {
      assert.strictEqual(isTrainingPurchasable(buildProgram({ isAvailable: false })), false);
    });

    it("returns false if native currency is missing", () => {
      assert.strictEqual(isTrainingPurchasable(buildProgram({ currency: undefined })), false);
    });

    it("returns false if native price is invalid or zero", () => {
      assert.strictEqual(isTrainingPurchasable(buildProgram({ price: -10 })), false);
      assert.strictEqual(isTrainingPurchasable(buildProgram({ price: 0 })), false);
    });

    it("returns true if checkoutEnabled is true and product is valid", () => {
      assert.strictEqual(isTrainingPurchasable(buildProgram()), true);
    });
  });

  describe("getTrainingCta", () => {
    it("returns default fallback if program is null", () => {
      assert.deepStrictEqual(getTrainingCta(null), {
        label: "Book a Call",
        href: "/booking?type=training-call",
      });
    });

    it("returns checkout CTA if purchasable", () => {
      assert.deepStrictEqual(getTrainingCta(buildProgram({ checkoutCtaLabel: "Buy Now" })), {
        label: "Buy Now",
        href: "/training-programs/classic-lash-training/checkout",
      });
    });

    it("returns default checkout CTA label if purchasable but label is missing", () => {
      assert.deepStrictEqual(getTrainingCta(buildProgram()), {
        label: "Enroll Now",
        href: "/training-programs/classic-lash-training/checkout",
      });
    });

    it("returns disabled booking CTA if not purchasable and configured", () => {
      assert.deepStrictEqual(
        getTrainingCta(
          buildProgram({
            checkoutEnabled: false,
            checkoutDisabledBookingCta: {
              label: "Custom Book",
              href: "/booking?type=custom",
            },
          }),
        ),
        {
          label: "Custom Book",
          href: "/booking?type=custom",
        },
      );
    });

    it("returns default fallback if configured booking CTA is unsafe", () => {
      assert.deepStrictEqual(
        getTrainingCta(
          buildProgram({
            checkoutEnabled: false,
            checkoutDisabledBookingCta: {
              label: "Unsafe Book",
              href: "javascript:alert(1)",
            },
          }),
        ),
        {
          label: "Book a Call",
          href: "/booking?type=training-call",
        },
      );
    });

    it("returns default fallback if not purchasable and no fallback CTAs exist", () => {
      assert.deepStrictEqual(getTrainingCta(buildProgram({ checkoutEnabled: false })), {
        label: "Book a Call",
        href: "/booking?type=training-call",
      });
    });
  });

  describe("validateTrainingCheckoutRequest", () => {
    it("builds a valid quote with authoritative snapshots", () => {
      const result = validateTrainingCheckoutRequest(buildProgram(), buildRequest());

      assert.strictEqual(result.ok, true);
      if (result.ok) {
        assert.deepStrictEqual(result.quote, {
          programId: "program-classic-lash-training",
          programSlug: "classic-lash-training",
          programTitle: "Classic Lash Training",
          productId: "program-classic-lash-training",
          productTitle: "Classic Lash Training",
          productSku: "program-classic-lash-training",
          currency: "CAD",
          subtotal: 1200,
          tax: 156,
          total: 1356,
          customerName: "Nataliea Tester",
          customerEmail: "nataliea@example.com",
          schedulingTtlDays: TRAINING_SCHEDULING_LINK_TTL_DAYS,
          paidBookingType: TRAINING_PAID_BOOKING_TYPE,
        });
      }
    });

    it("computes Ontario HST at 13%", () => {
      const result = validateTrainingCheckoutRequest(
        buildProgram({ price: 999.99 }),
        buildRequest(),
      );

      assert.strictEqual(TRAINING_CHECKOUT_TAX_RATE, 0.13);
      assert.strictEqual(result.ok, true);
      if (result.ok) {
        assert.strictEqual(result.quote.subtotal, 999.99);
        assert.strictEqual(result.quote.tax, 130);
        assert.strictEqual(result.quote.total, 1129.99);
      }
    });

    it("uses native training commerce fields even if a legacy checkoutProduct is present", () => {
      const program = buildProgram({
        price: 1500,
        currency: "CAD",
        isAvailable: true,
        checkoutProduct: {
          _id: "legacy-training-product",
          title: "Legacy Training Product",
          slug: "legacy-training-product",
          sku: "LEGACY-TRAINING",
          kind: "training",
          price: 1200,
          currency: "CAD",
          isAvailable: true,
        },
      });

      const result = validateTrainingCheckoutRequest(program, buildRequest({ clientPrice: 1500 }));

      assert.strictEqual(result.ok, true);
      if (result.ok) {
        assert.strictEqual(result.quote.productId, "program-classic-lash-training");
        assert.strictEqual(result.quote.productSku, "program-classic-lash-training");
        assert.strictEqual(result.quote.subtotal, 1500);
      }
    });

    it("does not fall back to the legacy checkoutProduct when native commerce fields are incomplete", () => {
      const program = buildProgram({
        price: undefined,
        checkoutProduct: {
          _id: "legacy-training-product",
          title: "Legacy Training Product",
          slug: "legacy-training-product",
          sku: "LEGACY-TRAINING",
          kind: "training",
          price: 1200,
          currency: "CAD",
          isAvailable: true,
        },
      });

      const result = validateTrainingCheckoutRequest(program, buildRequest({ clientPrice: 1200 }));

      assert.strictEqual(result.ok, false);
      if (!result.ok) assert.strictEqual(result.code, "checkout_unavailable");
    });

    it("uses a 14-day scheduling TTL and training-call paid booking type", () => {
      const result = validateTrainingCheckoutRequest(buildProgram(), buildRequest());

      assert.strictEqual(TRAINING_SCHEDULING_LINK_TTL_DAYS, 14);
      assert.strictEqual(TRAINING_PAID_BOOKING_TYPE, "training-call");
      assert.strictEqual(result.ok, true);
      if (result.ok) {
        assert.strictEqual(result.quote.schedulingTtlDays, 14);
        assert.strictEqual(result.quote.paidBookingType, "training-call");
      }
    });

    it("rejects a missing program", () => {
      assertRejected(buildRequest(), null, "missing_program");
    });

    it("rejects disabled checkout", () => {
      assertRejected(buildRequest(), buildProgram({ checkoutEnabled: false }), "checkout_unavailable");
    });

    it("rejects incomplete native commerce fields", () => {
      assertRejected(buildRequest(), buildProgram({ price: undefined }), "checkout_unavailable");
    });

    it("rejects unavailable programs", () => {
      assertRejected(buildRequest(), buildProgram({ isAvailable: false }), "product_unavailable");
    });

    it("rejects non-CAD currency", () => {
      const program = buildProgram();
      Object.defineProperty(program, "currency", { value: "USD" });

      assertRejected(buildRequest(), program, "invalid_currency");
    });

    it("rejects invalid prices", () => {
      assertRejected(buildRequest(), buildProgram({ price: 0 }), "invalid_price");
    });

    it("rejects blank customer names", () => {
      assertRejected(buildRequest({ customerName: "   " }), buildProgram(), "invalid_customer_name");
    });

    it("rejects missing, non-string, and non-object customer names", () => {
      assertRejected({ customerEmail: "student@example.com" }, buildProgram(), "invalid_customer_name");
      assertRejected({ ...buildRequest(), customerName: 123 }, buildProgram(), "invalid_customer_name");
      assertRejected(null, buildProgram(), "invalid_customer_name");
    });

    it("rejects blank and malformed customer emails", () => {
      assertRejected(buildRequest({ customerEmail: "   " }), buildProgram(), "invalid_customer_email");
      assertRejected(buildRequest({ customerEmail: "student.example.com" }), buildProgram(), "invalid_customer_email");
      assertRejected(buildRequest({ customerEmail: "student@" }), buildProgram(), "invalid_customer_email");
    });

    it("rejects missing and non-string customer emails", () => {
      assertRejected({ customerName: "Student" }, buildProgram(), "invalid_customer_email");
      assertRejected({ ...buildRequest(), customerEmail: ["student@example.com"] }, buildProgram(), "invalid_customer_email");
    });

    it("rejects stale client prices", () => {
      assertRejected(buildRequest({ clientPrice: 1100 }), buildProgram(), "stale_client_price");
      assertRejected({ ...buildRequest(), clientPrice: Number.NaN }, buildProgram(), "stale_client_price");
      assertRejected({ ...buildRequest(), clientPrice: "1200" }, buildProgram(), "stale_client_price");
    });

    it("rejects quantity and multi-item cart-like inputs", () => {
      const quantityRequest: TrainingCheckoutRequest & { quantity: number } = { ...buildRequest(), quantity: 2 };
      const itemsRequest: TrainingCheckoutRequest & { items: Array<{ productId: string; quantity: number }> } = {
        ...buildRequest(),
        items: [{ productId: "product-training-classic", quantity: 1 }],
      };

      assertRejected(quantityRequest, buildProgram(), "cart_input_not_supported");
      assertRejected(itemsRequest, buildProgram(), "cart_input_not_supported");
    });

    it("rejects discounts and promo codes", () => {
      const discountRequest: TrainingCheckoutRequest & { discountCode: string } = { ...buildRequest(), discountCode: "SAVE10" };
      const promoRequest: TrainingCheckoutRequest & { promoCode: string } = { ...buildRequest(), promoCode: "SAVE10" };

      assertRejected(discountRequest, buildProgram(), "discounts_not_supported");
      assertRejected(promoRequest, buildProgram(), "discounts_not_supported");
    });

    it("normalizes customer email for strict scheduling match", () => {
      const result = validateTrainingCheckoutRequest(
        buildProgram(),
        buildRequest({ customerEmail: "  Student+Training@Example.COM  " }),
      );

      assert.strictEqual(result.ok, true);
      if (result.ok) {
        assert.strictEqual(result.quote.customerEmail, "student+training@example.com");
      }
    });
  });

  describe("buildTrainingConfirmationUrl", () => {
    it("builds a client-safe scheduling confirmation URL", () => {
      assert.strictEqual(
        buildTrainingConfirmationUrl({
          orderId: "lh-order 123",
          programSlug: "classic-lash-training",
        }),
        "/training-programs/classic-lash-training/confirmation?order=lh-order+123",
      );
    });
  });
});
