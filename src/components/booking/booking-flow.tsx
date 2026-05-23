"use client";

import { useState, useEffect, useMemo } from "react";
import { nanoid } from "nanoid";
import { usePathname } from "next/navigation";
import type { BookingSettings, BookingType, BookingSlot, BookingAnswerInput } from "@/lib/booking/types";
import type { TBookingOffering } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, FieldLabel, FieldError, FieldDescription } from "@/components/ui/field";
import { formatCad } from "@/lib/commerce/money";

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

interface PaidOfferingCheckoutResult {
  checkoutUrl: string;
  holdReference: string;
  orderId: string;
  paymentProvider: "square";
  reused: boolean;
  squareOrderId?: string;
  squarePaymentLinkId?: string;
}

type SquareCheckoutStatus = "idle" | "opening" | "expired";

class BookingHoldExpiredError extends Error {
  constructor() {
    super("Hold expired, choose another time.");
    this.name = "BookingHoldExpiredError";
  }
}

interface BookingFlowProps {
  settings: BookingSettings;
  initialBookingType?: BookingType;
  paidTrainingOrderId?: string;
  paidSchedulingToken?: string;
  paidTrainingSlug?: string;
  initialOfferingSlug?: string;
  offeringPayment?: {
    depositAmount: number;
    fullPrice: number;
    currency: "CAD";
  };
  offerings?: TBookingOffering[];
}

export function BookingFlow({ settings, initialBookingType, paidTrainingOrderId, paidSchedulingToken, paidTrainingSlug, initialOfferingSlug, offeringPayment, offerings = [] }: BookingFlowProps) {
  const pathname = usePathname();
  
  const paidTrainingOrder = paidTrainingOrderId?.trim();
  const hasPaidTrainingOrder = paidTrainingOrder !== undefined && paidTrainingOrder.length > 0;
  const hasPaidSchedulingToken = paidSchedulingToken !== undefined && paidSchedulingToken.trim().length > 0;
  const hasPaidTraining = hasPaidTrainingOrder || hasPaidSchedulingToken;
  const hasOffering = Boolean(initialOfferingSlug);
  
  const [step, setStep] = useState<"service" | "datetime" | "details">(
    (hasPaidTraining || hasOffering || initialBookingType) ? "datetime" : "service"
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

  const currentBookingType = hasPaidTraining 
    ? "training-call" 
    : (currentOffering?.bookingType || initialBookingType || settings.bookingTypes[0]?.type || "training-call");

  const isPaidOfferingCheckout = currentOfferingPayment !== undefined && Boolean(selectedOfferingSlug) && !hasPaidTraining;
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

  const [squareCheckout, setSquareCheckout] = useState<PaidOfferingCheckoutResult | null>(null);
  const [squareCheckoutStatus, setSquareCheckoutStatus] = useState<SquareCheckoutStatus>("idle");
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
          paidSchedulingToken,
          paidTrainingSlug,
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
  }, [step, currentBookingType, availabilityEmail, hasPaidTrainingOrder, hasValidPaidTrainingEmail, paidTrainingOrder, paidSchedulingToken, paidTrainingSlug, selectedOfferingSlug]);

  const resetSquareCheckoutState = () => {
    setSquareCheckout(null);
    setSquareCheckoutStatus("idle");
  };

  const handleSelectedSlotChange = (value: string) => {
    setSelectedSlot(value);
    resetSquareCheckoutState();
  };

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
    const isEmailRequired = !hasPaidTrainingOrder && !hasPaidSchedulingToken;
    if (!currentBookingType || !selectedSlot || !name || (isEmailRequired && !email) || !phone) {
      setErrorMessage("Please fill in all required fields.");
      return;
    }

    if (hasPaidTrainingOrder && !isLikelyEmail(email)) {
      setErrorMessage("Please enter the same email address used at checkout.");
      return;
    }

    if (currentOfferingPayment && Boolean(selectedOfferingSlug) && !hasPaidTraining) {
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
        const checkout = await startPaidOfferingCheckout({
          offeringSlug: selectedOfferingSlug,
          start: selectedSlot,
          name,
          email,
          phone,
          paymentOption,
          ...(parsedCustomAmount ? { customAmount: parsedCustomAmount } : {}),
        });

        setSquareCheckout(checkout);
        setSquareCheckoutStatus("opening");
        setIsSubmitting(false);
        window.location.assign(checkout.checkoutUrl);
      } catch (err: unknown) {
        if (err instanceof BookingHoldExpiredError) {
          setSquareCheckoutStatus("expired");
          setErrorMessage(err.message);
        } else if (err instanceof Error) {
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
          ...(hasPaidSchedulingToken && paidSchedulingToken
            ? { paidSchedulingToken, paidTrainingSlug }
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
        <h2 className="section-subheading mb-4 text-primary">Booking Confirmed</h2>
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
          <h1 className="section-heading mb-6 text-3xl md:text-3xl lg:text-3xl">Select Service</h1>
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
                    <h3 className="section-subheading mb-1 text-lg md:text-lg lg:text-lg">{offering.title}</h3>
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
            <h2 className="section-subheading mb-4 text-xl md:text-xl lg:text-xl">Summary</h2>
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
            <h1 className="section-heading text-3xl md:text-3xl lg:text-3xl">Select Time</h1>
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
                      onClick={() => handleSelectedSlotChange(slot.start)}
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
            <h2 className="section-subheading mb-4 text-xl md:text-xl lg:text-xl">Summary</h2>
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
          <h1 className="section-heading text-3xl md:text-3xl lg:text-3xl">Your Details</h1>
        </div>
        
        <form onSubmit={handleSubmit} className="space-y-8 bg-white p-6 rounded-xl border border-lh-line">
          <div aria-live="polite" className="sr-only">
            {errorMessage && `Error: ${errorMessage}`}
          </div>

          {squareCheckoutStatus !== "idle" && (
            <div
              role="status"
              aria-live="polite"
              className="rounded-[18px] border border-lh-line bg-lh-neutral-2 p-5 shadow-sm"
            >
              {squareCheckoutStatus === "expired" ? (
                <div className="space-y-3 text-center">
                  <p className="font-heading text-lg uppercase tracking-[0.12em] text-lh-accent">Hold expired, choose another time</p>
                  <p className="font-body text-sm font-bold leading-6 text-lh-muted">
                    That private hold closed before secure checkout opened. Please choose a fresh appointment time and we will create a new hold before payment.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setStep("datetime");
                      resetSquareCheckoutState();
                      setErrorMessage("");
                    }}
                  >
                    Choose another time
                  </Button>
                </div>
              ) : (
                <div className="space-y-3 text-center">
                  <p className="font-heading text-lg uppercase tracking-[0.12em] text-lh-primary">Opening secure Square checkout</p>
                  <p className="font-body text-sm font-bold leading-6 text-lh-muted">
                    Your appointment time is privately held while Square opens in this tab. If it does not open automatically, use the secure checkout link below.
                  </p>
                  {squareCheckout && (
                    <Button asChild type="button" variant="dark">
                      <a href={squareCheckout.checkoutUrl}>Continue to secure Square checkout</a>
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}

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
            {!hasPaidTrainingOrder && !hasPaidSchedulingToken && (
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
              <h3 className="section-subheading mb-4 text-lg text-primary md:text-lg lg:text-lg">Payment Details</h3>
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
            <FieldError role="alert" className="text-center">{errorMessage}</FieldError>
          )}

          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? "Creating private hold..." : currentOfferingPayment ? "Continue to secure Square checkout" : "Confirm Booking"}
          </Button>
        </form>
      </div>
      
      <div className="w-full lg:w-80 shrink-0">
        <div className="bg-white p-6 rounded-xl border border-lh-line sticky top-24">
          <h2 className="section-subheading mb-4 text-xl md:text-xl lg:text-xl">Summary</h2>
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
  paidSchedulingToken?: string;
  paidTrainingSlug?: string;
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

  if (input.paidSchedulingToken && input.paidTrainingSlug) {
    return fetch("/api/booking/availability", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        type: input.bookingType,
        token: input.paidSchedulingToken,
        slug: input.paidTrainingSlug,
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

export async function startPaidOfferingCheckout(input: PaidOfferingCheckoutInput): Promise<PaidOfferingCheckoutResult> {
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

    if (checkoutRes.status === 409) {
      throw new BookingHoldExpiredError();
    }

    throw new Error(readResponseError(data, "Failed to start checkout"));
  }

  const checkoutData = await checkoutRes.json() as Record<string, unknown>;

  if (checkoutData.paymentProvider !== "square" ||
    typeof checkoutData.checkoutUrl !== "string" ||
    checkoutData.checkoutUrl.length === 0 ||
    typeof checkoutData.holdReference !== "string" ||
    checkoutData.holdReference.length === 0 ||
    typeof checkoutData.orderId !== "string" ||
    checkoutData.orderId.length === 0 ||
    typeof checkoutData.reused !== "boolean") {
    throw new Error("Failed to start checkout");
  }

  return {
    checkoutUrl: checkoutData.checkoutUrl,
    holdReference: checkoutData.holdReference,
    orderId: checkoutData.orderId,
    paymentProvider: "square",
    reused: checkoutData.reused,
    ...(typeof checkoutData.squareOrderId === "string" ? { squareOrderId: checkoutData.squareOrderId } : {}),
    ...(typeof checkoutData.squarePaymentLinkId === "string" ? { squarePaymentLinkId: checkoutData.squarePaymentLinkId } : {}),
  };
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
