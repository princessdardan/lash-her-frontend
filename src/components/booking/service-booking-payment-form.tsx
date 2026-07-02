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
import { validateField } from "@/lib/form-validation";

import {
  SquareChargeAndStoreForm,
  type SquareChargeAndStoreFormHandle,
} from "./square-charge-and-store-form";

export interface ServiceBookingPaymentFormProps {
  onExpired: () => void;
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
      fullPriceCents: session.pricing.fullPriceCents,
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

  const buyerDetails =
    isCustomerValid && isPaymentSelectionValid
      ? {
          amountCents: selectedAmountCents,
          email,
          fullName,
          phone,
        }
      : null;

  const isSquareFormDisabled =
    !isCustomerValid || !isPaymentSelectionValid || isSubmitting;

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
    if (!isCustomerValid || !isPaymentSelectionValid) {
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
            placeholder="Jane Doe"
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
            placeholder="jane@example.com"
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
          <span className="text-sm text-lh-muted">
            {formatCad(session.pricing.fullPriceCents / 100)}
            {session.pricing.addOnPriceCents > 0
              ? ` + ${formatCad(session.pricing.addOnPriceCents / 100)} add-on`
              : ""}
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
          <span className="text-sm text-lh-muted">
            {formatCad(session.pricing.depositAmountCents / 100)}
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
          </span>
        </label>

        {paymentOption === "customPartial" && (
          <div className="space-y-2 pl-7">
            <Input
              type="text"
              inputMode="decimal"
              value={customAmount}
              onChange={(event) => setCustomAmount(event.target.value)}
              placeholder={`Between ${formatCad(
                session.pricing.depositAmountCents / 100,
              )} and ${formatCad(session.pricing.fullPriceCents / 100)}`}
              aria-label="Custom payment amount"
            />
            {!isPaymentSelectionValid && selectedPayment.error && (
              <p className="text-sm font-medium text-red-600">
                {selectedPayment.error}
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
