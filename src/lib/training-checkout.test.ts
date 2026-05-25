import assert from "node:assert";
import { describe, it } from "node:test";
import type { TTrainingProgram } from "@/types";
import {
  buildTrainingConfirmationUrl,
  buildTrainingScheduleUrl,
  buildServiceBookingConfirmationResolverUrl,
  buildServiceBookingConfirmationUrl,
  buildServiceBookingUrl,
  getTrainingCta,
  isTrainingPurchasable,
  TRAINING_CHECKOUT_TAX_RATE,
  TRAINING_SCHEDULING_LINK_TTL_DAYS,
  validateTrainingCheckoutRequest,
  type TrainingCheckoutRequest,
} from "./training-checkout";

type TrainingProgramFixture = TTrainingProgram;

function buildProgram(overrides: Partial<TrainingProgramFixture> = {}): TrainingProgramFixture {
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

    it("returns true when native commerce fields are valid", () => {
      assert.strictEqual(
        isTrainingPurchasable(
          buildProgram({ price: 1200, currency: "CAD", isAvailable: true }),
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
        href: "#contact",
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
          href: "#contact",
        },
      );
    });

    it("returns default fallback if not purchasable and no fallback CTAs exist", () => {
      assert.deepStrictEqual(getTrainingCta(buildProgram({ checkoutEnabled: false })), {
        label: "Book a Call",
        href: "#contact",
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
          manualDiscount: 0,
          subtotal: 1200,
          promotionDiscount: 0,
          tax: 156,
          total: 1356,
          customerName: "Nataliea Tester",
          customerEmail: "nataliea@example.com",
          schedulingTtlDays: TRAINING_SCHEDULING_LINK_TTL_DAYS,
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

    it("uses native training commerce fields", () => {
      const program = buildProgram({
        price: 1500,
        currency: "CAD",
        isAvailable: true,
      });

      const result = validateTrainingCheckoutRequest(program, buildRequest({ clientPrice: 1500 }));

      assert.strictEqual(result.ok, true);
      if (result.ok) {
        assert.strictEqual(result.quote.productId, "program-classic-lash-training");
        assert.strictEqual(result.quote.productSku, "program-classic-lash-training");
        assert.strictEqual(result.quote.subtotal, 1500);
      }
    });

    it("rejects incomplete native commerce fields", () => {
      const program = buildProgram({ price: undefined });

      const result = validateTrainingCheckoutRequest(program, buildRequest({ clientPrice: 1200 }));

      assert.strictEqual(result.ok, false);
      if (!result.ok) assert.strictEqual(result.code, "checkout_unavailable");
    });

    it("uses a 14-day scheduling TTL for dedicated training scheduling links", () => {
      const result = validateTrainingCheckoutRequest(buildProgram(), buildRequest());

      assert.strictEqual(TRAINING_SCHEDULING_LINK_TTL_DAYS, 14);
      assert.strictEqual(result.ok, true);
      if (result.ok) {
        assert.strictEqual(result.quote.schedulingTtlDays, 14);
        assert.equal("paidBookingType" in result.quote, false);
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

    it("applies manual training discounts before tax", () => {
      const result = validateTrainingCheckoutRequest(
        buildProgram({ price: 1200, discountPrice: 1000 }),
        buildRequest({ clientPrice: 1000 }),
      );

      assert.strictEqual(result.ok, true);
      if (result.ok) {
        assert.strictEqual(result.quote.originalSubtotal, 1200);
        assert.strictEqual(result.quote.manualDiscount, 200);
        assert.strictEqual(result.quote.subtotal, 1000);
        assert.strictEqual(result.quote.tax, 130);
        assert.strictEqual(result.quote.total, 1130);
      }
    });

    it("applies eligible promotion codes after manual discounts", () => {
      const result = validateTrainingCheckoutRequest(
        buildProgram({ price: 1200, discountPrice: 1000 }),
        buildRequest({ clientPrice: 1000, promotionCode: "SAVE10" }),
        {
          _id: "promo-save10",
          code: "SAVE10",
          isEnabled: true,
          discountType: "percentage",
          amount: 10,
          appliesTo: "trainingPrograms",
        },
      );

      assert.strictEqual(result.ok, true);
      if (result.ok) {
        assert.strictEqual(result.quote.originalSubtotal, 1200);
        assert.strictEqual(result.quote.manualDiscount, 200);
        assert.strictEqual(result.quote.promotionCode, "SAVE10");
        assert.strictEqual(result.quote.promotionDiscount, 100);
        assert.strictEqual(result.quote.subtotal, 900);
        assert.strictEqual(result.quote.tax, 117);
        assert.strictEqual(result.quote.total, 1017);
      }
    });

    it("rejects invalid promotion codes", () => {
      const discountRequest: TrainingCheckoutRequest & { discountCode: string } = { ...buildRequest(), discountCode: "SAVE10" };
      const promoRequest: TrainingCheckoutRequest & { promotionCode: string } = { ...buildRequest(), promotionCode: "SAVE10" };

      assertRejected(discountRequest, buildProgram(), "invalid_promotion_code");
      assertRejected(promoRequest, buildProgram(), "invalid_promotion_code");
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

    it("encodes the program slug and order query value", () => {
      assert.strictEqual(
        buildTrainingConfirmationUrl({
          orderId: "lh/order?123",
          programSlug: "classic lash/training",
        }),
        "/training-programs/classic%20lash%2Ftraining/confirmation?order=lh%2Forder%3F123",
      );
    });
  });

  describe("buildTrainingScheduleUrl", () => {
    it("builds a token-only schedule URL", () => {
      const url = buildTrainingScheduleUrl({
        programSlug: "classic-lash-training",
        schedulingToken: "token-123",
      });

      assert.strictEqual(url, "/training-programs/classic-lash-training/schedule?token=token-123");
      assert.strictEqual(url.includes("order="), false);
      assert.strictEqual(url.includes("email="), false);
      assert.strictEqual(url.includes("phone="), false);
      assert.strictEqual(url.includes("name="), false);
    });

    it("encodes the program slug and scheduling token", () => {
      assert.strictEqual(
        buildTrainingScheduleUrl({
          programSlug: "classic lash/training",
          schedulingToken: "token +/=?",
        }),
        "/training-programs/classic%20lash%2Ftraining/schedule?token=token+%2B%2F%3D%3F",
      );
    });
  });

  describe("service booking url helpers", () => {
    it("builds an internal service booking URL", () => {
      assert.strictEqual(buildServiceBookingUrl({ serviceSlug: "lash-fill" }), "/services/lash-fill/booking");
    });

    it("encodes reserved characters in the service booking URL", () => {
      assert.strictEqual(
        buildServiceBookingUrl({ serviceSlug: "lash fill/express?" }),
        "/services/lash%20fill%2Fexpress%3F/booking",
      );
    });

    it("builds a service booking confirmation URL without personal data", () => {
      const url = buildServiceBookingConfirmationUrl({
        serviceSlug: "lash-fill",
        orderId: "lh-order-123",
      });

      assert.strictEqual(url, "/services/lash-fill/booking/confirmation?order=lh-order-123");
      assert.strictEqual(url.includes("email="), false);
      assert.strictEqual(url.includes("phone="), false);
      assert.strictEqual(url.includes("name="), false);
    });

    it("encodes reserved characters in the service booking confirmation URL", () => {
      assert.strictEqual(
        buildServiceBookingConfirmationUrl({
          serviceSlug: "lash fill/express?",
          orderId: "lh/order 123?",
        }),
        "/services/lash%20fill%2Fexpress%3F/booking/confirmation?order=lh%2Forder+123%3F",
      );
    });

    it("builds the service booking confirmation resolver URL without personal data", () => {
      const url = buildServiceBookingConfirmationResolverUrl({ orderId: "lh-order-123" });

      assert.strictEqual(url, "/services/booking/confirmation?order=lh-order-123");
      assert.strictEqual(url.includes("email="), false);
      assert.strictEqual(url.includes("phone="), false);
      assert.strictEqual(url.includes("name="), false);
    });

    it("encodes reserved characters in the service booking confirmation resolver URL", () => {
      assert.strictEqual(
        buildServiceBookingConfirmationResolverUrl({ orderId: "lh/order 123?" }),
        "/services/booking/confirmation?order=lh%2Forder+123%3F",
      );
    });
  });
});
