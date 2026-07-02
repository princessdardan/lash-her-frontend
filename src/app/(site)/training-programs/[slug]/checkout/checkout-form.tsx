"use client";

import { useState } from "react";
import { TrainingHelcimPayButton } from "@/components/commerce/training-helcim-pay-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCad } from "@/lib/commerce/money";

interface CheckoutFormProps {
  programSlug: string;
  clientPrice: number;
  originalSubtotal?: number;
  manualDiscount: number;
  subtotal: number;
  tax: number;
  total: number;
  currency: string;
  afterpaySquareInvoiceEnabled?: boolean;
}

function getSquareInvoicePublicUrl(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;

  const publicUrl = (value as { publicUrl?: unknown }).publicUrl;
  if (typeof publicUrl !== "string") return null;

  try {
    const url = new URL(publicUrl);
    return url.protocol === "https:" || url.hostname === "localhost"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function CheckoutForm({
  programSlug,
  clientPrice,
  originalSubtotal,
  manualDiscount,
  subtotal,
  tax,
  total,
  currency,
  afterpaySquareInvoiceEnabled = false,
}: CheckoutFormProps) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [promotionCodeInput, setPromotionCodeInput] = useState("");
  const [redeemedPromotionCode, setRedeemedPromotionCode] = useState<
    string | undefined
  >();
  const [promotionDiscount, setPromotionDiscount] = useState(0);
  const [discountedSubtotal, setDiscountedSubtotal] = useState(subtotal);
  const [discountedTax, setDiscountedTax] = useState(tax);
  const [discountedTotal, setDiscountedTotal] = useState(total);
  const [promotionCodeError, setPromotionCodeError] = useState<string | null>(
    null,
  );
  const [isApplyingPromotionCode, setIsApplyingPromotionCode] = useState(false);
  const [isStartingAfterpayInvoice, setIsStartingAfterpayInvoice] =
    useState(false);
  const [afterpayInvoiceError, setAfterpayInvoiceError] = useState<
    string | null
  >(null);

  const isValid = name.trim().length > 0 && email.includes("@") && acknowledged;
  const amountBeforePromotion = redeemedPromotionCode
    ? subtotal
    : discountedSubtotal;
  const afterpayInvoiceDescriptionIds = afterpayInvoiceError
    ? "training-afterpay-invoice-note training-afterpay-invoice-error"
    : "training-afterpay-invoice-note";

  const handleApplyPromotionCode = async () => {
    if (!promotionCodeInput.trim()) return;

    setPromotionCodeError(null);
    setIsApplyingPromotionCode(true);

    try {
      const response = await fetch("/api/promotion-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetType: "trainingProgram",
          programSlug,
          promotionCode: promotionCodeInput,
        }),
      });

      if (!response.ok) {
        setPromotionCodeError(
          "This code is not valid for this training program.",
        );
        setRedeemedPromotionCode(undefined);
        setPromotionDiscount(0);
        setDiscountedSubtotal(subtotal);
        setDiscountedTax(tax);
        setDiscountedTotal(total);
        return;
      }

      const data = (await response.json()) as {
        promotionCode?: string;
        discountAmount?: number;
        trainingQuote?: { subtotal: number; tax: number; total: number };
      };
      if (!data.promotionCode || !data.trainingQuote) {
        setPromotionCodeError(
          "This code is not valid for this training program.",
        );
        setRedeemedPromotionCode(undefined);
        setPromotionDiscount(0);
        setDiscountedSubtotal(subtotal);
        setDiscountedTax(tax);
        setDiscountedTotal(total);
        return;
      }

      setRedeemedPromotionCode(data.promotionCode);
      setPromotionCodeInput(data.promotionCode);
      setPromotionDiscount(data.discountAmount ?? 0);
      setDiscountedSubtotal(data.trainingQuote.subtotal);
      setDiscountedTax(data.trainingQuote.tax);
      setDiscountedTotal(data.trainingQuote.total);
    } catch {
      setPromotionCodeError("We could not apply this code. Please try again.");
      setRedeemedPromotionCode(undefined);
      setPromotionDiscount(0);
      setDiscountedSubtotal(subtotal);
      setDiscountedTax(tax);
      setDiscountedTotal(total);
    } finally {
      setIsApplyingPromotionCode(false);
    }
  };

  const handleRemovePromotionCode = () => {
    setRedeemedPromotionCode(undefined);
    setPromotionDiscount(0);
    setDiscountedSubtotal(subtotal);
    setDiscountedTax(tax);
    setDiscountedTotal(total);
    setPromotionCodeError(null);
  };

  const handleStartAfterpayInvoice = async () => {
    if (!isValid || isStartingAfterpayInvoice || !afterpaySquareInvoiceEnabled)
      return;

    setAfterpayInvoiceError(null);
    setIsStartingAfterpayInvoice(true);

    try {
      const response = await fetch("/api/training-checkout/square-invoice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          programSlug,
          customerName: name,
          customerEmail: email,
          clientPrice,
          ...(redeemedPromotionCode
            ? { promotionCode: redeemedPromotionCode }
            : {}),
        }),
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        setAfterpayInvoiceError(
          errorData?.error ??
            "Unable to start the invoice checkout. Please try again.",
        );
        setIsStartingAfterpayInvoice(false);
        return;
      }

      const publicUrl = getSquareInvoicePublicUrl(await response.json());
      if (!publicUrl) {
        setAfterpayInvoiceError(
          "Unable to open the invoice checkout. Please try again.",
        );
        setIsStartingAfterpayInvoice(false);
        return;
      }

      window.location.assign(publicUrl);
    } catch {
      setAfterpayInvoiceError(
        "Unable to start the invoice checkout. Please try again.",
      );
      setIsStartingAfterpayInvoice(false);
    }
  };

  return (
    <div className="space-y-8">
      <div className="border-t border-b border-lh-neutral/20 py-6">
        <div className="space-y-3 mb-4">
          <div className="flex justify-between items-center text-lh-shadow/80">
            <span>Subtotal</span>
            <span className="flex items-baseline gap-2">
              {originalSubtotal !== undefined || redeemedPromotionCode ? (
                <span className="text-sm text-lh-shadow/50 line-through">
                  {formatCad(
                    redeemedPromotionCode
                      ? amountBeforePromotion
                      : (originalSubtotal ?? amountBeforePromotion),
                  )}
                </span>
              ) : null}
              <span>{formatCad(discountedSubtotal)}</span>
            </span>
          </div>
          {manualDiscount > 0 ? (
            <div className="flex justify-between items-center text-sm font-bold text-lh-shadow/60">
              <span>Manual discount</span>
              <span>-{formatCad(manualDiscount)}</span>
            </div>
          ) : null}
          {redeemedPromotionCode && promotionDiscount > 0 ? (
            <div className="flex justify-between items-center text-sm font-bold text-lh-primary">
              <span>Code {redeemedPromotionCode}</span>
              <span>-{formatCad(promotionDiscount)}</span>
            </div>
          ) : null}
          <div className="flex justify-between items-center text-lh-shadow/80">
            <span>Ontario HST (13%)</span>
            <span>{formatCad(discountedTax)}</span>
          </div>
          <div className="flex justify-between items-center font-medium text-lg pt-3 border-t border-lh-neutral/10">
            <span>Total</span>
            <span className="flex items-baseline gap-2">
              {redeemedPromotionCode ? (
                <span className="text-sm text-lh-shadow/50 line-through">
                  {formatCad(total)}
                </span>
              ) : null}
              <span>{formatCad(discountedTotal)}</span>
            </span>
          </div>
        </div>
        <p className="text-sm text-lh-shadow/70 text-right">
          Taxes calculated in {currency}
        </p>
      </div>

      <div className="rounded-[24px] border border-lh-neutral/20 bg-white/70 p-5">
        <Label htmlFor="training-promotion-code">Promotion code</Label>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <Input
            id="training-promotion-code"
            value={promotionCodeInput}
            onChange={(event) =>
              setPromotionCodeInput(event.target.value.toUpperCase())
            }
            placeholder="Enter code"
            disabled={isApplyingPromotionCode}
            autoComplete="off"
            className="bg-white"
          />
          <Button
            type="button"
            variant="ghost"
            onClick={
              redeemedPromotionCode
                ? handleRemovePromotionCode
                : handleApplyPromotionCode
            }
            disabled={
              isApplyingPromotionCode ||
              (!redeemedPromotionCode && !promotionCodeInput.trim())
            }
            className="rounded-full border-lh-primary/30 px-5 font-body text-sm uppercase tracking-[0.12em] hover:bg-lh-primary-soft hover:text-lh-primary"
          >
            {isApplyingPromotionCode
              ? "Applying"
              : redeemedPromotionCode
                ? "Remove"
                : "Apply"}
          </Button>
        </div>
        {redeemedPromotionCode ? (
          <p className="mt-2 font-body text-xs font-bold uppercase tracking-[0.12em] text-lh-primary">
            Code {redeemedPromotionCode} applied.
          </p>
        ) : null}
        {promotionCodeError ? (
          <p
            className="mt-2 font-body text-xs font-bold text-lh-accent"
            role="alert"
          >
            {promotionCodeError}
          </p>
        ) : null}
      </div>

      <div className="space-y-4">
        <h3 className="section-subheading text-lg md:text-lg lg:text-lg">
          Your Details
        </h3>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Full Name</Label>
            <Input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your Name"
              required
              className="bg-white"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Email Address</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="youremail@email.com"
              required
              className="bg-white"
            />
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <h3 className="section-subheading text-lg md:text-lg lg:text-lg">
          What happens next?
        </h3>
        <ul className="space-y-3 text-lh-shadow/80">
          <li className="flex items-start gap-3">
            <span className="text-lh-shadow mt-1">•</span>
            <span>Complete your secure payment.</span>
          </li>
          <li className="flex items-start gap-3">
            <span className="text-lh-shadow mt-1">•</span>
            <span>
              Receive an email with a 14-day link to schedule your training
              call.
            </span>
          </li>
          <li className="flex items-start gap-3">
            <span className="text-lh-shadow mt-1">•</span>
            <span>
              Any training dates or program details after that call are
              coordinated manually.
            </span>
          </li>
        </ul>
      </div>

      <div className="space-y-6">
        <div className="flex items-start space-x-3">
          <input
            type="checkbox"
            id="terms"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="mt-1 h-4 w-4 rounded border-lh-neutral/30 text-lh-primary focus:ring-lh-primary"
          />
          <div className="grid gap-1.5 leading-none">
            <Label
              htmlFor="terms"
              className="text-sm font-medium leading-snug peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            >
              I acknowledge the terms
            </Label>
            <p className="text-sm text-lh-shadow/70">
              I understand that this payment is non-refundable and secures my
              enrollment in the training program.
            </p>
          </div>
        </div>

        <TrainingHelcimPayButton
          disabled={!isValid}
          programSlug={programSlug}
          clientPrice={clientPrice}
          promotionCode={redeemedPromotionCode}
          customer={{ name, email }}
          onPaid={() => {}}
        />

        {afterpaySquareInvoiceEnabled ? (
          <div className="rounded-[24px] border border-lh-line bg-lh-neutral-2/60 p-5">
            <div className="mb-4 flex items-center gap-4">
              <div className="h-px flex-1 bg-lh-line" aria-hidden="true" />
              <p className="font-heading text-xs font-normal uppercase tracking-[0.28em] text-lh-muted">
                Secondary option
              </p>
              <div className="h-px flex-1 bg-lh-line" aria-hidden="true" />
            </div>
            <Button
              type="button"
              variant="ghost"
              onClick={handleStartAfterpayInvoice}
              disabled={!isValid || isStartingAfterpayInvoice}
              aria-busy={isStartingAfterpayInvoice}
              aria-describedby={afterpayInvoiceDescriptionIds}
              className="h-12 w-full rounded-full border-lh-primary/30 px-6 font-body text-sm uppercase tracking-[0.12em] text-lh-shadow hover:bg-lh-primary-soft hover:text-lh-primary"
            >
              {isStartingAfterpayInvoice
                ? "Preparing invoice..."
                : "Pay with Afterpay"}
            </Button>
            <p
              id="training-afterpay-invoice-note"
              className="mt-3 text-center font-body text-xs font-bold leading-6 text-lh-shadow/65"
            >
              Afterpay availability is determined by Square at checkout. Your
              enrollment will be activated once the invoice is paid.
            </p>
            {afterpayInvoiceError ? (
              <p
                id="training-afterpay-invoice-error"
                className="mt-3 font-body text-xs font-bold text-lh-accent"
                role="alert"
              >
                {afterpayInvoiceError}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
