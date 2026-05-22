"use client";

import { useState, useEffect, useMemo } from "react";
import { nanoid } from "nanoid";
import Script from "next/script";
import { usePathname, useRouter } from "next/navigation";
import type { BookingSettings, BookingType, BookingSlot, BookingAnswerInput } from "@/lib/booking/types";
import type { TBookingOffering } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, FieldLabel, FieldError, FieldDescription } from "@/components/ui/field";
import { formatCad } from "@/lib/commerce/money";
import type { HelcimPayloadValue } from "@/lib/commerce/helcim-types";

type PaidOfferingPaymentOption = "deposit" | "full" | "customPartial";

interface PaidOfferingCheckoutInput {
  offeringSlug: string;
  start: string;
  name: string;
  email: string;
  phone: string;
  paymentOption: PaidOfferingPaymentOption;
  customAmount?: number;
  fetcher?: typeof fetch;
}

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
  offerings?: TBookingOffering[];
}

export function BookingFlow({ settings, initialBookingType, paidTrainingOrderId, initialOfferingSlug, offeringPayment, offerings = [] }: BookingFlowProps) {
  const pathname = usePathname();
  const router = useRouter();
  
  const paidTrainingOrder = paidTrainingOrderId?.trim();
  const hasPaidTrainingOrder = paidTrainingOrder !== undefined && paidTrainingOrder.length > 0;
  const hasOffering = Boolean(initialOfferingSlug);
  
  const [step, setStep] = useState<"service" | "datetime" | "details">(
    (hasPaidTrainingOrder || hasOffering || initialBookingType) ? "datetime" : "service"
  );
  const [selectedOfferingSlug, setSelectedOfferingSlug] = useState<string>(initialOfferingSlug || "");
  
  const currentOffering = useMemo(() => {
    return offerings.find(o => o.slug === selectedOfferingSlug);
  }, [offerings, selectedOfferingSlug]);

  const currentOfferingPayment = currentOffering ? {
    depositAmount: currentOffering.depositAmount,
    fullPrice: currentOffering.fullPrice,
    currency: currentOffering.currency as "CAD",
  } : offeringPayment;

  const currentBookingType = hasPaidTrainingOrder 
    ? "training-call" 
    : (currentOffering?.bookingType || initialBookingType || settings.bookingTypes[0]?.type || "training-call");

  const isPaidOfferingCheckout = currentOfferingPayment !== undefined && Boolean(selectedOfferingSlug) && !hasPaidTrainingOrder;
  const shouldCollectIntake = !isPaidOfferingCheckout;

  const [slots, setSlots] = useState<BookingSlot[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<string>("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const marketingConsentText = settings.marketingOptInLabel || "I would like to receive updates and offers.";

  const [isLoadingSlots, setIsLoadingSlots] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitStatus, setSubmitStatus] = useState<"idle" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");

  const [isScriptReady, setIsScriptReady] = useState(false);
  const [checkoutToken, setCheckoutToken] = useState<string | null>(null);
  const [paymentOption, setPaymentOption] = useState<PaidOfferingPaymentOption>("full");
  const [customAmount, setCustomAmount] = useState<string>("");

  const activeTypeConfig = useMemo(() => {
    return settings.bookingTypes.find((t) => t.type === currentBookingType);
  }, [currentBookingType, settings.bookingTypes]);

  const hasValidPaidTrainingEmail = !hasPaidTrainingOrder || isLikelyEmail(email);
  const availabilityEmail = hasPaidTrainingOrder ? email : "";

  useEffect(() => {
    if (step !== "datetime") return;
    if (!currentBookingType) return;
    if (!hasValidPaidTrainingEmail) return;

    let isMounted = true;

    const loadSlots = async () => {
      setIsLoadingSlots(true);
      setErrorMessage("");
      try {
        const res = await fetchAvailability({
          bookingType: currentBookingType as BookingType,
          email: availabilityEmail,
          hasPaidTrainingOrder,
          paidTrainingOrder,
          offeringSlug: selectedOfferingSlug,
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(typeof data.error === "string" ? data.error : "Failed to fetch availability");
        }
        const data = await res.json();
        if (isMounted) {
          setSlots(data.slots || []);
          setSelectedSlot("");
          setErrorMessage("");
          setIsLoadingSlots(false);
        }
      } catch (error: unknown) {
        if (isMounted) {
          setErrorMessage(error instanceof Error ? error.message : "Could not load available times. Please try again later.");
          setSlots([]);
          setSelectedSlot("");
          setIsLoadingSlots(false);
        }
      }
    };

    loadSlots();

    return () => {
      isMounted = false;
    };
  }, [step, currentBookingType, availabilityEmail, hasPaidTrainingOrder, hasValidPaidTrainingEmail, paidTrainingOrder, selectedOfferingSlug]);

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
    if (!currentBookingType || !selectedSlot || !name || !email || !phone) {
      setErrorMessage("Please fill in all required fields.");
      return;
    }

    if (hasPaidTrainingOrder && !isLikelyEmail(email)) {
      setErrorMessage("Please enter the same email address used at checkout.");
      return;
    }

    if (currentOfferingPayment && Boolean(selectedOfferingSlug) && !hasPaidTrainingOrder) {
      let parsedCustomAmount: number | undefined;
      if (paymentOption === "customPartial") {
        parsedCustomAmount = parseFloat(customAmount);
        if (isNaN(parsedCustomAmount) || parsedCustomAmount <= 0) {
          setErrorMessage("Please enter a valid custom amount.");
          return;
        }
        if (parsedCustomAmount <= currentOfferingPayment.depositAmount) {
          setErrorMessage(`Custom amount must be greater than the deposit of ${formatCad(currentOfferingPayment.depositAmount)}.`);
          return;
        }
        if (parsedCustomAmount >= currentOfferingPayment.fullPrice) {
          setErrorMessage(`Custom amount must be less than the full price of ${formatCad(currentOfferingPayment.fullPrice)}.`);
          return;
        }
      }

      setIsSubmitting(true);
      setErrorMessage("");
      setSubmitStatus("idle");

      try {
        const checkoutToken = await startPaidOfferingCheckout({
          offeringSlug: selectedOfferingSlug,
          start: selectedSlot,
          name,
          email,
          phone,
          paymentOption,
          ...(parsedCustomAmount ? { customAmount: parsedCustomAmount } : {}),
        });

        setCheckoutToken(checkoutToken);

        if (window.appendHelcimPayIframe) {
          window.appendHelcimPayIframe(checkoutToken, true);
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
          bookingType: currentBookingType,
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
          ...(selectedOfferingSlug ? { offeringSlug: selectedOfferingSlug } : {}),
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

  const slotsByDate = useMemo(() => {
    const grouped: Record<string, BookingSlot[]> = {};
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: settings.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    
    slots.forEach(slot => {
      const dateObj = new Date(slot.start);
      const parts = formatter.formatToParts(dateObj);
      const year = parts.find(p => p.type === 'year')?.value;
      const month = parts.find(p => p.type === 'month')?.value;
      const day = parts.find(p => p.type === 'day')?.value;
      const dateStr = `${year}-${month}-${day}`;
      
      if (!grouped[dateStr]) grouped[dateStr] = [];
      grouped[dateStr].push(slot);
    });
    return grouped;
  }, [slots, settings.timezone]);

  const availableDates = Object.keys(slotsByDate).sort();
  const [selectedDateState, setSelectedDateState] = useState<string>("");
  
  const selectedDate = (availableDates.length > 0 && !availableDates.includes(selectedDateState)) 
    ? availableDates[0] 
    : selectedDateState;

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

  if (step === "service") {
    return (
      <div className="flex flex-col lg:flex-row gap-8">
        <div className="flex-1">
          <h1 className="text-3xl font-serif text-black mb-6">Select Service</h1>
          <div className="flex gap-2 mb-6 overflow-x-auto pb-2">
            <div className="px-4 py-2 bg-lh-primary text-white rounded-full text-sm font-medium whitespace-nowrap">
              All Services
            </div>
            <div className="px-4 py-2 bg-white border border-lh-line text-lh-muted rounded-full text-sm font-medium whitespace-nowrap">
              Nataliea
            </div>
          </div>
          <div className="space-y-4">
            {offerings.length === 0 ? (
              <div className="bg-white p-6 rounded-xl border border-lh-line text-center text-lh-muted">
                We are currently updating our services. Please check back later.
              </div>
            ) : offerings.map((offering) => {
              const isSelected = selectedOfferingSlug === offering.slug;
              return (
                <button 
                  key={offering._id} 
                  type="button"
                  aria-pressed={isSelected}
                  className={`w-full text-left editorial-card p-6 flex justify-between items-center cursor-pointer hover:border-lh-primary transition-colors ${isSelected ? 'border-lh-primary ring-1 ring-lh-primary' : ''}`} 
                  onClick={() => setSelectedOfferingSlug(offering.slug)}
                >
                  <div>
                    <h3 className="text-lg font-medium text-black mb-1">{offering.title}</h3>
                    <p className="text-sm text-lh-muted mb-2">{offering.durationMinutes} min</p>
                    <p className="text-sm text-black font-light max-w-md">{offering.description}</p>
                  </div>
                  <div className="flex flex-col items-end gap-3">
                    <span className="font-medium text-black">{formatCad(offering.fullPrice)}</span>
                    <div className={`w-8 h-8 rounded-full border flex items-center justify-center ${isSelected ? 'bg-lh-primary border-lh-primary text-white' : 'border-lh-line text-lh-primary'}`} aria-hidden="true">
                      {isSelected ? '✓' : '+'}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
        <div className="w-full lg:w-80 shrink-0">
          <div className="bg-white p-6 rounded-xl border border-lh-line sticky top-24">
            <h2 className="text-xl font-serif text-black mb-4">Summary</h2>
            {currentOffering ? (
              <div className="space-y-4">
                <div className="flex justify-between text-sm">
                  <span className="text-black font-medium">{currentOffering.title}</span>
                  <span className="text-black">{formatCad(currentOffering.fullPrice)}</span>
                </div>
                <div className="text-sm text-lh-muted">{currentOffering.durationMinutes} min</div>
                <div className="pt-4 border-t border-lh-line">
                  <div className="flex justify-between font-medium text-black">
                    <span>Total</span>
                    <span>{formatCad(currentOffering.fullPrice)}</span>
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-sm text-lh-muted">Select a service to continue.</p>
            )}
            <Button 
              className="w-full mt-6" 
              disabled={!selectedOfferingSlug}
              onClick={() => setStep("datetime")}
            >
              Continue
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (step === "datetime") {
    return (
      <div className="flex flex-col lg:flex-row gap-8">
        <div className="flex-1">
          <div className="flex items-center gap-4 mb-6">
            {!hasPaidTrainingOrder && !hasOffering && (
              <button onClick={() => setStep("service")} className="text-lh-muted hover:text-black">
                ← Back
              </button>
            )}
            <h1 className="text-3xl font-serif text-black">Select Time</h1>
          </div>

          {hasPaidTrainingOrder && (
            <div className="mb-8 bg-white p-6 rounded-xl border border-lh-line">
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
            </div>
          )}

          {isLoadingSlots ? (
            <div className="py-12 text-center text-lh-muted">Loading available times...</div>
          ) : errorMessage ? (
            <FieldError className="py-12 text-center">{errorMessage}</FieldError>
          ) : slots.length === 0 ? (
            <div className="py-12 text-center text-lh-muted">
              {hasPaidTrainingOrder && !hasValidPaidTrainingEmail 
                ? "Enter your checkout email to see available times." 
                : "No times available for this service."}
            </div>
          ) : (
            <div className="space-y-6">
              <div className="flex gap-2 overflow-x-auto pb-2">
                {availableDates.map(dateStr => {
                  const firstSlot = slotsByDate[dateStr]?.[0];
                  if (!firstSlot) return null;
                  
                  const dateObj = new Date(firstSlot.start);
                  const dayName = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: settings.timezone }).format(dateObj);
                  const dayNum = new Intl.DateTimeFormat("en-US", { day: "numeric", timeZone: settings.timezone }).format(dateObj);
                  const monthName = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: settings.timezone }).format(dateObj);
                  const isSelected = selectedDate === dateStr;
                  
                  return (
                    <button
                      key={dateStr}
                      onClick={() => setSelectedDateState(dateStr)}
                      className={`flex flex-col items-center justify-center min-w-[4.5rem] p-3 rounded-xl border ${isSelected ? 'bg-lh-primary border-lh-primary text-white' : 'bg-white border-lh-line text-black hover:border-lh-primary'} transition-colors`}
                    >
                      <span className="text-xs uppercase tracking-wider mb-1">{dayName}</span>
                      <span className="text-xl font-medium">{dayNum}</span>
                      <span className="text-xs">{monthName}</span>
                    </button>
                  );
                })}
              </div>

              <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                {slotsByDate[selectedDate]?.map(slot => {
                  const dateObj = new Date(slot.start);
                  const timeStr = new Intl.DateTimeFormat("en-US", {
                    hour: "numeric",
                    minute: "2-digit",
                    timeZone: settings.timezone,
                  }).format(dateObj);
                  const isSelected = selectedSlot === slot.start;

                  return (
                    <button
                      key={slot.start}
                      onClick={() => setSelectedSlot(slot.start)}
                      className={`py-3 px-2 rounded-lg border text-sm font-medium text-center ${isSelected ? 'bg-lh-primary border-lh-primary text-white' : 'bg-white border-lh-line text-black hover:border-lh-primary'} transition-colors`}
                    >
                      {timeStr}
                    </button>
                  );
                })}
              </div>
              <p className="text-sm text-lh-muted mt-4">All times are shown in {settings.timezone}.</p>
            </div>
          )}
        </div>

        <div className="w-full lg:w-80 shrink-0">
          <div className="bg-white p-6 rounded-xl border border-lh-line sticky top-24">
            <h2 className="text-xl font-serif text-black mb-4">Summary</h2>
            {currentOffering ? (
              <div className="space-y-4">
                <div className="flex justify-between text-sm">
                  <span className="text-black font-medium">{currentOffering.title}</span>
                  <span className="text-black">{formatCad(currentOffering.fullPrice)}</span>
                </div>
                <div className="text-sm text-lh-muted">{currentOffering.durationMinutes} min</div>
                
                {selectedSlot && (
                  <div className="pt-4 border-t border-lh-line">
                    <p className="text-sm font-medium text-black mb-1">Selected Time</p>
                    <p className="text-sm text-lh-muted">
                      {new Intl.DateTimeFormat("en-US", {
                        weekday: "long",
                        month: "long",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                        timeZone: settings.timezone,
                      }).format(new Date(selectedSlot))}
                    </p>
                  </div>
                )}

                <div className="pt-4 border-t border-lh-line">
                  <div className="flex justify-between font-medium text-black">
                    <span>Total</span>
                    <span>{formatCad(currentOffering.fullPrice)}</span>
                  </div>
                </div>
              </div>
            ) : (hasPaidTrainingOrder || initialBookingType) ? (
              <div className="space-y-4">
                <div className="text-sm text-black font-medium">{activeTypeConfig?.label || "Appointment"}</div>
                {selectedSlot && (
                  <div className="pt-4 border-t border-lh-line">
                    <p className="text-sm font-medium text-black mb-1">Selected Time</p>
                    <p className="text-sm text-lh-muted">
                      {new Intl.DateTimeFormat("en-US", {
                        weekday: "long",
                        month: "long",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                        timeZone: settings.timezone,
                      }).format(new Date(selectedSlot))}
                    </p>
                  </div>
                )}
              </div>
            ) : null}
            <Button 
              className="w-full mt-6" 
              disabled={!selectedSlot}
              onClick={() => setStep("details")}
            >
              Continue
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col lg:flex-row gap-8">
      <div className="flex-1">
        <div className="flex items-center gap-4 mb-6">
          <button onClick={() => setStep("datetime")} className="text-lh-muted hover:text-black">
            ← Back
          </button>
          <h1 className="text-3xl font-serif text-black">Your Details</h1>
        </div>
        
        <form onSubmit={handleSubmit} className="space-y-8 bg-white p-6 rounded-xl border border-lh-line">
          <Script
            src="https://secure.helcim.app/helcim-pay/services/start.js"
            strategy="afterInteractive"
            onLoad={() => setIsScriptReady(true)}
          />
          <div aria-live="polite" className="sr-only">
            {errorMessage && `Error: ${errorMessage}`}
          </div>

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

          {currentOfferingPayment && (
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
                    onValueChange={(val) => setPaymentOption(val as PaidOfferingPaymentOption)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select payment option" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="deposit">Pay Deposit ({formatCad(currentOfferingPayment.depositAmount)})</SelectItem>
                      <SelectItem value="full">Pay in Full ({formatCad(currentOfferingPayment.fullPrice)})</SelectItem>
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
                      min={currentOfferingPayment.depositAmount}
                      max={currentOfferingPayment.fullPrice}
                      value={customAmount}
                      onChange={(e) => setCustomAmount(e.target.value)}
                      placeholder={`Between ${formatCad(currentOfferingPayment.depositAmount)} and ${formatCad(currentOfferingPayment.fullPrice)}`}
                      required
                    />
                    <FieldDescription>
                      Enter an amount greater than {formatCad(currentOfferingPayment.depositAmount)} and less than {formatCad(currentOfferingPayment.fullPrice)}.
                    </FieldDescription>
                  </Field>
                )}
              </div>
            </div>
          )}

          {errorMessage && (
            <FieldError className="text-center">{errorMessage}</FieldError>
          )}

          <Button type="submit" className="w-full" disabled={isSubmitting || (currentOfferingPayment && !isScriptReady)}>
            {isSubmitting ? "Confirming..." : "Confirm Booking"}
          </Button>
        </form>
      </div>
      
      <div className="w-full lg:w-80 shrink-0">
        <div className="bg-white p-6 rounded-xl border border-lh-line sticky top-24">
          <h2 className="text-xl font-serif text-black mb-4">Summary</h2>
          {currentOffering ? (
            <div className="space-y-4">
              <div className="flex justify-between text-sm">
                <span className="text-black font-medium">{currentOffering.title}</span>
                <span className="text-black">{formatCad(currentOffering.fullPrice)}</span>
              </div>
              <div className="text-sm text-lh-muted">{currentOffering.durationMinutes} min</div>
              
              {selectedSlot && (
                <div className="pt-4 border-t border-lh-line">
                  <p className="text-sm font-medium text-black mb-1">Selected Time</p>
                  <p className="text-sm text-lh-muted">
                    {new Intl.DateTimeFormat("en-US", {
                      weekday: "long",
                      month: "long",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                      timeZone: settings.timezone,
                    }).format(new Date(selectedSlot))}
                  </p>
                </div>
              )}

              <div className="pt-4 border-t border-lh-line">
                <div className="flex justify-between font-medium text-black">
                  <span>Total</span>
                  <span>{formatCad(currentOffering.fullPrice)}</span>
                </div>
              </div>
            </div>
            ) : (hasPaidTrainingOrder || initialBookingType) ? (
              <div className="space-y-4">
                <div className="text-sm text-black font-medium">{activeTypeConfig?.label || "Appointment"}</div>
                {selectedSlot && (
                  <div className="pt-4 border-t border-lh-line">
                    <p className="text-sm font-medium text-black mb-1">Selected Time</p>
                    <p className="text-sm text-lh-muted">
                      {new Intl.DateTimeFormat("en-US", {
                        weekday: "long",
                        month: "long",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                        timeZone: settings.timezone,
                      }).format(new Date(selectedSlot))}
                    </p>
                  </div>
                )}
              </div>
            ) : null}
        </div>
      </div>
    </div>
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

export async function startPaidOfferingCheckout(input: PaidOfferingCheckoutInput): Promise<string> {
  const fetcher = input.fetcher ?? fetch;
  const holdRes = await fetcher("/api/booking/holds", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      offeringSlug: input.offeringSlug,
      start: input.start,
      name: input.name,
      email: input.email,
      phone: input.phone,
      paymentOption: input.paymentOption,
      ...(input.customAmount ? { customAmount: input.customAmount } : {}),
    }),
  });

  if (!holdRes.ok) {
    const data = await holdRes.json();
    throw new Error(readResponseError(data, "Failed to hold appointment time"));
  }

  const holdData = await holdRes.json() as { hold?: { reference?: unknown } };
  const holdReference = holdData.hold?.reference;

  if (typeof holdReference !== "string" || holdReference.length === 0) {
    throw new Error("Failed to hold appointment time");
  }

  const checkoutRes = await fetcher("/api/booking/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      holdReference,
    }),
  });

  if (!checkoutRes.ok) {
    const data = await checkoutRes.json();
    throw new Error(readResponseError(data, "Failed to start checkout"));
  }

  const checkoutData = await checkoutRes.json() as { checkoutToken?: unknown };

  if (typeof checkoutData.checkoutToken !== "string" || checkoutData.checkoutToken.length === 0) {
    throw new Error("Failed to start checkout");
  }

  return checkoutData.checkoutToken;
}

function readResponseError(data: unknown, fallback: string): string {
  if (data && typeof data === "object" && "error" in data) {
    const error = (data as { error?: unknown }).error;
    if (typeof error === "string" && error.length > 0) {
      return error;
    }
  }

  return fallback;
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
