import assert from "node:assert";
import { describe, it } from "node:test";
import type { TTrainingProgram } from "@/types";
import {
  buildTrainingConfirmationUrl,
  getTrainingCta,
  getTrainingCheckoutProduct,
  isTrainingPurchasable,
  TRAINING_CHECKOUT_TAX_RATE,
  TRAINING_PAID_BOOKING_TYPE,
  TRAINING_SCHEDULING_LINK_TTL_DAYS,
  validateTrainingCheckoutRequest,
  type TrainingCheckoutRequest,
} from "./training-checkout";

type TrainingCheckoutProduct = NonNullable<TTrainingProgram["checkoutProduct"]>;

function buildTrainingProduct(overrides: Partial<TrainingCheckoutProduct> = {}): TrainingCheckoutProduct {
  return {
    _id: "product-training-classic",
    title: "Classic Lash Training",
    slug: "classic-lash-training-product",
    sku: "TRAINING-CLASSIC",
    kind: "training",
    price: 1200,
    currency: "CAD",
    isAvailable: true,
    ...overrides,
  };
}

function buildProgram(overrides: Partial<TTrainingProgram> = {}): TTrainingProgram {
  return {
    _id: "program-classic-lash-training",
    title: "Classic Lash Training",
    description: "A focused classic lash training program.",
    slug: "classic-lash-training",
    checkoutEnabled: true,
    checkoutProduct: buildTrainingProduct(),
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

    it("returns false if checkoutProduct is missing", () => {
      assert.strictEqual(isTrainingPurchasable(buildProgram({ checkoutProduct: undefined })), false);
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

    it("returns false if checkoutProduct kind is not training", () => {
      assert.strictEqual(isTrainingPurchasable(buildProgram({ checkoutProduct: buildTrainingProduct({ kind: "product" }) })), false);
    });

    it("returns false if checkoutProduct is unavailable", () => {
      assert.strictEqual(isTrainingPurchasable(buildProgram({ checkoutProduct: buildTrainingProduct({ isAvailable: false }) })), false);
    });

    it("returns false if checkoutProduct currency is not CAD", () => {
      assert.strictEqual(isTrainingPurchasable(buildProgram({ checkoutProduct: buildTrainingProduct({ currency: "USD" }) })), false);
    });

    it("returns false if checkoutProduct price is invalid or zero", () => {
      assert.strictEqual(isTrainingPurchasable(buildProgram({ checkoutProduct: buildTrainingProduct({ price: -10 }) })), false);
      assert.strictEqual(isTrainingPurchasable(buildProgram({ checkoutProduct: buildTrainingProduct({ price: 0 }) })), false);
    });

    it("returns false if checkoutProduct has variants", () => {
      assert.strictEqual(
        isTrainingPurchasable(
          buildProgram({
            checkoutProduct: buildTrainingProduct({
              variants: [{ _key: "1", title: "V1", sku: "V1", price: 100, isAvailable: true }],
            }),
          }),
        ),
        false,
      );
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
          productId: "product-training-classic",
          productTitle: "Classic Lash Training",
          productSku: "TRAINING-CLASSIC",
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
        buildProgram({ checkoutProduct: buildTrainingProduct({ price: 999.99 }) }),
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

    it("uses native training commerce fields before the legacy checkoutProduct fallback", () => {
      const program = buildProgram({
        price: 1500,
        currency: "CAD",
        isAvailable: true,
        checkoutProduct: buildTrainingProduct({ price: 1200, sku: "LEGACY-TRAINING" }),
      });

      const result = validateTrainingCheckoutRequest(program, buildRequest({ clientPrice: 1500 }));

      assert.strictEqual(result.ok, true);
      assert.deepStrictEqual(getTrainingCheckoutProduct(program), {
        id: "program-classic-lash-training",
        title: "Classic Lash Training",
        sku: "program-classic-lash-training",
        price: 1500,
        currency: "CAD",
        isAvailable: true,
        source: "native",
      });
      if (result.ok) {
        assert.strictEqual(result.quote.productId, "program-classic-lash-training");
        assert.strictEqual(result.quote.productSku, "program-classic-lash-training");
        assert.strictEqual(result.quote.subtotal, 1500);
      }
    });

    it("falls back to the legacy checkoutProduct when native commerce fields are incomplete", () => {
      const program = buildProgram({
        price: 1500,
        checkoutProduct: buildTrainingProduct({ price: 1200, sku: "LEGACY-TRAINING" }),
      });

      const result = validateTrainingCheckoutRequest(program, buildRequest({ clientPrice: 1200 }));

      assert.strictEqual(result.ok, true);
      assert.deepStrictEqual(getTrainingCheckoutProduct(program), {
        id: "product-training-classic",
        title: "Classic Lash Training",
        sku: "LEGACY-TRAINING",
        price: 1200,
        currency: "CAD",
        isAvailable: true,
        source: "legacy",
        legacyProduct: buildTrainingProduct({ price: 1200, sku: "LEGACY-TRAINING" }),
      });
      if (result.ok) {
        assert.strictEqual(result.quote.productId, "product-training-classic");
        assert.strictEqual(result.quote.productSku, "LEGACY-TRAINING");
        assert.strictEqual(result.quote.subtotal, 1200);
      }
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

    it("rejects an unconfigured checkout product", () => {
      assertRejected(buildRequest(), buildProgram({ checkoutProduct: undefined }), "checkout_unavailable");
    });

    it("rejects linked products that are not training", () => {
      assertRejected(
        buildRequest(),
        buildProgram({ checkoutProduct: buildTrainingProduct({ kind: "product" }) }),
        "invalid_product_kind",
      );
    });

    it("rejects unavailable products", () => {
      assertRejected(
        buildRequest(),
        buildProgram({ checkoutProduct: buildTrainingProduct({ isAvailable: false }) }),
        "product_unavailable",
      );
    });

    it("rejects non-CAD currency", () => {
      assertRejected(
        buildRequest(),
        buildProgram({ checkoutProduct: buildTrainingProduct({ currency: "USD" }) }),
        "invalid_currency",
      );
    });

    it("rejects invalid prices", () => {
      assertRejected(
        buildRequest(),
        buildProgram({ checkoutProduct: buildTrainingProduct({ price: 0 }) }),
        "invalid_price",
      );
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

    it("rejects variants and options", () => {
      const productWithOptions: TrainingCheckoutProduct & { options: string[] } = {
        ...buildTrainingProduct(),
        options: ["kit"],
      };

      assertRejected(
        buildRequest(),
        buildProgram({
          checkoutProduct: buildTrainingProduct({
            variants: [{ _key: "volume", title: "Volume", sku: "VOL", price: 1400, isAvailable: true }],
          }),
        }),
        "variants_not_supported",
      );

      assertRejected(
        buildRequest(),
        buildProgram({ checkoutProduct: productWithOptions }),
        "variants_not_supported",
      );
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
