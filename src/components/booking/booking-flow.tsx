"use client";

import { useState, useEffect, useMemo } from "react";
import { nanoid } from "nanoid";
import Script from "next/script";
import { usePathname, useRouter } from "next/navigation";
import type { BookingSettings, BookingType, BookingSlot, BookingAnswerInput } from "@/lib/booking/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, FieldLabel, FieldError, FieldDescription } from "@/components/ui/field";
import { formatCad } from "@/lib/commerce/money";
import type { HelcimPayloadValue } from "@/lib/commerce/helcim-types";

declare global {
  interface Window {
    appendHelcimPayIframe?: (checkoutToken: string, allowExit?: boolean) => void;
    removeHelcimPayIframe?: () => void;
  }
}

interface BookingFlowProps {
  settings: BookingSettings;
  initialBookingType?: BookingType;
  paidTrainingOrderId?: string;
  initialOfferingSlug?: string;
  offeringPayment?: {
    depositAmount: number;
    fullPrice: number;
    currency: "CAD";
  };
}

export function BookingFlow({ settings, initialBookingType, paidTrainingOrderId, initialOfferingSlug, offeringPayment }: BookingFlowProps) {
  const pathname = usePathname();
  const router = useRouter();
  const defaultType = initialBookingType ?? settings.bookingTypes[0]?.type ?? "training-call";
  const paidTrainingOrder = paidTrainingOrderId?.trim();
  const hasPaidTrainingOrder = paidTrainingOrder !== undefined && paidTrainingOrder.length > 0;
  const hasOffering = Boolean(initialOfferingSlug);
  const isPaidOfferingCheckout = offeringPayment !== undefined && hasOffering && !hasPaidTrainingOrder;
  const shouldCollectIntake = !isPaidOfferingCheckout;
  const [bookingType, setBookingType] = useState<BookingType | "">(defaultType);
  const [offeringSlug] = useState<string>(initialOfferingSlug || "");
  const [slots, setSlots] = useState<BookingSlot[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<string>("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const marketingConsentText = settings.marketingOptInLabel || "I would like to receive updates and offers.";

  const [isLoadingSlots, setIsLoadingSlots] = useState(!!defaultType && !hasPaidTrainingOrder);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitStatus, setSubmitStatus] = useState<"idle" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");

  const [isScriptReady, setIsScriptReady] = useState(false);
  const [checkoutToken, setCheckoutToken] = useState<string | null>(null);
  const [paymentOption, setPaymentOption] = useState<"deposit" | "full" | "customPartial">("full");
  const [customAmount, setCustomAmount] = useState<string>("");

  const activeTypeConfig = useMemo(() => {
    return settings.bookingTypes.find((t) => t.type === bookingType);
  }, [bookingType, settings.bookingTypes]);

  const hasValidPaidTrainingEmail = !hasPaidTrainingOrder || isLikelyEmail(email);
  const availabilityEmail = hasPaidTrainingOrder ? email : "";

  useEffect(() => {
    if (!bookingType) {
      return;
    }

    if (!hasValidPaidTrainingEmail) {
      return;
    }

    let isMounted = true;

    fetchAvailability({
      bookingType: bookingType as BookingType,
      email: availabilityEmail,
      hasPaidTrainingOrder,
      paidTrainingOrder,
      offeringSlug,
    })
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(typeof data.error === "string" ? data.error : "Failed to fetch availability");
        }
        return res.json();
      })
      .then((data) => {
        if (isMounted) {
          setSlots(data.slots || []);
          setSelectedSlot("");
          setIsLoadingSlots(false);
        }
      })
      .catch((error: unknown) => {
        if (isMounted) {
          setErrorMessage(error instanceof Error ? error.message : "Could not load available times. Please try again later.");
          setIsLoadingSlots(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [bookingType, availabilityEmail, hasPaidTrainingOrder, hasValidPaidTrainingEmail, paidTrainingOrder, offeringSlug]);

  useEffect(() => {
    if (!checkoutToken) return;

    const handleMessage = async (event: MessageEvent) => {
      if (event.origin !== "https://secure.helcim.app") {
        return;
      }

      let parsedData: unknown;
      try {
        parsedData = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
      } catch {
        return;
      }

      if (!parsedData || typeof parsedData !== "object") return;
      const dataObj = parsedData as Record<string, unknown>;

      if (dataObj.eventName !== `helcim-pay-js-${checkoutToken}`) {
        return;
      }

      if (dataObj.eventStatus === "ABORTED" || dataObj.eventStatus === "HIDE") {
        if (window.removeHelcimPayIframe) {
          window.removeHelcimPayIframe();
        }
        setCheckoutToken(null);
        setIsSubmitting(false);
        return;
      }

      if (dataObj.eventStatus === "SUCCESS") {
        let payloadData: Record<string, HelcimPayloadValue> | undefined;
        let payloadHash: string | undefined;
        let eventMessage = dataObj.eventMessage;

        if (typeof eventMessage === "string") {
          try {
            eventMessage = JSON.parse(eventMessage);
          } catch {
            setErrorMessage("Payment could not be verified. Please contact Lash Her before retrying.");
            setIsSubmitting(false);
            return;
          }
        }

        if (eventMessage && typeof eventMessage === "object") {
          const msgObj = eventMessage as Record<string, unknown>;

          if (msgObj.data && typeof msgObj.data === "object" && "hash" in msgObj.data) {
            const innerData = msgObj.data as Record<string, unknown>;
            payloadData = parsePayloadData(innerData.data);
            payloadHash = typeof innerData.hash === "string" ? innerData.hash : undefined;
          } else if (msgObj.data && typeof msgObj.data === "object" && typeof msgObj.hash === "string") {
            payloadData = parsePayloadData(msgObj.data);
            payloadHash = msgObj.hash;
          }
        }

        if (!payloadData || !payloadHash) {
          setErrorMessage("Payment could not be verified. Please contact Lash Her before retrying.");
          setIsSubmitting(false);
          return;
        }

        try {
          const response = await fetch("/api/checkout/validate-payment", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              checkoutToken,
              data: payloadData,
              hash: payloadHash,
            }),
          });

          if (!response.ok) {
            setErrorMessage("Payment could not be verified. Please contact Lash Her before retrying.");
            setIsSubmitting(false);
            return;
          }

          const result = await response.json() as { redirectUrl?: string };

          if (window.removeHelcimPayIframe) {
            window.removeHelcimPayIframe();
          }

          setSubmitStatus("success");
          setIsSubmitting(false);

          if (result.redirectUrl) {
            router.push(result.redirectUrl);
          }
        } catch {
          setErrorMessage("Payment could not be verified. Please contact Lash Her before retrying.");
          setIsSubmitting(false);
        }
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [checkoutToken, router]);

  const handleEmailChange = (value: string) => {
    setEmail(value);

    if (!hasPaidTrainingOrder) {
      return;
    }

    const hasValidEmail = isLikelyEmail(value);
    setIsLoadingSlots(hasValidEmail);
    setErrorMessage("");

    if (!hasValidEmail) {
      setSlots([]);
      setSelectedSlot("");
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bookingType || !selectedSlot || !name || !email || !phone) {
      setErrorMessage("Please fill in all required fields.");
      return;
    }

    if (hasPaidTrainingOrder && !isLikelyEmail(email)) {
      setErrorMessage("Please enter the same email address used at checkout.");
      return;
    }

    if (offeringPayment && hasOffering && !hasPaidTrainingOrder) {
      let parsedCustomAmount: number | undefined;
      if (paymentOption === "customPartial") {
        parsedCustomAmount = parseFloat(customAmount);
        if (isNaN(parsedCustomAmount) || parsedCustomAmount <= 0) {
          setErrorMessage("Please enter a valid custom amount.");
          return;
        }
        if (parsedCustomAmount <= offeringPayment.depositAmount) {
          setErrorMessage(`Custom amount must be greater than the deposit of ${formatCad(offeringPayment.depositAmount)}.`);
          return;
        }
        if (parsedCustomAmount >= offeringPayment.fullPrice) {
          setErrorMessage(`Custom amount must be less than the full price of ${formatCad(offeringPayment.fullPrice)}.`);
          return;
        }
      }

      setIsSubmitting(true);
      setErrorMessage("");
      setSubmitStatus("idle");

      try {
        const holdRes = await fetch("/api/booking/holds", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            offeringSlug,
            start: selectedSlot,
            name,
            email,
            phone,
            paymentOption,
            ...(parsedCustomAmount ? { customAmount: parsedCustomAmount } : {}),
          }),
        });

        if (!holdRes.ok) {
          const data = await holdRes.json();
          throw new Error(data.error || "Failed to hold appointment time");
        }

        const holdData = await holdRes.json();
        const holdReference = holdData.hold.reference;

        const checkoutRes = await fetch("/api/booking/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            holdReference,
          }),
        });

        if (!checkoutRes.ok) {
          const data = await checkoutRes.json();
          throw new Error(data.error || "Failed to start checkout");
        }

        const checkoutData = await checkoutRes.json();
        
        if (!checkoutData.checkoutToken) {
          throw new Error("Failed to start checkout");
        }

        setCheckoutToken(checkoutData.checkoutToken);

        if (window.appendHelcimPayIframe) {
          window.appendHelcimPayIframe(checkoutData.checkoutToken, true);
        } else {
          throw new Error("Checkout is not available right now.");
        }
      } catch (err: unknown) {
        if (err instanceof Error) {
          setErrorMessage(err.message || "An error occurred while booking. Please try again.");
        } else {
          setErrorMessage("An error occurred while booking. Please try again.");
        }
        setSubmitStatus("error");
        setIsSubmitting(false);
      }
      return;
    }

    setIsSubmitting(true);
    setErrorMessage("");
    setSubmitStatus("idle");

    const formattedAnswers: BookingAnswerInput[] = Object.entries(answers).map(([questionId, answer]) => ({
      questionId,
      answer,
    }));

    try {
      const res = await fetch("/api/booking/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bookingType,
          start: selectedSlot,
          name,
          email,
          phone,
          answers: formattedAnswers,
          marketingOptIn,
          marketingConsentText,
          sourcePath: pathname,
          idempotencyKey: nanoid(),
          ...(hasPaidTrainingOrder && paidTrainingOrder
            ? { paidTrainingOrderId: paidTrainingOrder }
            : {}),
          ...(offeringSlug ? { offeringSlug } : {}),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to create booking");
      }

      setSubmitStatus("success");
    } catch (err: unknown) {
      if (err instanceof Error) {
        setErrorMessage(err.message || "An error occurred while booking. Please try again.");
      } else {
        setErrorMessage("An error occurred while booking. Please try again.");
      }
      setSubmitStatus("error");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (submitStatus === "success") {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center" aria-live="polite">
        <h2 className="text-2xl font-medium text-primary mb-4">Booking Confirmed</h2>
        <p className="text-muted-foreground">
          Your booking is confirmed. Check your email for details and a Google Calendar invitation.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-2xl mx-auto space-y-8">
      <Script
        src="https://secure.helcim.app/helcim-pay/services/start.js"
        strategy="afterInteractive"
        onLoad={() => setIsScriptReady(true)}
      />
      <div aria-live="polite" className="sr-only">
        {errorMessage && `Error: ${errorMessage}`}
        {isLoadingSlots && "Loading available times..."}
      </div>

      <Field>
        <FieldLabel htmlFor="bookingType">Service Type</FieldLabel>
        <Select
          value={bookingType}
          disabled={hasPaidTrainingOrder || hasOffering}
          onValueChange={(val) => {
            setBookingType(val as BookingType);
            if (!val) {
              setSlots([]);
              setSelectedSlot("");
              setIsLoadingSlots(false);
            } else {
              setIsLoadingSlots(!hasPaidTrainingOrder || isLikelyEmail(email));
              setErrorMessage("");
            }
          }}
        >
          <SelectTrigger id="bookingType">
            <SelectValue placeholder="Select a service" />
          </SelectTrigger>
          <SelectContent>
            {settings.bookingTypes.map((type) => (
              <SelectItem key={type.type} value={type.type}>
                {type.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {activeTypeConfig?.description && (
          <FieldDescription>{activeTypeConfig.description}</FieldDescription>
        )}
        {hasPaidTrainingOrder && (
          <FieldDescription>
            This paid training call is reserved for the checkout email used on order {paidTrainingOrder}.
          </FieldDescription>
        )}
      </Field>

      {hasPaidTrainingOrder && (
        <Field>
          <FieldLabel htmlFor="email">Checkout Email</FieldLabel>
          <Input
            id="email"
            type="email"
            required
            value={email}
            onChange={(event) => handleEmailChange(event.target.value)}
            placeholder="jane@example.com"
          />
          <FieldDescription>Enter the same email address used at checkout to unlock available training call times.</FieldDescription>
        </Field>
      )}

      {bookingType && (
        <Field>
          <FieldLabel htmlFor="selectedSlot">Available Times</FieldLabel>
          <Select
            value={selectedSlot}
            onValueChange={setSelectedSlot}
            disabled={isLoadingSlots || slots.length === 0 || !hasValidPaidTrainingEmail}
          >
            <SelectTrigger id="selectedSlot">
              <SelectValue placeholder={getSlotPlaceholder({ hasValidPaidTrainingEmail, isLoadingSlots, slots })} />
            </SelectTrigger>
            <SelectContent>
              {slots.map((slot) => {
                const date = new Date(slot.start);
                const formatted = new Intl.DateTimeFormat("en-US", {
                  timeZone: settings.timezone,
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                  timeZoneName: "short",
                }).format(date);
                return (
                  <SelectItem key={slot.start} value={slot.start}>
                    {formatted}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          <FieldDescription>All times are shown in {settings.timezone}.</FieldDescription>
        </Field>
      )}

      {errorMessage && !selectedSlot && (
        <FieldError className="text-center">{errorMessage}</FieldError>
      )}

      {selectedSlot && (
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Field>
              <FieldLabel htmlFor="name">Full Name</FieldLabel>
              <Input
                id="name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Jane Doe"
              />
            </Field>
            {!hasPaidTrainingOrder && (
              <Field>
                <FieldLabel htmlFor="email">Email Address</FieldLabel>
                <Input
                  id="email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => handleEmailChange(e.target.value)}
                  placeholder="jane@example.com"
                />
              </Field>
            )}
          </div>

          <Field>
            <FieldLabel htmlFor="phone">Phone Number</FieldLabel>
            <Input
              id="phone"
              type="tel"
              required
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="(555) 123-4567"
            />
          </Field>

          {shouldCollectIntake && activeTypeConfig?.questions.map((q) => (
            <Field key={q.id}>
              <FieldLabel htmlFor={q.id}>{q.label}</FieldLabel>
              {q.inputType === "textarea" ? (
                <Textarea
                  id={q.id}
                  required={q.required}
                  value={answers[q.id] || ""}
                  onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
                />
              ) : q.inputType === "select" && q.options ? (
                <Select
                  value={answers[q.id] || ""}
                  onValueChange={(val) => setAnswers({ ...answers, [q.id]: val })}
                >
                  <SelectTrigger id={q.id}>
                    <SelectValue placeholder="Select an option" />
                  </SelectTrigger>
                  <SelectContent>
                    {q.options.map((opt) => (
                      <SelectItem key={opt} value={opt}>
                        {opt}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id={q.id}
                  required={q.required}
                  value={answers[q.id] || ""}
                  onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
                />
              )}
            </Field>
          ))}

          {shouldCollectIntake && <div className="flex items-start gap-3 pt-4">
            <input
              type="checkbox"
              id="marketingOptIn"
              checked={marketingOptIn}
              onChange={(e) => setMarketingOptIn(e.target.checked)}
              className="mt-1 h-4 w-4 rounded border-input text-primary focus:ring-primary"
            />
            <label htmlFor="marketingOptIn" className="text-sm text-muted-foreground leading-snug">
              {marketingConsentText}
            </label>
          </div>}

          {offeringPayment && (
            <div className="pt-4 border-t border-border/50">
              <h3 className="text-lg font-medium text-primary mb-4">Payment Details</h3>
              <p className="text-muted-foreground mb-4">
                Choose the amount you would like to pay now. Your appointment is valid with the deposit, the full price, or any amount between them.
              </p>
              <div className="space-y-4">
                <Field>
                  <FieldLabel>Payment Option</FieldLabel>
                  <Select
                    value={paymentOption}
                    onValueChange={(val) => setPaymentOption(val as "deposit" | "full" | "customPartial")}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select payment option" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="deposit">Pay Deposit ({formatCad(offeringPayment.depositAmount)})</SelectItem>
                      <SelectItem value="full">Pay in Full ({formatCad(offeringPayment.fullPrice)})</SelectItem>
                      <SelectItem value="customPartial">Pay Custom Amount</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                {paymentOption === "customPartial" && (
                  <Field>
                    <FieldLabel htmlFor="customAmount">Custom Amount (CAD)</FieldLabel>
                    <Input
                      id="customAmount"
                      type="number"
                      step="0.01"
                      min={offeringPayment.depositAmount}
                      max={offeringPayment.fullPrice}
                      value={customAmount}
                      onChange={(e) => setCustomAmount(e.target.value)}
                      placeholder={`Between ${formatCad(offeringPayment.depositAmount)} and ${formatCad(offeringPayment.fullPrice)}`}
                      required
                    />
                    <FieldDescription>
                      Enter an amount greater than {formatCad(offeringPayment.depositAmount)} and less than {formatCad(offeringPayment.fullPrice)}.
                    </FieldDescription>
                  </Field>
                )}
              </div>
            </div>
          )}

          {errorMessage && (
            <FieldError className="text-center">{errorMessage}</FieldError>
          )}

          <Button type="submit" className="w-full" disabled={isSubmitting || (offeringPayment && !isScriptReady)}>
            {isSubmitting ? "Confirming..." : "Confirm Booking"}
          </Button>
        </div>
      )}
    </form>
  );
}

function fetchAvailability(input: {
  bookingType: BookingType;
  email: string;
  hasPaidTrainingOrder: boolean;
  paidTrainingOrder: string | undefined;
  offeringSlug?: string;
}): Promise<Response> {
  if (input.hasPaidTrainingOrder && input.paidTrainingOrder) {
    return fetch("/api/booking/availability", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        type: input.bookingType,
        order: input.paidTrainingOrder,
        email: input.email.trim(),
      }),
    });
  }

  const availabilityParams = new URLSearchParams();
  if (input.offeringSlug) {
    availabilityParams.set("offering", input.offeringSlug);
  } else if (input.bookingType) {
    availabilityParams.set("type", input.bookingType);
  }
  return fetch(`/api/booking/availability?${availabilityParams.toString()}`);
}

function isLikelyEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function isHelcimPayloadValue(value: unknown): value is HelcimPayloadValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function parsePayloadData(value: unknown): Record<string, HelcimPayloadValue> | undefined {
  if (!value || typeof value !== "object") return undefined;

  const entries = Object.entries(value as Record<string, unknown>);

  if (entries.some(([, entryValue]) => !isHelcimPayloadValue(entryValue))) {
    return undefined;
  }

  return Object.fromEntries(entries) as Record<string, HelcimPayloadValue>;
}

function getSlotPlaceholder(input: {
  hasValidPaidTrainingEmail: boolean;
  isLoadingSlots: boolean;
  slots: BookingSlot[];
}): string {
  if (!input.hasValidPaidTrainingEmail) {
    return "Enter checkout email first";
  }

  if (input.isLoadingSlots) {
    return "Loading...";
  }

  return input.slots.length === 0 ? "No times available" : "Select a time";
}
