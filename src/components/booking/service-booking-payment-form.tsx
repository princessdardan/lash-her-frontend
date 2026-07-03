"use client";

import { useMemo, useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCad } from "@/lib/commerce/money";
import type { ServiceBookingPaymentSessionDisplay } from "@/lib/booking/payment-session";
import {
  resolveServicePaymentSelection,
  type ServicePaymentOption,
} from "@/lib/booking/payments/service-payment-selection";
import {
  SERVICE_NO_SHOW_POLICY_TEXT,
  SERVICE_NO_SHOW_POLICY_VERSION,
} from "@/lib/booking/payments/service-no-show-policy-copy";
import { SERVICE_BOOKING_HST_RATE } from "@/lib/booking/service-tax-policy";
import { validateField } from "@/lib/form-validation";

import {
  SquareChargeAndStoreForm,
  type SquareChargeAndStoreFormHandle,
} from "./square-charge-and-store-form";

export interface ServiceBookingPaymentFormProps {
  onExpired: () => void;
  onSessionUpdate: (session: ServiceBookingPaymentSessionDisplay) => void;
  onSuccess: (result: ServiceBookingPaymentConfirmation) => void;
  session: ServiceBookingPaymentSessionDisplay;
}

export interface ServiceBookingPaymentConfirmation {
  bookingStatus: "booked" | "manual_followup";
  card?: {
    brand?: string;
    expMonth?: number;
    expYear?: number;
    last4?: string;
  };
  holdReference?: string;
}

export function ServiceBookingPaymentForm({
  onExpired,
  onSessionUpdate,
  onSuccess,
  session,
}: ServiceBookingPaymentFormProps) {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const [paymentOption, setPaymentOption] =
    useState<ServicePaymentOption>("full");
  const [customAmount, setCustomAmount] = useState("");
  const [policyAccepted, setPolicyAccepted] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [promotionCodeInput, setPromotionCodeInput] = useState("");
  const [isApplyingPromotion, setIsApplyingPromotion] = useState(false);
  const squareFormRef = useRef<SquareChargeAndStoreFormHandle>(null);
  // Synchronous guard to prevent a fast double-click from tokenizing twice
  // before React has a chance to flip isSubmitting.
  const submissionInFlightRef = useRef(false);

  const pricingSnapshot = useMemo(
    () => ({
      addOnPriceCents: session.pricing.addOnPriceCents,
      currency: "CAD" as const,
      customAmountMaximumCents: session.pricing.customAmountMaximumCents,
      customAmountMinimumCents: session.pricing.customAmountMinimumCents,
      depositAmountCents: session.pricing.depositAmountCents,
      discountedBasePriceCents: session.pricing.discountedBasePriceCents,
      fullPriceCents: session.pricing.fullPriceCents,
      promotionCode: session.pricing.promotionCode,
      promotionDiscountCents: session.pricing.promotionDiscountCents,
      serviceTitle: session.serviceTitle,
      selectedAddOnName: session.selectedAddOn?.name,
    }),
    [session],
  );

  const selectedPayment = useMemo(() => {
    if (paymentOption === "customPartial") {
      const customAmountCents = parseCustomAmount(customAmount);
      if (customAmountCents === null) {
        return {
          ok: false,
          error: "Enter a valid custom amount greater than the deposit.",
        } as const;
      }
      return resolveServicePaymentSelection({
        pricing: pricingSnapshot,
        selection: { option: "customPartial", customAmountCents },
      });
    }

    return resolveServicePaymentSelection({
      pricing: pricingSnapshot,
      selection: { option: paymentOption },
    });
  }, [paymentOption, customAmount, pricingSnapshot]);

  const fullNameError = validateField(fullName, [
    { type: "required", message: "Full name is required." },
  ]);
  const emailError = validateField(email, [
    { type: "required", message: "Email address is required." },
    { type: "email", message: "Enter a valid email address." },
  ]);
  const phoneError = validateField(phone, [
    { type: "required", message: "Phone number is required." },
    { type: "phone", message: "Enter a valid phone number." },
  ]);

  const isCustomerValid =
    fullNameError === "" &&
    emailError === "" &&
    phoneError === "" &&
    policyAccepted;

  const isPaymentSelectionValid = selectedPayment.ok;
  const selectedAmountCents = isPaymentSelectionValid
    ? selectedPayment.payment.amountCents
    : 0;

  const selectedHstCents = isPaymentSelectionValid
    ? Math.round(selectedAmountCents * SERVICE_BOOKING_HST_RATE)
    : 0;
  const selectedTotalCents = isPaymentSelectionValid
    ? selectedAmountCents + selectedHstCents
    : 0;

  const originalBookedTotalCents =
    session.pricing.fullPriceCents + session.pricing.addOnPriceCents;
  const bookedTotalAfterDiscountCents =
    (session.pricing.discountedBasePriceCents ??
      session.pricing.fullPriceCents) + session.pricing.addOnPriceCents;
  const serviceDiscountCents = session.pricing.promotionDiscountCents ?? 0;

  // The card-on-file provider cannot authorize or store a card for a zero
  // total. Allow the user to see the breakdown, but block submission.
  const isPaymentAmountPositive = selectedAmountCents > 0;

  const buyerDetails =
    isCustomerValid && isPaymentSelectionValid && isPaymentAmountPositive
      ? {
          // Square verification and the backend authorization must both see the
          // HST-inclusive total so the verified/charged amount matches.
          amountCents: selectedTotalCents,
          email,
          fullName,
          phone,
        }
      : null;

  const isSquareFormDisabled =
    !isCustomerValid ||
    !isPaymentSelectionValid ||
    !isPaymentAmountPositive ||
    isSubmitting ||
    isApplyingPromotion;

  const handleApplyPromotion = async () => {
    const code = promotionCodeInput.trim();
    if (code.length === 0) return;

    setIsApplyingPromotion(true);
    setErrorMessage("");

    try {
      const response = await fetch("/api/booking/payment/promotion-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "apply",
          code,
          paymentSessionReference: session.paymentSessionReference,
        }),
      });

      if (response.status === 409) {
        onExpired();
        return;
      }

      const data = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      if (!response.ok) {
        throw new Error(
          typeof data.error === "string"
            ? data.error
            : "Unable to apply promotion code.",
        );
      }

      const updatedSession = parseSessionResponse(data.session);
      if (updatedSession !== null) {
        onSessionUpdate(updatedSession);
        setPromotionCodeInput("");
      } else {
        throw new Error("Invalid session response from server.");
      }
    } catch (error: unknown) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Unable to apply promotion code.",
      );
    } finally {
      setIsApplyingPromotion(false);
    }
  };

  const handleRemovePromotion = async () => {
    setIsApplyingPromotion(true);
    setErrorMessage("");

    try {
      const response = await fetch("/api/booking/payment/promotion-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "remove",
          paymentSessionReference: session.paymentSessionReference,
        }),
      });

      if (response.status === 409) {
        onExpired();
        return;
      }

      const data = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      if (!response.ok) {
        throw new Error(
          typeof data.error === "string"
            ? data.error
            : "Unable to remove promotion code.",
        );
      }

      const updatedSession = parseSessionResponse(data.session);
      if (updatedSession !== null) {
        onSessionUpdate(updatedSession);
      } else {
        throw new Error("Invalid session response from server.");
      }
    } catch (error: unknown) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Unable to remove promotion code.",
      );
    } finally {
      setIsApplyingPromotion(false);
    }
  };

  const handleTokenized = async (token: {
    sourceId: string;
    verificationToken?: string;
  }) => {
    const idempotencyKey = generateIdempotencyKey();
    const policyTextHash = await hashServiceNoShowPolicyText(
      SERVICE_NO_SHOW_POLICY_TEXT,
    );

    const body = {
      paymentSessionReference: session.paymentSessionReference,
      customer: {
        email,
        marketingOptIn,
        name: fullName,
        phone,
      },
      payment: {
        option: paymentOption,
        ...(paymentOption === "customPartial"
          ? { customAmountCents: selectedAmountCents }
          : {}),
        expectedAmountCents: selectedAmountCents,
      },
      policy: {
        accepted: true,
        policyTextHash,
        policyVersion: SERVICE_NO_SHOW_POLICY_VERSION,
      },
      sourceId: token.sourceId,
      verificationToken: token.verificationToken,
      idempotencyKey,
    };

    const response = await fetch("/api/booking/payment/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      if (response.status === 409) {
        onExpired();
        return;
      }

      const data = await response.json().catch(() => ({}));
      throw new Error(
        typeof data.error === "string"
          ? data.error
          : "Failed to confirm booking payment.",
      );
    }

    const result = (await response.json()) as Record<string, unknown>;

    if (
      typeof result.bookingStatus !== "string" ||
      (result.bookingStatus !== "booked" &&
        result.bookingStatus !== "manual_followup")
    ) {
      throw new Error("Failed to confirm booking payment.");
    }

    onSuccess({
      bookingStatus: result.bookingStatus,
      ...(typeof result.holdReference === "string"
        ? { holdReference: result.holdReference }
        : {}),
      ...(isCardDisplay(result.card) ? { card: result.card } : {}),
    });
  };

  const handleSubmit = async () => {
    if (
      !isCustomerValid ||
      !isPaymentSelectionValid ||
      !isPaymentAmountPositive
    ) {
      setErrorMessage(
        "Please complete all required fields, choose a payment amount, and accept the booking policy.",
      );
      return;
    }

    if (squareFormRef.current === null) {
      setErrorMessage("Secure card form is not ready. Please try again.");
      return;
    }

    if (submissionInFlightRef.current) {
      return;
    }

    submissionInFlightRef.current = true;
    setIsSubmitting(true);
    setErrorMessage("");

    try {
      await squareFormRef.current.tokenize();
    } catch (error: unknown) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Payment failed. Please try again.",
      );
    } finally {
      submissionInFlightRef.current = false;
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="servicePaymentFullName">Full Name</Label>
          <Input
            id="servicePaymentFullName"
            type="text"
            autoComplete="name"
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
            placeholder="Your Name"
          />
          {fullNameError && (
            <p className="text-sm font-medium text-red-600">{fullNameError}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="servicePaymentEmail">Email Address</Label>
          <Input
            id="servicePaymentEmail"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="youremail@email.com"
          />
          {emailError && (
            <p className="text-sm font-medium text-red-600">{emailError}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="servicePaymentPhone">Phone Number</Label>
          <Input
            id="servicePaymentPhone"
            type="tel"
            autoComplete="tel"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            placeholder="(647) 555-1234"
          />
          {phoneError && (
            <p className="text-sm font-medium text-red-600">{phoneError}</p>
          )}
        </div>

        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            id="servicePaymentMarketingOptIn"
            checked={marketingOptIn}
            onChange={(event) => setMarketingOptIn(event.target.checked)}
            className="mt-1 h-4 w-4 rounded border-input text-primary focus:ring-primary"
          />
          <Label
            htmlFor="servicePaymentMarketingOptIn"
            className="text-sm leading-snug text-muted-foreground"
          >
            I would like to receive marketing updates and offers.
          </Label>
        </div>
      </div>

      <div className="space-y-3">
        <Label>Promotion Code</Label>
        {session.pricing.promotionCode ? (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-lh-line bg-white p-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-black">
                {session.pricing.promotionCode}
              </p>
              {session.pricing.promotionDiscountCents ? (
                <p className="text-xs text-lh-muted">
                  -{formatCad(session.pricing.promotionDiscountCents / 100)}{" "}
                  service discount applied
                </p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={handleRemovePromotion}
              disabled={isApplyingPromotion || isSubmitting}
              className="shrink-0 text-sm font-medium text-red-600 hover:text-red-700 disabled:opacity-60"
            >
              Remove
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <Input
              type="text"
              value={promotionCodeInput}
              onChange={(event) => setPromotionCodeInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (!isSubmitting) {
                    void handleApplyPromotion();
                  }
                }
              }}
              placeholder="Enter code"
              className="uppercase"
              aria-label="Promotion code"
              disabled={isApplyingPromotion || isSubmitting}
            />
            <button
              type="button"
              onClick={() => void handleApplyPromotion()}
              disabled={
                isApplyingPromotion ||
                isSubmitting ||
                promotionCodeInput.trim().length === 0
              }
              className="shrink-0 rounded-full bg-lh-primary px-5 py-2 font-body text-sm font-bold uppercase tracking-[0.12em] text-lh-white transition-colors hover:bg-lh-accent disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isApplyingPromotion ? "Applying..." : "Apply"}
            </button>
          </div>
        )}
      </div>

      <div className="space-y-3">
        <Label>Payment Option</Label>

        <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-lh-line bg-white p-4">
          <input
            type="radio"
            name="servicePaymentOption"
            value="full"
            checked={paymentOption === "full"}
            onChange={() => setPaymentOption("full")}
            className="h-4 w-4 text-primary"
          />
          <span className="flex-1 text-sm font-medium text-black">
            Full payment
          </span>
          <span className="text-right text-sm text-lh-muted">
            {formatCad(bookedTotalAfterDiscountCents / 100)}
            {session.pricing.addOnPriceCents > 0 ? " (includes add-on)" : ""}
            <span className="block text-xs">before HST</span>
          </span>
        </label>

        <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-lh-line bg-white p-4">
          <input
            type="radio"
            name="servicePaymentOption"
            value="deposit"
            checked={paymentOption === "deposit"}
            onChange={() => setPaymentOption("deposit")}
            className="h-4 w-4 text-primary"
          />
          <span className="flex-1 text-sm font-medium text-black">
            Deposit only
          </span>
          <span className="text-right text-sm text-lh-muted">
            {formatCad(
              Math.min(
                session.pricing.depositAmountCents,
                session.pricing.discountedBasePriceCents ??
                  session.pricing.fullPriceCents,
              ) / 100,
            )}
            <span className="block text-xs">before HST</span>
          </span>
        </label>

        <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-lh-line bg-white p-4">
          <input
            type="radio"
            name="servicePaymentOption"
            value="customPartial"
            checked={paymentOption === "customPartial"}
            onChange={() => setPaymentOption("customPartial")}
            className="h-4 w-4 text-primary"
          />
          <span className="flex-1 text-sm font-medium text-black">
            Custom partial payment
            <span className="block text-xs font-normal text-lh-muted">
              before HST
            </span>
          </span>
        </label>

        {paymentOption === "customPartial" && (
          <div className="space-y-2 pl-7">
            <Input
              type="text"
              inputMode="decimal"
              value={customAmount}
              onChange={(event) => setCustomAmount(event.target.value)}
              placeholder={
                (session.pricing.discountedBasePriceCents ??
                  session.pricing.fullPriceCents) === 0
                  ? "Not available when the service is fully discounted"
                  : `Between ${formatCad(
                      session.pricing.depositAmountCents / 100,
                    )} and ${formatCad(
                      (session.pricing.discountedBasePriceCents ??
                        session.pricing.fullPriceCents) / 100,
                    )} before HST`
              }
              aria-label="Custom payment amount"
            />
            {!isPaymentSelectionValid && selectedPayment.error && (
              <p className="text-sm font-medium text-red-600">
                {selectedPayment.error}
              </p>
            )}
          </div>
        )}

        {isPaymentSelectionValid && (
          <div className="rounded-xl border border-lh-line bg-white p-4">
            <p className="mb-3 text-sm font-medium text-black">
              Today&apos;s payment breakdown
            </p>
            <div className="space-y-2">
              <div className="flex justify-between text-sm text-lh-muted">
                <span>Original booked total</span>
                <span>{formatCad(originalBookedTotalCents / 100)}</span>
              </div>
              {serviceDiscountCents > 0 ? (
                <div className="flex justify-between text-sm text-lh-muted">
                  <span>
                    Service discount
                    {session.pricing.promotionCode
                      ? ` (${session.pricing.promotionCode})`
                      : ""}
                  </span>
                  <span>-{formatCad(serviceDiscountCents / 100)}</span>
                </div>
              ) : null}
              <div className="flex justify-between text-sm text-black">
                <span>Booked total after discount</span>
                <span>{formatCad(bookedTotalAfterDiscountCents / 100)}</span>
              </div>
              {session.pricing.addOnPriceCents > 0 && (
                <p className="text-xs leading-snug text-lh-muted">
                  Add-ons are included in the booked total and are not
                  discounted.
                </p>
              )}
              <div className="flex justify-between border-t border-lh-line pt-2 text-sm text-lh-muted">
                <span>Paid today</span>
                <span>{formatCad(selectedAmountCents / 100)}</span>
              </div>
              <div className="flex justify-between text-sm text-lh-muted">
                <span>Ontario HST (13%)</span>
                <span>{formatCad(selectedHstCents / 100)}</span>
              </div>
              <div className="flex justify-between border-t border-lh-line pt-2 text-sm font-bold text-black">
                <span>Total due today</span>
                <span>{formatCad(selectedTotalCents / 100)}</span>
              </div>
            </div>
            {!isPaymentAmountPositive && (
              <p className="mt-3 text-sm font-medium text-red-600">
                This booking has no remaining balance to pay online. Please
                choose an option that covers the total, or contact us to book.
              </p>
            )}
          </div>
        )}
      </div>

      <div className="space-y-3">
        <SquareChargeAndStoreForm
          ref={squareFormRef}
          buyer={buyerDetails}
          disabled={isSquareFormDisabled}
          onError={setErrorMessage}
          onTokenized={handleTokenized}
        />
      </div>

      <div className="space-y-3">
        <div className="rounded-xl border border-lh-line bg-white p-4">
          <p className="mb-2 text-sm font-medium text-black">
            No-show &amp; late cancellation policy
          </p>
          <p className="mt-2 text-sm leading-snug text-lh-muted">
            {SERVICE_NO_SHOW_POLICY_TEXT}
          </p>
        </div>

        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            id="servicePaymentPolicyAccepted"
            checked={policyAccepted}
            onChange={(event) => setPolicyAccepted(event.target.checked)}
            className="mt-1 h-4 w-4 rounded border-input text-primary focus:ring-primary"
          />
          <Label
            htmlFor="servicePaymentPolicyAccepted"
            className="text-sm leading-snug text-muted-foreground"
          >
            I have read and agree to the no-show policy above.
          </Label>
        </div>
      </div>

      {errorMessage && (
        <p
          role="alert"
          className="text-center text-sm font-medium text-red-600"
        >
          {errorMessage}
        </p>
      )}

      <button
        type="button"
        disabled={isSquareFormDisabled}
        onClick={handleSubmit}
        className="w-full rounded-full bg-lh-primary px-7 py-4 font-body text-sm font-bold uppercase tracking-[0.12em] text-lh-white transition-colors hover:bg-lh-accent disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isSubmitting ? "Processing..." : "Pay and confirm booking"}
      </button>
    </div>
  );
}

function parseCustomAmount(value: string): number | null {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    return null;
  }

  const [dollarsPart, centsPart = ""] = normalized.split(".");
  return Number.parseInt(`${dollarsPart}${centsPart.padEnd(2, "0")}`, 10);
}

async function hashServiceNoShowPolicyText(text: string): Promise<string> {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
  const encoder = new TextEncoder();
  const data = encoder.encode(normalized);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function generateIdempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isCardDisplay(value: unknown): value is {
  brand?: string;
  expMonth?: number;
  expYear?: number;
  last4?: string;
} {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;

  if (record.brand !== undefined && typeof record.brand !== "string") {
    return false;
  }

  if (record.last4 !== undefined && typeof record.last4 !== "string") {
    return false;
  }

  if (record.expMonth !== undefined && typeof record.expMonth !== "number") {
    return false;
  }

  if (record.expYear !== undefined && typeof record.expYear !== "number") {
    return false;
  }

  const allowedKeys = ["brand", "expMonth", "expYear", "last4"];
  const keys = Object.keys(record);

  return keys.every((key) => allowedKeys.includes(key));
}

function parseSessionResponse(
  value: unknown,
): ServiceBookingPaymentSessionDisplay | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;

  const currency = record.currency;
  const expiresAt =
    typeof record.expiresAt === "string" ? record.expiresAt : "";
  const paymentSessionReference =
    typeof record.paymentSessionReference === "string"
      ? record.paymentSessionReference
      : "";
  const serviceSlug =
    typeof record.serviceSlug === "string" ? record.serviceSlug : "";
  const serviceTitle =
    typeof record.serviceTitle === "string" ? record.serviceTitle : "";
  const timezone = typeof record.timezone === "string" ? record.timezone : "";
  const selectedStart =
    typeof record.selectedStart === "string" ? record.selectedStart : "";
  const selectedEnd =
    typeof record.selectedEnd === "string" ? record.selectedEnd : "";

  if (
    currency !== "CAD" ||
    expiresAt.length === 0 ||
    paymentSessionReference.length === 0 ||
    serviceSlug.length === 0 ||
    serviceTitle.length === 0 ||
    timezone.length === 0 ||
    selectedStart.length === 0 ||
    selectedEnd.length === 0 ||
    !isRecord(record.pricing)
  ) {
    return null;
  }

  const pricingRecord = record.pricing as Record<string, unknown>;
  const addOnPriceCents =
    typeof pricingRecord.addOnPriceCents === "number"
      ? pricingRecord.addOnPriceCents
      : null;
  const customAmountMaximumCents =
    typeof pricingRecord.customAmountMaximumCents === "number"
      ? pricingRecord.customAmountMaximumCents
      : null;
  const customAmountMinimumCents =
    typeof pricingRecord.customAmountMinimumCents === "number"
      ? pricingRecord.customAmountMinimumCents
      : null;
  const depositAmountCents =
    typeof pricingRecord.depositAmountCents === "number"
      ? pricingRecord.depositAmountCents
      : null;
  const fullPriceCents =
    typeof pricingRecord.fullPriceCents === "number"
      ? pricingRecord.fullPriceCents
      : null;

  if (
    addOnPriceCents === null ||
    customAmountMaximumCents === null ||
    customAmountMinimumCents === null ||
    depositAmountCents === null ||
    fullPriceCents === null
  ) {
    return null;
  }

  const pricing: ServiceBookingPaymentSessionDisplay["pricing"] = {
    addOnPriceCents,
    customAmountMaximumCents,
    customAmountMinimumCents,
    depositAmountCents,
    fullPriceCents,
  };

  if (typeof pricingRecord.discountedBasePriceCents === "number") {
    pricing.discountedBasePriceCents = pricingRecord.discountedBasePriceCents;
  }
  if (typeof pricingRecord.promotionCode === "string") {
    pricing.promotionCode = pricingRecord.promotionCode;
  }
  if (typeof pricingRecord.promotionDiscountCents === "number") {
    pricing.promotionDiscountCents = pricingRecord.promotionDiscountCents;
  }

  return {
    currency: "CAD",
    expiresAt,
    paymentSessionReference,
    pricing,
    selectedAddOn: parseSelectedAddOn(record.selectedAddOn),
    selectedEnd,
    selectedStart,
    serviceSlug,
    serviceTitle,
    timezone,
  };
}

function parseSelectedAddOn(
  value: unknown,
): ServiceBookingPaymentSessionDisplay["selectedAddOn"] {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;

  const description =
    typeof record.description === "string" ? record.description : "";
  const key = typeof record.key === "string" ? record.key : "";
  const name = typeof record.name === "string" ? record.name : "";
  const priceCents =
    typeof record.priceCents === "number" ? record.priceCents : null;

  if (
    description.length === 0 ||
    key.length === 0 ||
    name.length === 0 ||
    priceCents === null
  ) {
    return undefined;
  }

  return { description, key, name, priceCents };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
