import { randomUUID } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { log } from "@/lib/logging/logger";
import {
  buildValidatedCart,
  type CartInputItem,
  type ValidatedCart,
} from "@/lib/commerce/cart";
import { toCheckoutCatalogProduct } from "@/lib/commerce/product-catalog";
import type { UsImportTerms } from "@/lib/commerce/product-checkout-disclosures";
import { loadManualProductCheckoutPolicy } from "@/lib/commerce/product-manual-checkout-config";
import {
  getProductCheckoutTermsRequirement,
  type ProductCheckoutTermsRequirement,
} from "@/lib/commerce/product-checkout-terms";
import {
  getShippedRefundPolicyRequirement,
  type ShippedRefundPolicyRequirement,
} from "@/lib/commerce/product-shipped-refund-policy";
import {
  CHECKOUT_CUSTOMER_NAME_MAX_LENGTH,
  CHECKOUT_SHIPPING_LINE_MAX_LENGTH,
  CHECKOUT_SHIPPING_LOCALITY_MAX_LENGTH,
  CHECKOUT_SHIPPING_POSTAL_CODE_MAX_LENGTH,
  isValidCheckoutEmail,
  parseCheckoutText,
  parseOptionalCheckoutText,
} from "@/lib/commerce/checkout-validation";
import { parsePromotionCodeInput } from "@/lib/commerce/discounts";
import { ShippingQuoteConflictError } from "@/lib/shipping/errors";
import { InsufficientStockError } from "@/lib/commerce/product-stock-store";
import { getTrustedClientIp } from "@/lib/security/trusted-client-ip";
import { readBoundedJsonBody } from "@/lib/security/bounded-json-body";
import type { TProduct, TPromotionCode } from "@/types";

const CHECKOUT_BODY_MAX_BYTES = 64 * 1024;

interface CheckoutCustomerInput {
  name: string;
  email: string;
  phone?: string;
}

interface CheckoutShippingAddressInput {
  line1: string;
  line2?: string;
  city: string;
  province: string;
  postalCode: string;
  country: string;
  countryCode?: "CA" | "US";
  phone?: string;
}

interface CheckoutRequestBody {
  customer: CheckoutCustomerInput;
  items: CartInputItem[];
  shippingAddress?: CheckoutShippingAddressInput;
  fulfillmentMode: "automated_shipping" | "manual_pickup" | "manual_shipping";
  disclosures: {
    cancellationPolicyAccepted?: boolean;
    cancellationPolicyVersion?: string;
    cancellationPolicyTextHash?: string;
    termsAccepted?: boolean;
    termsVersion?: string;
    termsTextHash?: string;
    usImportTerms?: UsImportTerms;
    usImportDisclosureVersion?: string;
    usImportDisclosureText?: string;
  };
  promotionCode?: string;
  shippingQuote?: {
    token: string;
    fingerprint: string;
    rateId: string;
  };
  /**
   * Client-supplied per-attempt idempotency token. When present on a
   * manual-pickup checkout, the reserved order's id is derived from it so a
   * retry of the same attempt reuses the order instead of double-charging.
   */
  reservationKey?: string;
  /**
   * Square Web Payments SDK card nonce. When present (and Square commerce
   * checkout is enabled), the order is reserved and charged synchronously
   * through Square rather than returning the legacy async-invoice operation.
   */
  payment?: {
    sourceId: string;
    verificationToken?: string;
  };
}

type CheckoutResponseBody = { orderId: string; status: "paid" };

interface CheckoutErrorBody {
  error: string;
}

interface CheckoutErrorLog {
  cause?: CheckoutErrorLogCause;
  error: string;
  errorName?: string;
}

interface CheckoutErrorLogCause {
  code?: string;
  column?: string;
  constraint?: string;
  dataType?: string;
  schema?: string;
  severity?: string;
  table?: string;
}

interface CheckoutPostHandlerDependencies {
  getProductsByIds: (ids: string[]) => Promise<TProduct[]>;
  getPromotionCode: (code: string) => Promise<TPromotionCode | null>;
  shippingEnabled?: boolean;
  validateShippingSelection?: (input: {
    request: CheckoutRequestBody;
    products: TProduct[];
    promotionCode: TPromotionCode | null;
  }) => Promise<string | ValidatedShippingSelection>;
  createInitializingOrder?: (input: {
    customerName: string;
    customerEmail: string;
    provider?: "square";
    cart: ValidatedCart;
    shippingAddress: CheckoutShippingAddressInput;
    shippingQuoteToken: string;
    shippingQuoteFingerprint: string;
    shippingRateId: string;
    refundOriginIp: string;
    termsAssent: ProductCheckoutTermsAssent;
    refundPolicy: ProductRefundPolicyAssent;
    usImportDisclosure?: {
      terms: UsImportTerms;
      version: string;
      text: string;
      presentedAt: Date;
    };
  }) => Promise<{
    orderId: string;
    primaryObligationId: string;
    currency: "CAD";
    shippingAmountCents: number;
    totalAmountCents: number;
    shippingRateTitle: string;
  }>;
  createInitializingManualOrder?: (input: {
    customerName: string;
    customerEmail: string;
    customerPhone?: string;
    reservationKey?: string;
    cart: ValidatedCart;
    fulfillmentMode: "manual_pickup";
    cancellationPolicy: {
      accepted: true;
      version: string;
      textHash: string;
      presentedAt: Date;
      requestEvidence: string;
    };
    termsAssent: ProductCheckoutTermsAssent;
    refundOriginIp: string;
  }) => Promise<{
    orderId: string;
    primaryObligationId: string;
    currency: "CAD";
    shippingAmountCents: number;
    totalAmountCents: number;
    shippingRateTitle: string;
  }>;
  markInitializationFailed?: (orderId: string, error: string) => Promise<void>;
  loadManualCheckoutPolicy?: typeof loadManualProductCheckoutPolicy;
  loadTermsRequirement?: () => ProductCheckoutTermsRequirement;
  loadShippedRefundPolicyRequirement?: () => ShippedRefundPolicyRequirement;
  /** When true, a request carrying `payment.sourceId` is charged via Square. */
  squareCommerceEnabled?: boolean;
  chargeSquareProductOrder?: (input: {
    orderReference: string;
    amountCents: number;
    currency: "CAD";
    sourceId: string;
    verificationToken?: string;
  }) => Promise<
    | { ok: true; squarePaymentId: string; transition: string }
    | { ok: false; reason: string }
  >;
  markOrderVerificationFailed?: (orderId: string) => Promise<void>;
  /**
   * Optional abuse guard evaluated before any checkout work. Returns a 429/503
   * Response to short-circuit the request, or null to proceed. Injected so unit
   * tests run without a rate-limit backend.
   */
  enforceRateLimit?: (req: NextRequest) => Promise<Response | null>;
}

interface ProductCheckoutTermsAssent {
  accepted: true;
  version: string;
  textHash: string;
  presentedAt: Date;
  requestEvidence: string;
}

type ProductRefundPolicyAssent = ProductCheckoutTermsAssent;

type CheckoutInitializationStage =
  | "prepare_checkout"
  | "load_checkout_inputs"
  | "reserve_order";

interface ValidatedShippingSelection {
  fingerprint: string;
  usImportTerms?: UsImportTerms;
  usImportDisclosureVersion?: string;
  usImportDisclosureText?: string;
}

export function createCheckoutPostHandler({
  getProductsByIds,
  getPromotionCode,
  shippingEnabled,
  validateShippingSelection,
  createInitializingOrder,
  createInitializingManualOrder,
  markInitializationFailed,
  loadManualCheckoutPolicy = loadManualProductCheckoutPolicy,
  loadTermsRequirement = getProductCheckoutTermsRequirement,
  loadShippedRefundPolicyRequirement = getShippedRefundPolicyRequirement,
  squareCommerceEnabled,
  chargeSquareProductOrder,
  markOrderVerificationFailed: markOrderVerificationFailedDep,
  enforceRateLimit,
}: CheckoutPostHandlerDependencies): (req: NextRequest) => Promise<Response> {
  return async function checkoutPostHandler(
    req: NextRequest,
  ): Promise<Response> {
    let stage: CheckoutInitializationStage = "prepare_checkout";
    let initializingOrderId: string | null = null;

    if (enforceRateLimit) {
      const limited = await enforceRateLimit(req);
      if (limited) return limited;
    }

    const parsedBody = await readBoundedJsonBody(req, CHECKOUT_BODY_MAX_BYTES);
    if (!parsedBody.ok) {
      return parsedBody.reason === "too_large"
        ? NextResponse.json(
            { error: "Checkout request body is too large" },
            { status: 413 },
          )
        : invalidCheckoutRequest();
    }
    const body = parsedBody.value;

    const checkoutRequest = parseCheckoutRequest(body);

    if (checkoutRequest === null) {
      return invalidCheckoutRequest();
    }

    try {
      const productIds = Array.from(
        new Set(checkoutRequest.items.map((item) => item.productId)),
      );
      stage = "load_checkout_inputs";
      const [products, promotionCode] = await Promise.all([
        getProductsByIds(productIds),
        checkoutRequest.promotionCode
          ? getPromotionCode(checkoutRequest.promotionCode)
          : Promise.resolve(null),
      ]);
      stage = "prepare_checkout";
      const catalogProducts = products.map(toCheckoutCatalogProduct);
      const cart = buildValidatedCart(checkoutRequest.items, catalogProducts, {
        promotionCode,
      });

      if (
        checkoutRequest.promotionCode &&
        cart.promotionCode !== checkoutRequest.promotionCode
      ) {
        return invalidPromotionCode();
      }

      const shippingWorkflowConfigured = dependenciesProvideShippingWorkflow({
        validateShippingSelection,
        createInitializingOrder,
      });
      const isManualCheckout = cart.checkoutMode === "manual";
      // Studio pickup is a customer choice, available for any cart. A manual
      // (studio-fulfilled) cart can *only* pick up, so once past the guards below
      // its fulfillment is always pickup; an automated (shippable) cart may pick
      // up as a free alternative to shipping. Downstream fulfillment branching
      // therefore keys off `wantsPickup`, not the cart's product composition.
      const wantsPickup = checkoutRequest.fulfillmentMode === "manual_pickup";
      if (
        isManualCheckout &&
        checkoutRequest.fulfillmentMode === "automated_shipping"
      ) {
        return invalidFulfillmentMode();
      }
      if (
        isManualCheckout &&
        checkoutRequest.fulfillmentMode !== "manual_pickup"
      ) {
        return NextResponse.json<CheckoutErrorBody>(
          {
            error:
              "Manual products start with free studio pickup; optional shipping is arranged after payment",
          },
          { status: 409 },
        );
      }
      if (
        !isManualCheckout &&
        checkoutRequest.fulfillmentMode !== "automated_shipping" &&
        checkoutRequest.fulfillmentMode !== "manual_pickup"
      ) {
        return invalidFulfillmentMode();
      }

      // Pickup (manual carts and automated carts that chose pickup) requires the
      // current studio cancellation-policy assent; the manual policy also gates
      // whether pickup is available at all.
      const manualPolicy = wantsPickup
        ? await loadManualCheckoutPolicy()
        : null;
      if (wantsPickup) {
        if (
          !manualPolicy?.enabled ||
          !manualPolicy.cancellationPolicyVersion ||
          !manualPolicy.cancellationPolicyTextHash ||
          checkoutRequest.disclosures.cancellationPolicyAccepted !== true ||
          checkoutRequest.disclosures.cancellationPolicyVersion !==
            manualPolicy.cancellationPolicyVersion ||
          checkoutRequest.disclosures.cancellationPolicyTextHash !==
            manualPolicy.cancellationPolicyTextHash ||
          !createInitializingManualOrder
        ) {
          return NextResponse.json<CheckoutErrorBody>(
            { error: "Studio pickup checkout is temporarily unavailable" },
            { status: 503 },
          );
        }
        if (checkoutRequest.shippingQuote) return invalidFulfillmentMode();
      }

      if (!wantsPickup && shippingWorkflowConfigured && !shippingEnabled) {
        return NextResponse.json<CheckoutErrorBody>(
          { error: "Product checkout is temporarily unavailable" },
          { status: 503 },
        );
      }
      if (
        !wantsPickup &&
        shippingWorkflowConfigured &&
        (!checkoutRequest.shippingQuote || !checkoutRequest.shippingAddress)
      ) {
        return NextResponse.json<CheckoutErrorBody>(
          { error: "Select a current shipping rate" },
          { status: 409 },
        );
      }
      // Chit Chats requires a recipient phone on the shipment, but the checkout
      // request parses phone as optional. Validate it here — fail fast with a
      // clean 400 — so a shipped order missing a phone can't slip through to the
      // reserve/prepare path and surface as an opaque 500.
      if (
        !wantsPickup &&
        shippingWorkflowConfigured &&
        !checkoutRequest.customer.phone
      ) {
        return NextResponse.json<CheckoutErrorBody>(
          { error: "A phone number is required for shipping" },
          { status: 400 },
        );
      }
      if (!wantsPickup && checkoutRequest.shippingAddress) {
        const isUs =
          getShippingCountryCode(checkoutRequest.shippingAddress) === "US";
        const disclosure = checkoutRequest.disclosures;
        const hasCompleteUsDisclosure = Boolean(
          disclosure.usImportTerms === "DDU" &&
          disclosure.usImportDisclosureVersion?.trim() &&
          disclosure.usImportDisclosureText?.trim(),
        );
        if (
          (isUs && !hasCompleteUsDisclosure) ||
          (!isUs &&
            (disclosure.usImportTerms ||
              disclosure.usImportDisclosureVersion ||
              disclosure.usImportDisclosureText))
        ) {
          return NextResponse.json<CheckoutErrorBody>(
            { error: "Required import-cost disclosure is missing" },
            { status: 409 },
          );
        }
      }

      // Ontario Reg. 17/05 (Internet agreements): the customer must expressly
      // accept the current Terms of sale at checkout, and the accepted version +
      // text hash are recorded on the order for provability. Required for every
      // product checkout path (manual pickup and automated shipping alike).
      const termsRequirement = loadTermsRequirement();
      if (
        checkoutRequest.disclosures.termsAccepted !== true ||
        checkoutRequest.disclosures.termsVersion !== termsRequirement.version ||
        checkoutRequest.disclosures.termsTextHash !== termsRequirement.textHash
      ) {
        return NextResponse.json<CheckoutErrorBody>(
          {
            error:
              "You must accept the current Terms and Conditions to complete checkout",
          },
          { status: 409 },
        );
      }
      const checkoutRequestEvidence = `checkout_post:${randomUUID()}`;
      const termsAssent = {
        accepted: true as const,
        version: termsRequirement.version,
        textHash: termsRequirement.textHash,
        presentedAt: new Date(),
        requestEvidence: checkoutRequestEvidence,
      };

      // Shipped (automated_shipping) orders present a versioned refund/cancellation
      // policy at checkout, the counterpart to the manual-pickup cancellation
      // policy validated above. Both reuse the `cancellationPolicy*` disclosure
      // fields — the policy shown depends on the fulfillment mode — so every
      // product checkout path records a provable, current refund-policy assent.
      let shippedRefundPolicyAssent: ProductRefundPolicyAssent | null = null;
      if (!wantsPickup) {
        const refundPolicyRequirement = loadShippedRefundPolicyRequirement();
        if (
          checkoutRequest.disclosures.cancellationPolicyAccepted !== true ||
          checkoutRequest.disclosures.cancellationPolicyVersion !==
            refundPolicyRequirement.version ||
          checkoutRequest.disclosures.cancellationPolicyTextHash !==
            refundPolicyRequirement.textHash
        ) {
          return NextResponse.json<CheckoutErrorBody>(
            {
              error:
                "You must accept the current refund policy to complete checkout",
            },
            { status: 409 },
          );
        }
        shippedRefundPolicyAssent = {
          accepted: true as const,
          version: refundPolicyRequirement.version,
          textHash: refundPolicyRequirement.textHash,
          presentedAt: new Date(),
          requestEvidence: checkoutRequestEvidence,
        };
      }

      // Square commerce charges synchronously through the Web Payments SDK when
      // the request carries a card nonce — both automated shipping and manual
      // pickup.
      const useSquareCommerce = Boolean(
        squareCommerceEnabled &&
        chargeSquareProductOrder &&
        checkoutRequest.payment?.sourceId,
      );

      // Square is the only gateway: without an enabled charger and a card nonce
      // there is no way to complete payment. Fail *before* reserving any order so
      // a disabled/misconfigured gateway or a missing nonce can never strand held
      // stock or a consumed shipping quote on a reservation that can never be
      // charged (the reserved order would otherwise leak until the abandoned-stock
      // sweep expires it).
      if (!useSquareCommerce) {
        return NextResponse.json<CheckoutErrorBody>(
          { error: "Checkout is temporarily unavailable" },
          { status: 503 },
        );
      }

      let initializingOrder: Awaited<
        ReturnType<NonNullable<typeof createInitializingOrder>>
      > | null = null;
      if (wantsPickup && createInitializingManualOrder) {
        stage = "reserve_order";
        const refundOriginIp = getTrustedClientIp(req.headers);
        if (!refundOriginIp && process.env.VERCEL_ENV === "production") {
          return NextResponse.json<CheckoutErrorBody>(
            { error: "Checkout is temporarily unavailable" },
            { status: 503 },
          );
        }
        const manualOrder = await createInitializingManualOrder({
          customerName: checkoutRequest.customer.name,
          customerEmail: checkoutRequest.customer.email,
          ...(checkoutRequest.customer.phone
            ? { customerPhone: checkoutRequest.customer.phone }
            : {}),
          ...(checkoutRequest.reservationKey
            ? { reservationKey: checkoutRequest.reservationKey }
            : {}),
          cart,
          fulfillmentMode: "manual_pickup",
          cancellationPolicy: {
            accepted: true,
            version: manualPolicy!.cancellationPolicyVersion!,
            textHash: manualPolicy!.cancellationPolicyTextHash!,
            presentedAt: new Date(),
            requestEvidence: checkoutRequestEvidence,
          },
          termsAssent,
          refundOriginIp: refundOriginIp ?? "127.0.0.1",
        });
        initializingOrder = manualOrder;
        initializingOrderId = manualOrder.orderId;
      } else if (
        shippingEnabled &&
        validateShippingSelection &&
        createInitializingOrder &&
        checkoutRequest.shippingQuote
      ) {
        const validatedSelection = normalizeValidatedShippingSelection(
          await validateShippingSelection({
            request: checkoutRequest,
            products,
            promotionCode,
          }),
        );
        const currentFingerprint = validatedSelection.fingerprint;
        if (currentFingerprint !== checkoutRequest.shippingQuote.fingerprint) {
          return NextResponse.json<CheckoutErrorBody>(
            { error: "Shipping quote changed" },
            { status: 409 },
          );
        }
        if (
          getShippingCountryCode(checkoutRequest.shippingAddress!) === "US" &&
          !shippingDisclosureMatchesRequest(
            validatedSelection,
            checkoutRequest.disclosures,
          )
        ) {
          return NextResponse.json<CheckoutErrorBody>(
            { error: "Required import-cost disclosure changed" },
            { status: 409 },
          );
        }
        stage = "reserve_order";
        // Non-manual carts always pass through the refund-policy validation
        // above, so the assent is present here; assert it explicitly rather than
        // relying on a non-local invariant via `!`.
        if (!shippedRefundPolicyAssent) {
          throw new Error("Shipped refund-policy assent was not captured");
        }
        const refundOriginIp = getTrustedClientIp(req.headers);
        if (!refundOriginIp && process.env.VERCEL_ENV === "production") {
          return NextResponse.json<CheckoutErrorBody>(
            { error: "Checkout is temporarily unavailable" },
            { status: 503 },
          );
        }
        initializingOrder = await createInitializingOrder({
          customerName: checkoutRequest.customer.name,
          customerEmail: checkoutRequest.customer.email,
          ...(useSquareCommerce ? { provider: "square" as const } : {}),
          cart,
          shippingAddress: normalizeShippingAddress(
            checkoutRequest.shippingAddress!,
            checkoutRequest.customer.phone,
          ),
          shippingQuoteToken: checkoutRequest.shippingQuote.token,
          shippingQuoteFingerprint: currentFingerprint,
          shippingRateId: checkoutRequest.shippingQuote.rateId,
          refundOriginIp: refundOriginIp ?? "127.0.0.1",
          termsAssent,
          refundPolicy: shippedRefundPolicyAssent,
          ...(validatedSelection.usImportTerms &&
          validatedSelection.usImportDisclosureVersion &&
          validatedSelection.usImportDisclosureText
            ? {
                usImportDisclosure: {
                  terms: validatedSelection.usImportTerms,
                  version: validatedSelection.usImportDisclosureVersion,
                  text: validatedSelection.usImportDisclosureText,
                  presentedAt: new Date(),
                },
              }
            : {}),
        });
        initializingOrderId = initializingOrder.orderId;
      }

      if (initializingOrder) {
        if (!("primaryObligationId" in initializingOrder)) {
          throw new Error("Durable payment operation was not reserved");
        }

        // Square is the only gateway. If the request carried no card nonce (or
        // Square commerce is disabled), checkout is unavailable — there is no
        // fallback gateway.
        if (
          !useSquareCommerce ||
          !chargeSquareProductOrder ||
          !checkoutRequest.payment?.sourceId
        ) {
          if (markOrderVerificationFailedDep) {
            await markOrderVerificationFailedDep(
              initializingOrder.orderId,
            ).catch(() => undefined);
          }
          return NextResponse.json<CheckoutErrorBody>(
            { error: "Checkout is temporarily unavailable" },
            { status: 503 },
          );
        }

        const charge = await chargeSquareProductOrder({
          orderReference: initializingOrder.orderId,
          amountCents: initializingOrder.totalAmountCents,
          currency: initializingOrder.currency,
          sourceId: checkoutRequest.payment.sourceId,
          ...(checkoutRequest.payment.verificationToken
            ? { verificationToken: checkoutRequest.payment.verificationToken }
            : {}),
        });

        if (!charge.ok) {
          // The captured payment did not clear; release the reserved order so
          // the customer sees a clean failure. markOrderVerificationFailed also
          // re-opens the attached shipping quote — reverting it to `quoted` and
          // unbinding it — so a corrected card can retry against the same quote
          // while it is still unexpired (see order-store.markOrderVerificationFailed).
          if (markOrderVerificationFailedDep) {
            await markOrderVerificationFailedDep(
              initializingOrder.orderId,
            ).catch(() => undefined);
          }
          return NextResponse.json<CheckoutErrorBody>(
            { error: "Payment could not be completed" },
            { status: 402 },
          );
        }

        return NextResponse.json<CheckoutResponseBody>(
          { orderId: initializingOrder.orderId, status: "paid" },
          { status: 200 },
        );
      }

      return NextResponse.json<CheckoutErrorBody>(
        { error: "Durable product payment initialization is unavailable" },
        { status: 503 },
      );
    } catch (error) {
      if (initializingOrderId) {
        // Release any inventory/quote held by the reserved order. Two separate
        // columns matter: markInitializationFailed only unwinds orders whose
        // `initializationStatus` is "initializing", but Square orders are reserved
        // with `initializationStatus: "ready"`, so it is a no-op for them.
        // markOrderVerificationFailed keys off the lifecycle `status` ("pending"
        // on reservation) and is what actually returns their held stock. Call both
        // so either reservation shape is unwound rather than leaking until the
        // abandoned-stock sweep.
        if (markOrderVerificationFailedDep) {
          await markOrderVerificationFailedDep(initializingOrderId).catch(
            () => undefined,
          );
        }
        if (markInitializationFailed) {
          await markInitializationFailed(
            initializingOrderId,
            error instanceof Error
              ? error.message
              : "Unknown initialization error",
          ).catch(() => undefined);
        }
      }
      log("error", "[checkout] Unable to initialize checkout", {
        stage,
        ...summarizeCheckoutError(error),
      });

      const stockConflict = error instanceof InsufficientStockError;
      const quoteConflict = error instanceof ShippingQuoteConflictError;
      return NextResponse.json<CheckoutErrorBody>(
        {
          error: stockConflict
            ? "One or more items are no longer in stock. Please review your cart and try again."
            : quoteConflict
              ? error.message
              : "Unable to start checkout",
        },
        {
          status:
            stockConflict || quoteConflict
              ? 409
              : getCheckoutFailureStatus(stage),
        },
      );
    }
  };
}

export async function POST(req: NextRequest): Promise<Response> {
  const [
    { loaders },
    orderStore,
    shippingConfig,
    privateCheckout,
    squareCommerce,
  ] = await Promise.all([
    import("@/data/loaders"),
    import("@/lib/commerce/order-store"),
    import("@/lib/shipping/config"),
    import("@/lib/env/private-checkout"),
    import("@/lib/commerce/square-commerce-checkout"),
  ]);

  const squareCommerceEnabled =
    privateCheckout.isSquareCommerceCheckoutEnabled();

  return createCheckoutPostHandler({
    getProductsByIds: loaders.getProductsByIds,
    enforceRateLimit: async (request) => {
      const [{ buildBookingAbuseKey }, { checkProductCheckoutRateLimit }] =
        await Promise.all([
          import("@/lib/security/trusted-client-ip"),
          import("@/lib/security/checkout-abuse-control"),
        ]);
      const key = buildBookingAbuseKey({
        headers: request.headers,
        scope: "product-checkout",
        subject: "all",
      });
      if (!key) {
        return NextResponse.json<CheckoutErrorBody>(
          { error: "Checkout is temporarily unavailable" },
          { status: 503 },
        );
      }
      try {
        const decision = await checkProductCheckoutRateLimit({
          key,
          now: new Date(),
        });
        if (!decision.allowed) {
          return NextResponse.json<CheckoutErrorBody>(
            {
              error:
                "Too many checkout attempts. Please wait a moment and try again.",
            },
            {
              status: 429,
              headers: { "Retry-After": String(decision.retryAfterSeconds) },
            },
          );
        }
      } catch {
        return NextResponse.json<CheckoutErrorBody>(
          { error: "Checkout is temporarily unavailable" },
          { status: 503 },
        );
      }
      return null;
    },
    squareCommerceEnabled,
    ...(squareCommerceEnabled
      ? {
          chargeSquareProductOrder:
            squareCommerce.createLiveSquareProductCharger(),
          markOrderVerificationFailed: orderStore.markOrderVerificationFailed,
        }
      : {}),
    getPromotionCode: loaders.getPromotionCode,
    shippingEnabled: shippingConfig.isChitChatsCheckoutEnabled(),
    validateShippingSelection: async ({ request, products, promotionCode }) => {
      const [
        { listEnabledPackageProfiles },
        { prepareShippingQuote },
        { getChitChatsConfig },
        { assertCheckoutReadiness },
        { bindShippingFingerprintToContext },
      ] = await Promise.all([
        import("@/lib/shipping/shipment-store"),
        import("@/lib/shipping/prepare-quote"),
        import("@/lib/shipping/config"),
        import("@/lib/shipping/readiness"),
        import("@/lib/shipping/quote-token"),
      ]);
      // Backstop for the fail-fast phone check above: a typed error keeps a
      // missing phone from surfacing as an opaque 500 if this path is ever
      // reached without one.
      if (!request.customer.phone)
        throw new ShippingQuoteConflictError(
          "Customer phone is required for shipping",
        );
      if (!request.shippingAddress) {
        throw new ShippingQuoteConflictError("Shipping address is required");
      }
      const countryCode = getShippingCountryCode(request.shippingAddress);
      const readiness = await assertCheckoutReadiness({
        destinationCountryCode: countryCode,
      }).catch(() => {
        throw new ShippingQuoteConflictError(
          "Shipping checkout is not operationally ready",
        );
      });
      if (!readiness.quoteContext) {
        throw new ShippingQuoteConflictError(
          "Shipping quote context is unavailable",
        );
      }
      const contract = readiness.quoteContext.usShippingContract;
      if (countryCode === "US" && contract?.importTerms !== "DDU") {
        throw new ShippingQuoteConflictError(
          "Certified U.S. DDU shipping terms are unavailable",
        );
      }
      const usImportDisclosure =
        countryCode === "US" && contract
          ? {
              usImportTerms: "DDU" as const,
              usImportDisclosureVersion: contract.disclosure.version,
              usImportDisclosureText: contract.disclosure.text,
            }
          : undefined;
      const preparedAt = new Date();
      const prepared = prepareShippingQuote({
        items: request.items,
        products,
        promotionCode,
        profiles: await listEnabledPackageProfiles(),
        usShippingEnabled: getChitChatsConfig().usShippingEnabled,
        now: preparedAt,
        ...(contract ? { usShippingContract: contract } : {}),
        recipient: {
          ...request.shippingAddress,
          province: normalizeProvinceCode(request.shippingAddress.province),
          postalCode: request.shippingAddress.postalCode.toUpperCase(),
          countryCode,
          name: request.customer.name,
          email: request.customer.email,
          phone: request.customer.phone,
        },
        ...(usImportDisclosure ? { usImportDisclosure } : {}),
      });
      return {
        fingerprint: bindShippingFingerprintToContext(
          prepared.fingerprint,
          readiness.quoteContext,
        ),
        ...(usImportDisclosure ?? {}),
      };
    },
    createInitializingOrder: orderStore.createInitializingProductOrder,
    createInitializingManualOrder:
      orderStore.createInitializingManualProductOrder,
    markInitializationFailed: orderStore.markProductOrderInitializationFailed,
  })(req);
}

function parseCheckoutRequest(body: unknown): CheckoutRequestBody | null {
  if (
    !isRecord(body) ||
    !isRecord(body.customer) ||
    !Array.isArray(body.items)
  ) {
    return null;
  }

  const name = parseCheckoutText(
    body.customer.name,
    CHECKOUT_CUSTOMER_NAME_MAX_LENGTH,
  );
  const email =
    typeof body.customer.email === "string"
      ? body.customer.email.trim().toLowerCase()
      : null;
  const shippingAddress =
    body.shippingAddress === undefined
      ? undefined
      : isRecord(body.shippingAddress)
        ? parseShippingAddress(body.shippingAddress)
        : null;
  const promotionCode = parsePromotionCodeInput(body.promotionCode);
  const phone = parseOptionalCheckoutText(body.customer.phone, 30);
  const shippingQuote = parseShippingQuote(body.shippingQuote);
  const fulfillmentMode = parseFulfillmentMode(body.fulfillmentMode);
  const disclosures = parseDisclosures(body.disclosures);
  const payment = parsePaymentInput(body.payment);
  const reservationKey = parseReservationKey(body.reservationKey);

  if (
    name === null ||
    email === null ||
    !isValidCheckoutEmail(email) ||
    shippingAddress === null ||
    promotionCode === null ||
    phone === null ||
    shippingQuote === null ||
    fulfillmentMode === null ||
    disclosures === null ||
    payment === null
  ) {
    return null;
  }

  return {
    customer: { name, email, ...(phone ? { phone } : {}) },
    items: body.items.map(toCartInputItem),
    ...(shippingAddress ? { shippingAddress } : {}),
    fulfillmentMode,
    disclosures,
    ...(promotionCode ? { promotionCode } : {}),
    ...(shippingQuote ? { shippingQuote } : {}),
    ...(reservationKey ? { reservationKey } : {}),
    ...(payment ? { payment } : {}),
  };
}

/**
 * Client-supplied per-attempt reservation/idempotency token. Optional: absent or
 * malformed values fall back to random reservation (older clients must keep
 * working), so this returns undefined rather than rejecting the request.
 */
function parseReservationKey(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const reservationKey = value.trim();

  return reservationKey.length > 0 && reservationKey.length <= 200
    ? reservationKey
    : undefined;
}

function parsePaymentInput(
  value: unknown,
): CheckoutRequestBody["payment"] | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const sourceId =
    typeof value.sourceId === "string" ? value.sourceId.trim() : "";
  if (!sourceId || sourceId.length > 512) return null;
  const verificationToken =
    value.verificationToken === undefined
      ? undefined
      : typeof value.verificationToken === "string" &&
          value.verificationToken.trim().length > 0 &&
          value.verificationToken.length <= 2048
        ? value.verificationToken.trim()
        : null;
  if (verificationToken === null) return null;
  return {
    sourceId,
    ...(verificationToken ? { verificationToken } : {}),
  };
}

function parseFulfillmentMode(
  value: unknown,
): CheckoutRequestBody["fulfillmentMode"] | null {
  return value === "automated_shipping" ||
    value === "manual_pickup" ||
    value === "manual_shipping"
    ? value
    : null;
}

function parseDisclosures(
  value: unknown,
): CheckoutRequestBody["disclosures"] | null {
  if (!isRecord(value)) return null;
  const cancellationPolicyVersion = parseOptionalCheckoutText(
    value.cancellationPolicyVersion,
    100,
  );
  if (cancellationPolicyVersion === null) return null;
  const cancellationPolicyAccepted =
    value.cancellationPolicyAccepted === true
      ? true
      : value.cancellationPolicyAccepted === undefined
        ? undefined
        : null;
  const cancellationPolicyTextHash = parseOptionalCheckoutText(
    value.cancellationPolicyTextHash,
    64,
  );
  if (
    cancellationPolicyAccepted === null ||
    cancellationPolicyTextHash === null ||
    (cancellationPolicyTextHash !== undefined &&
      !/^[0-9a-f]{64}$/.test(cancellationPolicyTextHash))
  ) {
    return null;
  }
  const termsVersion = parseOptionalCheckoutText(value.termsVersion, 100);
  const termsAccepted =
    value.termsAccepted === true
      ? true
      : value.termsAccepted === undefined
        ? undefined
        : null;
  const termsTextHash = parseOptionalCheckoutText(value.termsTextHash, 64);
  if (
    termsVersion === null ||
    termsAccepted === null ||
    termsTextHash === null ||
    (termsTextHash !== undefined && !/^[0-9a-f]{64}$/.test(termsTextHash))
  ) {
    return null;
  }
  const usImportTerms =
    value.usImportTerms === "DDU"
      ? value.usImportTerms
      : value.usImportTerms === undefined
        ? undefined
        : null;
  const usImportDisclosureVersion = parseOptionalCheckoutText(
    value.usImportDisclosureVersion,
    100,
  );
  const usImportDisclosureText = parseOptionalCheckoutText(
    value.usImportDisclosureText,
    2_000,
  );
  if (
    usImportTerms === null ||
    usImportDisclosureVersion === null ||
    usImportDisclosureText === null
  )
    return null;
  return {
    ...(cancellationPolicyAccepted
      ? { cancellationPolicyAccepted: true as const }
      : {}),
    ...(cancellationPolicyVersion ? { cancellationPolicyVersion } : {}),
    ...(cancellationPolicyTextHash ? { cancellationPolicyTextHash } : {}),
    ...(termsAccepted ? { termsAccepted: true as const } : {}),
    ...(termsVersion ? { termsVersion } : {}),
    ...(termsTextHash ? { termsTextHash } : {}),
    ...(usImportTerms ? { usImportTerms } : {}),
    ...(usImportDisclosureVersion ? { usImportDisclosureVersion } : {}),
    ...(usImportDisclosureText ? { usImportDisclosureText } : {}),
  };
}

function normalizeValidatedShippingSelection(
  value: string | ValidatedShippingSelection,
): ValidatedShippingSelection {
  return typeof value === "string" ? { fingerprint: value } : value;
}

function shippingDisclosureMatchesRequest(
  validated: ValidatedShippingSelection,
  requested: CheckoutRequestBody["disclosures"],
): boolean {
  return (
    validated.usImportTerms === "DDU" &&
    validated.usImportTerms === requested.usImportTerms &&
    Boolean(validated.usImportDisclosureVersion?.trim()) &&
    validated.usImportDisclosureVersion ===
      requested.usImportDisclosureVersion &&
    Boolean(validated.usImportDisclosureText?.trim()) &&
    validated.usImportDisclosureText === requested.usImportDisclosureText
  );
}

function parseShippingQuote(
  value: unknown,
): CheckoutRequestBody["shippingQuote"] | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const token = typeof value.token === "string" ? value.token.trim() : "";
  const fingerprint =
    typeof value.fingerprint === "string" ? value.fingerprint.trim() : "";
  const rateId = typeof value.rateId === "string" ? value.rateId.trim() : "";
  if (!token || !/^[a-f0-9]{64}$/.test(fingerprint) || !rateId) return null;
  return { token, fingerprint, rateId };
}

function dependenciesProvideShippingWorkflow(input: {
  validateShippingSelection?: unknown;
  createInitializingOrder?: unknown;
}): boolean {
  return Boolean(
    input.validateShippingSelection && input.createInitializingOrder,
  );
}

function parseShippingAddress(
  value: Record<string, unknown>,
): CheckoutShippingAddressInput | null {
  const line1 = parseCheckoutText(
    value.line1,
    CHECKOUT_SHIPPING_LINE_MAX_LENGTH,
  );
  const city = parseCheckoutText(
    value.city,
    CHECKOUT_SHIPPING_LOCALITY_MAX_LENGTH,
  );
  const province = parseCheckoutText(
    value.province,
    CHECKOUT_SHIPPING_LOCALITY_MAX_LENGTH,
  );
  const postalCode = parseCheckoutText(
    value.postalCode,
    CHECKOUT_SHIPPING_POSTAL_CODE_MAX_LENGTH,
  );
  const country = parseCheckoutText(
    value.country,
    CHECKOUT_SHIPPING_LOCALITY_MAX_LENGTH,
  );

  if (
    line1 === null ||
    city === null ||
    province === null ||
    postalCode === null ||
    country === null
  ) {
    return null;
  }
  const normalizedCountry = country.trim().toUpperCase();
  if (
    normalizedCountry !== "CA" &&
    normalizedCountry !== "CANADA" &&
    normalizedCountry !== "US" &&
    normalizedCountry !== "UNITED STATES"
  ) {
    return null;
  }

  const line2 = parseOptionalCheckoutText(
    value.line2,
    CHECKOUT_SHIPPING_LINE_MAX_LENGTH,
  );

  if (line2 === null) {
    return null;
  }

  return {
    line1,
    ...(line2 ? { line2 } : {}),
    city,
    province,
    postalCode: postalCode.toUpperCase(),
    country,
  };
}

function normalizeShippingAddress(
  address: CheckoutShippingAddressInput,
  phone?: string,
): CheckoutShippingAddressInput {
  const countryCode = getShippingCountryCode(address);
  return {
    ...address,
    province: normalizeProvinceCode(address.province),
    postalCode: address.postalCode.toUpperCase(),
    country: countryCode === "US" ? "United States" : "Canada",
    countryCode,
    ...(phone ? { phone } : {}),
  };
}

function getShippingCountryCode(
  address: CheckoutShippingAddressInput,
): "CA" | "US" {
  const country = address.country.trim().toUpperCase();
  return address.countryCode === "US" ||
    country === "US" ||
    country === "UNITED STATES"
    ? "US"
    : "CA";
}

function normalizeProvinceCode(value: string): string {
  const normalized = value.trim().toUpperCase();
  const names: Record<string, string> = {
    ONTARIO: "ON",
    QUEBEC: "QC",
    ALBERTA: "AB",
    "BRITISH COLUMBIA": "BC",
    MANITOBA: "MB",
    SASKATCHEWAN: "SK",
    "NOVA SCOTIA": "NS",
    "NEW BRUNSWICK": "NB",
    NEWFOUNDLAND: "NL",
    "NEWFOUNDLAND AND LABRADOR": "NL",
    "PRINCE EDWARD ISLAND": "PE",
  };
  return names[normalized] ?? normalized;
}

function toCartInputItem(item: unknown): CartInputItem {
  if (!isRecord(item)) {
    return { productId: "", quantity: Number.NaN };
  }

  return {
    productId: typeof item.productId === "string" ? item.productId : "",
    ...(typeof item.variantId === "string"
      ? { variantId: item.variantId }
      : {}),
    quantity: typeof item.quantity === "number" ? item.quantity : Number.NaN,
  };
}

function summarizeCheckoutError(error: unknown): CheckoutErrorLog {
  if (!(error instanceof Error)) {
    return { error: "Unknown checkout error" };
  }

  const cause = isRecord(error)
    ? summarizeCheckoutErrorCause(error.cause)
    : undefined;
  const errorName = summarizeCheckoutErrorName(error.name);

  return {
    error: summarizeCheckoutErrorMessage(error),
    ...(errorName ? { errorName } : {}),
    ...(cause ? { cause } : {}),
  };
}

function summarizeCheckoutErrorCause(
  cause: unknown,
): CheckoutErrorLogCause | undefined {
  if (!isRecord(cause)) {
    return undefined;
  }

  const summary: CheckoutErrorLogCause = {};
  setSafeLogField(summary, "code", cause.code);
  setSafeLogField(summary, "severity", cause.severity);
  setSafeLogField(summary, "schema", cause.schema);
  setSafeLogField(summary, "table", cause.table);
  setSafeLogField(summary, "column", cause.column);
  setSafeLogField(summary, "constraint", cause.constraint);
  setSafeLogField(summary, "dataType", cause.dataType);
  setUndefinedColumnField(summary, cause);

  return Object.keys(summary).length > 0 ? summary : undefined;
}

function setUndefinedColumnField(
  summary: CheckoutErrorLogCause,
  cause: Record<string, unknown>,
): void {
  if (
    summary.column ||
    cause.code !== "42703" ||
    typeof cause.message !== "string"
  ) {
    return;
  }

  const missingColumn = cause.message.match(
    /^column "([A-Za-z0-9_.]+)"(?: of relation "[A-Za-z0-9_]+")? does not exist$/,
  );

  if (!missingColumn) {
    return;
  }

  summary.column = missingColumn[1];
}

function setSafeLogField(
  summary: CheckoutErrorLogCause,
  key: keyof CheckoutErrorLogCause,
  value: unknown,
): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    return;
  }

  summary[key] = sanitizeCheckoutLogText(value);
}

function summarizeCheckoutErrorMessage(error: Error): string {
  if (error.message.includes("Failed query:")) {
    return "Database query failed";
  }

  return "Checkout initialization failed";
}

function getCheckoutFailureStatus(stage: CheckoutInitializationStage): number {
  if (stage === "load_checkout_inputs" || stage === "reserve_order") {
    return 500;
  }
  return 400;
}

function summarizeCheckoutErrorName(name: string): string | undefined {
  const normalizedName = sanitizeCheckoutLogText(name);

  return /^[A-Za-z0-9_.:-]+$/.test(normalizedName) ? normalizedName : undefined;
}

function sanitizeCheckoutLogText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();

  return normalized.length > 240
    ? `${normalized.slice(0, 237)}...`
    : normalized;
}

function invalidPromotionCode(): NextResponse<CheckoutErrorBody> {
  return NextResponse.json<CheckoutErrorBody>(
    { error: "Invalid promotion code" },
    { status: 400 },
  );
}

function invalidFulfillmentMode(): NextResponse<CheckoutErrorBody> {
  return NextResponse.json<CheckoutErrorBody>(
    { error: "Cart items require a different fulfillment method" },
    { status: 409 },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function invalidCheckoutRequest(): NextResponse<CheckoutErrorBody> {
  return NextResponse.json<CheckoutErrorBody>(
    { error: "Invalid checkout request" },
    { status: 400 },
  );
}
