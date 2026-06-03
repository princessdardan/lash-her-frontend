"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import type { BookingAnswerInput, BookingSettings, BookingSlot } from "@/lib/booking/types";
import type { TService, TServiceAddOn } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, FieldLabel, FieldError, FieldDescription } from "@/components/ui/field";
import { formatCad } from "@/lib/commerce/money";

type PaidServicePaymentOption = "deposit" | "full" | "customPartial";

interface PaidServiceCheckoutInput {
  answers: BookingAnswerInput[];
  customAmount?: number;
  email: string;
  fetcher?: typeof fetch;
  marketingConsentText?: string;
  marketingOptIn: boolean;
  name: string;
  paymentOption: PaidServicePaymentOption;
  phone: string;
  serviceSlug: string;
  selectedAddOnKey?: string;
  sourcePath?: string;
  start: string;
}

interface PaidServiceCheckoutResult {
  checkoutUrl: string;
  holdReference: string;
  orderId: string;
  paymentProvider: "square";
  reused: boolean;
  squareOrderId?: string;
  squarePaymentLinkId?: string;
}

type SquareCheckoutStatus = "idle" | "opening" | "expired";

const VISIBLE_DATE_COUNT = 7;

class BookingHoldExpiredError extends Error {
  constructor() {
    super("Hold expired, choose another time.");
    this.name = "BookingHoldExpiredError";
  }
}

interface BookingFlowProps {
  initialServiceSlug?: string;
  servicePayment?: {
    depositAmount: number;
    fullPrice: number;
    currency: "CAD";
  };
  services?: TService[];
  settings: BookingSettings;
}

export function BookingFlow({ initialServiceSlug, servicePayment, services = [], settings }: BookingFlowProps) {
  const pathname = usePathname();
  const hasInitialService = Boolean(initialServiceSlug);
  const [step, setStep] = useState<"service" | "datetime" | "details">(hasInitialService ? "datetime" : "service");
  const [selectedServiceSlug, setSelectedServiceSlug] = useState<string>(initialServiceSlug || "");
  const [slots, setSlots] = useState<BookingSlot[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<string>("");
  const [selectedDateState, setSelectedDateState] = useState<string>("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const [isLoadingSlots, setIsLoadingSlots] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [squareCheckout, setSquareCheckout] = useState<PaidServiceCheckoutResult | null>(null);
  const [squareCheckoutStatus, setSquareCheckoutStatus] = useState<SquareCheckoutStatus>("idle");
  const [paymentOption, setPaymentOption] = useState<PaidServicePaymentOption>("full");
  const [customAmount, setCustomAmount] = useState<string>("");
  const [selectedAddOnKey, setSelectedAddOnKey] = useState<string | null>(null);
  const [dateWindowStart, setDateWindowStart] = useState(0);

  const currentService = useMemo(
    () => services.find((service) => service.slug === selectedServiceSlug),
    [services, selectedServiceSlug],
  );
  const currentServicePayment = currentService
    ? {
        depositAmount: currentService.depositAmount,
        fullPrice: currentService.fullPrice,
        currency: currentService.currency as "CAD",
      }
    : servicePayment;
  const currentServiceAddOns = currentService?.addOns ?? [];
  const selectedAddOn = currentServiceAddOns.find((addOn) => addOn._key === selectedAddOnKey);
  const displayTotal = currentService
    ? currentService.fullPrice + (selectedAddOn?.price ?? 0)
    : currentServicePayment?.fullPrice;
  const intakeQuestions = settings.intakeQuestions ?? [];
  const marketingConsentText = settings.marketingOptInLabel || "I would like to receive updates and offers.";

  useEffect(() => {
    if (step !== "datetime" || selectedServiceSlug.length === 0) {
      return;
    }

    let isMounted = true;

    async function loadSlots() {
      setIsLoadingSlots(true);
      setErrorMessage("");

      try {
        const res = await fetchAvailability(selectedServiceSlug);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(typeof data.error === "string" ? data.error : "Failed to fetch availability");
        }

        const data = await res.json();

        if (isMounted) {
          setSlots(Array.isArray(data.slots) ? data.slots : []);
          setSelectedSlot("");
          setSelectedDateState("");
          setDateWindowStart(0);
          setErrorMessage("");
        }
      } catch (error: unknown) {
        if (isMounted) {
          setSlots([]);
          setSelectedSlot("");
          setSelectedDateState("");
          setDateWindowStart(0);
          setErrorMessage(error instanceof Error ? error.message : "Could not load available times. Please try again later.");
        }
      } finally {
        if (isMounted) {
          setIsLoadingSlots(false);
        }
      }
    }

    loadSlots();

    return () => {
      isMounted = false;
    };
  }, [selectedServiceSlug, step]);

  const slotsByDate = useMemo(() => {
    const grouped: Record<string, BookingSlot[]> = {};
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: settings.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });

    for (const slot of slots) {
      const dateObj = new Date(slot.start);
      const parts = formatter.formatToParts(dateObj);
      const year = parts.find((part) => part.type === "year")?.value;
      const month = parts.find((part) => part.type === "month")?.value;
      const day = parts.find((part) => part.type === "day")?.value;
      const dateStr = `${year}-${month}-${day}`;

      if (!grouped[dateStr]) grouped[dateStr] = [];
      grouped[dateStr].push(slot);
    }

    return grouped;
  }, [slots, settings.timezone]);

  const availableDates = useMemo(() => Object.keys(slotsByDate).sort(), [slotsByDate]);
  const selectedDate = availableDates.length > 0 && !availableDates.includes(selectedDateState)
    ? availableDates[0]
    : selectedDateState;
  const maxDateWindowStart = Math.max(availableDates.length - VISIBLE_DATE_COUNT, 0);
  const effectiveDateWindowStart = Math.min(dateWindowStart, maxDateWindowStart);
  const visibleDates = availableDates.slice(effectiveDateWindowStart, effectiveDateWindowStart + VISIBLE_DATE_COUNT);
  const canShowPreviousDates = effectiveDateWindowStart > 0;
  const canShowNextDates = effectiveDateWindowStart < maxDateWindowStart;

  const resetSquareCheckoutState = () => {
    setSquareCheckout(null);
    setSquareCheckoutStatus("idle");
  };

  const handleServiceSelect = (slug: string) => {
    setSelectedServiceSlug(slug);
    setSelectedSlot("");
    setSelectedDateState("");
    setDateWindowStart(0);
    setSlots([]);
    setSelectedAddOnKey(null);
    resetSquareCheckoutState();
  };

  const handleSelectedSlotChange = (value: string) => {
    setSelectedSlot(value);
    resetSquareCheckoutState();
  };

  const handleSelectedDateChange = (dateStr: string) => {
    setSelectedDateState(dateStr);
    setSelectedSlot("");
    resetSquareCheckoutState();
  };

  const moveDateWindow = (direction: "previous" | "next") => {
    const offset = direction === "previous" ? -VISIBLE_DATE_COUNT : VISIBLE_DATE_COUNT;
    const nextWindowStart = Math.min(Math.max(effectiveDateWindowStart + offset, 0), maxDateWindowStart);

    setDateWindowStart(nextWindowStart);

    const nextDate = availableDates[nextWindowStart];
    if (nextDate) {
      handleSelectedDateChange(nextDate);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!selectedServiceSlug || !currentServicePayment || !selectedSlot || !name.trim() || !email.trim() || !phone.trim()) {
      setErrorMessage("Please fill in all required fields.");
      return;
    }

    if (!isLikelyEmail(email)) {
      setErrorMessage("Please enter a valid email address.");
      return;
    }

    const missingQuestion = intakeQuestions.find((question) => question.required && !answers[question.id]?.trim());
    if (missingQuestion) {
      setErrorMessage(`${missingQuestion.label} is required.`);
      return;
    }

    let parsedCustomAmount: number | undefined;
    if (paymentOption === "customPartial") {
      parsedCustomAmount = Number.parseFloat(customAmount);
      if (!Number.isFinite(parsedCustomAmount) || parsedCustomAmount <= 0) {
        setErrorMessage("Please enter a valid custom amount.");
        return;
      }
      if (parsedCustomAmount <= currentServicePayment.depositAmount) {
        setErrorMessage(`Custom amount must be greater than the deposit of ${formatCad(currentServicePayment.depositAmount)}.`);
        return;
      }
      if (parsedCustomAmount >= currentServicePayment.fullPrice) {
        setErrorMessage(`Custom amount must be less than the full price of ${formatCad(currentServicePayment.fullPrice)}.`);
        return;
      }
    }

    setIsSubmitting(true);
    setErrorMessage("");

    try {
      const checkout = await startPaidServiceCheckout({
        answers: Object.entries(answers).map(([questionId, answer]) => ({ questionId, answer })),
        email,
        marketingConsentText,
        marketingOptIn,
        name,
        paymentOption,
        phone,
        serviceSlug: selectedServiceSlug,
        ...(selectedAddOnKey ? { selectedAddOnKey } : {}),
        sourcePath: pathname,
        start: selectedSlot,
        ...(parsedCustomAmount ? { customAmount: parsedCustomAmount } : {}),
      });

      setSquareCheckout(checkout);
      setSquareCheckoutStatus("opening");
      window.location.assign(checkout.checkoutUrl);
    } catch (error: unknown) {
      if (error instanceof BookingHoldExpiredError) {
        setSquareCheckoutStatus("expired");
        setErrorMessage(error.message);
      } else {
        setSquareCheckoutStatus("idle");
        setErrorMessage(error instanceof Error ? error.message : "An error occurred while booking. Please try again.");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  if (step === "service") {
    return (
      <section className="flex flex-col gap-8 lg:flex-row">
        <section className="min-w-0 flex-1">
          <header>
            <h1 className="section-heading mb-6 text-3xl md:text-3xl lg:text-3xl">Select Service</h1>
          </header>
          <div className="mb-6 flex gap-2 overflow-x-auto pb-2" role="group" aria-label="Service filters">
            <div className="rounded-full bg-lh-primary px-4 py-2 text-sm font-medium text-white whitespace-nowrap">All Services</div>
            <div className="rounded-full border border-lh-line bg-white px-4 py-2 text-sm font-medium text-lh-muted whitespace-nowrap">Nataliea</div>
          </div>
          <div className="space-y-4">
            {services.length === 0 ? (
              <section className="rounded-xl border border-lh-line bg-white p-6 text-center text-lh-muted">
                We are currently updating our services. Please check back later.
              </section>
            ) : services.map((service) => {
              const isSelected = selectedServiceSlug === service.slug;
              return (
                <button
                  key={service._id}
                  type="button"
                  aria-pressed={isSelected}
                  className={`editorial-card flex w-full cursor-pointer items-center justify-between p-6 text-left transition-colors hover:border-lh-primary ${isSelected ? "border-lh-primary ring-1 ring-lh-primary" : ""}`}
                  onClick={() => handleServiceSelect(service.slug)}
                >
                  <div>
                    <h3 className="section-subheading mb-1 text-lg md:text-lg lg:text-lg">{service.title}</h3>
                    <p className="mb-2 text-sm text-lh-muted">{service.durationMinutes} min</p>
                    <p className="max-w-md text-sm font-light text-black">{service.description}</p>
                  </div>
                  <div className="flex flex-col items-end gap-3">
                    <span className="font-medium text-black">{formatCad(service.fullPrice)}</span>
                    <div className={`flex h-8 w-8 items-center justify-center rounded-full border ${isSelected ? "border-lh-primary bg-lh-primary text-white" : "border-lh-line text-lh-primary"}`} aria-hidden="true">
                      {isSelected ? "✓" : "+"}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </section>
        <aside className="w-full shrink-0 lg:w-80">
          <section className="sticky top-24 rounded-xl border border-lh-line bg-white p-6">
            <h2 className="section-subheading mb-4 text-xl md:text-xl lg:text-xl">Summary</h2>
            <BookingSummary service={currentService} selectedAddOn={selectedAddOn} selectedSlot={selectedSlot} timezone={settings.timezone} />
            <Button className="mt-6 w-full" disabled={!selectedServiceSlug} onClick={() => setStep("datetime")}>Continue</Button>
          </section>
        </aside>
      </section>
    );
  }

  if (step === "datetime") {
    return (
      <section className="flex flex-col gap-8 lg:flex-row">
        <section className="min-w-0 flex-1">
          <header className="mb-6 flex items-center gap-4">
            {!hasInitialService && (
              <button type="button" onClick={() => setStep("service")} className="text-lh-muted hover:text-black">← Back</button>
            )}
            <h1 className="section-heading text-3xl md:text-3xl lg:text-3xl">Select Time</h1>
          </header>

          {isLoadingSlots ? (
            <div className="py-12 text-center text-lh-muted">Loading available times...</div>
          ) : errorMessage ? (
            <FieldError className="py-12 text-center">{errorMessage}</FieldError>
          ) : slots.length === 0 ? (
            <div className="py-12 text-center text-lh-muted">No times available for this service.</div>
          ) : (
            <section className="space-y-6">
              <div
                className="flex w-full max-w-full items-stretch gap-1 sm:gap-2"
                aria-label={`Available appointment dates, showing ${effectiveDateWindowStart + 1}-${Math.min(effectiveDateWindowStart + VISIBLE_DATE_COUNT, availableDates.length)} of ${availableDates.length}`}
              >
                <button
                  type="button"
                  onClick={() => moveDateWindow("previous")}
                  disabled={!canShowPreviousDates}
                  className="flex w-8 shrink-0 items-center justify-center rounded-xl border border-lh-line bg-white text-lg text-lh-primary transition-colors hover:border-lh-primary disabled:cursor-not-allowed disabled:opacity-35 sm:w-10"
                  aria-label="Show previous available dates"
                >
                  ‹
                </button>
                <div className="grid min-w-0 flex-1 grid-cols-7 gap-1 sm:gap-2">
                  {visibleDates.map((dateStr) => {
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
                        type="button"
                        aria-pressed={isSelected}
                        onClick={() => handleSelectedDateChange(dateStr)}
                        className={`flex min-w-0 flex-col items-center justify-center rounded-xl border px-0.5 py-3 transition-colors sm:px-3 ${isSelected ? "border-lh-primary bg-lh-primary text-white" : "border-lh-line bg-white text-black hover:border-lh-primary"}`}
                      >
                        <span className="mb-1 text-[0.65rem] uppercase tracking-normal sm:text-xs sm:tracking-wider">{dayName}</span>
                        <span className="text-xl font-medium">{dayNum}</span>
                        <span className="text-xs">{monthName}</span>
                      </button>
                    );
                  })}
                </div>
                <button
                  type="button"
                  onClick={() => moveDateWindow("next")}
                  disabled={!canShowNextDates}
                  className="flex w-8 shrink-0 items-center justify-center rounded-xl border border-lh-line bg-white text-lg text-lh-primary transition-colors hover:border-lh-primary disabled:cursor-not-allowed disabled:opacity-35 sm:w-10"
                  aria-label="Show next available dates"
                >
                  ›
                </button>
              </div>

              <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
                {slotsByDate[selectedDate]?.map((slot) => {
                  const timeStr = new Intl.DateTimeFormat("en-US", {
                    hour: "numeric",
                    minute: "2-digit",
                    timeZone: settings.timezone,
                  }).format(new Date(slot.start));
                  const isSelected = selectedSlot === slot.start;

                  return (
                    <button
                      key={slot.start}
                      type="button"
                      onClick={() => handleSelectedSlotChange(slot.start)}
                      className={`rounded-lg border px-2 py-3 text-center text-sm font-medium transition-colors ${isSelected ? "border-lh-primary bg-lh-primary text-white" : "border-lh-line bg-white text-black hover:border-lh-primary"}`}
                    >
                      {timeStr}
                    </button>
                  );
                })}
              </div>
              <p className="mt-4 text-sm text-lh-muted">All times are shown in {settings.timezone}.</p>
            </section>
          )}
        </section>

        <aside className="w-full shrink-0 lg:w-80">
          <section className="sticky top-24 rounded-xl border border-lh-line bg-white p-6">
            <h2 className="section-subheading mb-4 text-xl md:text-xl lg:text-xl">Summary</h2>
            <BookingSummary service={currentService} selectedAddOn={selectedAddOn} selectedSlot={selectedSlot} timezone={settings.timezone} />
            <Button className="mt-6 w-full" disabled={!selectedSlot} onClick={() => setStep("details")}>Continue</Button>
          </section>
        </aside>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-8 lg:flex-row">
      <section className="min-w-0 flex-1">
        <header className="mb-6 flex items-center gap-4">
          <button type="button" onClick={() => setStep("datetime")} className="text-lh-muted hover:text-black">← Back</button>
          <h1 className="section-heading text-3xl md:text-3xl lg:text-3xl">Your Details</h1>
        </header>

        <form onSubmit={handleSubmit} className="space-y-8 rounded-xl border border-lh-line bg-white p-6">
          {squareCheckoutStatus !== "idle" && (
            <div role="status" aria-live="polite" className="rounded-[18px] border border-lh-line bg-lh-neutral-2 p-5 shadow-sm">
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

          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="name">Full Name</FieldLabel>
              <Input id="name" required value={name} onChange={(event) => setName(event.target.value)} placeholder="Jane Doe" />
            </Field>
            <Field>
              <FieldLabel htmlFor="email">Email Address</FieldLabel>
              <Input id="email" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="jane@example.com" />
            </Field>
          </div>

          <Field>
            <FieldLabel htmlFor="phone">Phone Number</FieldLabel>
            <Input id="phone" type="tel" required value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="(555) 123-4567" />
          </Field>

          {intakeQuestions.map((question) => (
            <Field key={question._key ?? question.id}>
              <FieldLabel htmlFor={question.id}>{question.label}</FieldLabel>
              {question.inputType === "textarea" ? (
                <Textarea id={question.id} required={question.required} value={answers[question.id] || ""} onChange={(event) => setAnswers({ ...answers, [question.id]: event.target.value })} />
              ) : question.inputType === "select" && question.options ? (
                <Select value={answers[question.id] || ""} onValueChange={(value) => setAnswers({ ...answers, [question.id]: value })}>
                  <SelectTrigger id={question.id}>
                    <SelectValue placeholder="Select an option" />
                  </SelectTrigger>
                  <SelectContent>
                    {question.options.map((option) => (
                      <SelectItem key={option} value={option}>{option}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input id={question.id} required={question.required} value={answers[question.id] || ""} onChange={(event) => setAnswers({ ...answers, [question.id]: event.target.value })} />
              )}
            </Field>
          ))}

          <div className="flex items-start gap-3 pt-4">
            <input
              type="checkbox"
              id="marketingOptIn"
              checked={marketingOptIn}
              onChange={(event) => setMarketingOptIn(event.target.checked)}
              className="mt-1 h-4 w-4 rounded border-input text-primary focus:ring-primary"
            />
            <label htmlFor="marketingOptIn" className="text-sm leading-snug text-muted-foreground">{marketingConsentText}</label>
          </div>

          {currentServiceAddOns.length > 0 && (
            <div className="border-t border-border/50 pt-4">
              <h3 className="section-subheading mb-4 text-lg text-primary md:text-lg lg:text-lg">Optional add-on</h3>
              <p className="mb-4 text-sm text-muted-foreground">Only one add-on can be selected for this booking. Add-ons do not change your appointment duration.</p>
              <div className="space-y-3" role="radiogroup" aria-label="Optional add-on">
                <button
                  type="button"
                  role="radio"
                  aria-checked={selectedAddOnKey === null}
                  onClick={() => setSelectedAddOnKey(null)}
                  className={`w-full rounded-xl border p-4 text-left transition-colors ${selectedAddOnKey === null ? "border-lh-primary ring-1 ring-lh-primary" : "border-lh-line hover:border-lh-primary"}`}
                >
                  <div className="flex items-center justify-between gap-4">
                    <span className="font-medium text-black">No add-on</span>
                    <span className="text-sm text-lh-muted">Included</span>
                  </div>
                </button>
                {currentServiceAddOns.map((addOn) => {
                  const isSelected = selectedAddOnKey === addOn._key;
                  return (
                    <button
                      key={addOn._key}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      onClick={() => setSelectedAddOnKey(addOn._key)}
                      className={`w-full rounded-xl border p-4 text-left transition-colors ${isSelected ? "border-lh-primary ring-1 ring-lh-primary" : "border-lh-line hover:border-lh-primary"}`}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <p className="font-medium text-black">{addOn.name}</p>
                          <p className="mt-1 text-sm text-lh-muted">{addOn.description}</p>
                        </div>
                        <span className="shrink-0 font-medium text-black">+{formatCad(addOn.price)}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {currentServicePayment && (
            <div className="border-t border-border/50 pt-4">
              <h3 className="section-subheading mb-4 text-lg text-primary md:text-lg lg:text-lg">Payment Details</h3>
              <p className="mb-4 text-muted-foreground">
                Choose the amount you would like to pay now. Your appointment is valid with the deposit, the full price, or any amount between them.
              </p>
              <div className="space-y-4">
                <Field>
                  <FieldLabel>Payment Option</FieldLabel>
                  <Select value={paymentOption} onValueChange={(value) => setPaymentOption(value as PaidServicePaymentOption)}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select payment option" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="deposit">Pay Deposit ({formatCad(currentServicePayment.depositAmount)})</SelectItem>
                      <SelectItem value="full">Pay in Full ({formatCad(displayTotal ?? currentServicePayment.fullPrice)})</SelectItem>
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
                      min={currentServicePayment.depositAmount}
                      max={currentServicePayment.fullPrice}
                      value={customAmount}
                      onChange={(event) => setCustomAmount(event.target.value)}
                      placeholder={`Between ${formatCad(currentServicePayment.depositAmount)} and ${formatCad(currentServicePayment.fullPrice)}`}
                      required
                    />
                    <FieldDescription>Enter an amount greater than {formatCad(currentServicePayment.depositAmount)} and less than {formatCad(currentServicePayment.fullPrice)}.</FieldDescription>
                  </Field>
                )}
                {selectedAddOn && paymentOption !== "full" && (
                  <p className="text-sm text-lh-muted">
                    Your selected add-on balance is due later unless you choose Pay in Full.
                  </p>
                )}
              </div>
            </div>
          )}

          {errorMessage && <FieldError role="alert" className="text-center">{errorMessage}</FieldError>}

          <Button type="submit" className="w-full" disabled={isSubmitting || !currentServicePayment}>
            {isSubmitting ? "Creating private hold..." : "Continue to secure Square checkout"}
          </Button>
        </form>
      </section>

      <aside className="w-full shrink-0 lg:w-80">
        <section className="sticky top-24 rounded-xl border border-lh-line bg-white p-6">
          <h2 className="section-subheading mb-4 text-xl md:text-xl lg:text-xl">Summary</h2>
          <BookingSummary service={currentService} selectedAddOn={selectedAddOn} selectedSlot={selectedSlot} timezone={settings.timezone} />
        </section>
      </aside>
    </section>
  );
}

function BookingSummary({ service, selectedAddOn, selectedSlot, timezone }: { service?: TService; selectedAddOn?: TServiceAddOn; selectedSlot: string; timezone: string }) {
  if (!service) {
    return <p className="text-sm text-lh-muted">Select a service to continue.</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between text-sm">
        <span className="font-medium text-black">{service.title}</span>
        <span className="text-black">{formatCad(service.fullPrice)}</span>
      </div>
      <div className="text-sm text-lh-muted">{service.durationMinutes} min</div>
      {selectedAddOn && (
        <div className="flex justify-between text-sm">
          <span className="text-lh-muted">{selectedAddOn.name}</span>
          <span className="text-black">+{formatCad(selectedAddOn.price)}</span>
        </div>
      )}
      {selectedSlot && (
        <div className="border-t border-lh-line pt-4">
          <p className="mb-1 text-sm font-medium text-black">Selected Time</p>
          <p className="text-sm text-lh-muted">
            {new Intl.DateTimeFormat("en-US", {
              weekday: "long",
              month: "long",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
              timeZone: timezone,
            }).format(new Date(selectedSlot))}
          </p>
        </div>
      )}
      <div className="border-t border-lh-line pt-4">
        <div className="flex justify-between font-medium text-black">
          <span>Total</span>
          <span>{formatCad(service.fullPrice + (selectedAddOn?.price ?? 0))}</span>
        </div>
      </div>
    </div>
  );
}

function fetchAvailability(serviceSlug: string): Promise<Response> {
  const availabilityParams = new URLSearchParams({ service: serviceSlug });
  return fetch(`/api/booking/availability?${availabilityParams.toString()}`, { cache: "no-store" });
}

export async function startPaidServiceCheckout(input: PaidServiceCheckoutInput): Promise<PaidServiceCheckoutResult> {
  const fetcher = input.fetcher ?? fetch;
  const holdRes = await fetcher("/api/booking/holds", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      answers: input.answers,
      email: input.email,
      marketingConsentText: input.marketingConsentText,
      marketingOptIn: input.marketingOptIn,
      name: input.name,
      paymentOption: input.paymentOption,
      phone: input.phone,
      serviceSlug: input.serviceSlug,
      ...(input.selectedAddOnKey ? { selectedAddOnKey: input.selectedAddOnKey } : {}),
      sourcePath: input.sourcePath,
      start: input.start,
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
    body: JSON.stringify({ holdReference }),
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
