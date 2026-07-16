"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import type {
  BookingAnswerInput,
  BookingSettings,
  BookingSlot,
} from "@/lib/booking/types";
import type {
  PublicBookingOffering,
  PublicServiceBookingModel,
} from "@/lib/booking/operations/offering";
import type { TService } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Field, FieldLabel, FieldError } from "@/components/ui/field";
import { formatCad } from "@/lib/commerce/money";
import {
  confirmCardOnFileBooking,
  fetchSquareCardOnFileConfig,
  BookingHoldExpiredError,
} from "./square-card-on-file-form";

export { confirmCardOnFileBooking, fetchSquareCardOnFileConfig };

interface BookingHoldInputBase {
  answers: BookingAnswerInput[];
  fetcher?: typeof fetch;
  selectedAddOnKey?: string;
  start: string;
}

type ServiceHoldInput = BookingHoldInputBase &
  (
    | {
        offeringId: string;
        serviceSlug?: never;
        sourcePath?: never;
      }
    | {
        offeringId?: never;
        serviceSlug: string;
        sourcePath?: string;
      }
  );

interface DisplayBookingAddOn {
  description: string;
  durationDeltaMinutes: number;
  key: string;
  name: string;
  price: number;
}

type BookingFlowStep = "service" | "provider" | "datetime" | "details";

const VISIBLE_DATE_COUNT = 7;

interface BookingFlowProps {
  initialServiceSlug?: string;
  offerings?: PublicBookingOffering[];
  serviceBookingModels?: Record<string, PublicServiceBookingModel>;
  services?: TService[];
  settings: BookingSettings;
}

export function getServiceBookingModel(input: {
  offerings: readonly PublicBookingOffering[] | undefined;
  serviceBookingModels:
    | Readonly<Record<string, PublicServiceBookingModel>>
    | undefined;
  serviceSlug: string | undefined;
}): PublicServiceBookingModel {
  if (input.serviceSlug) {
    const configuredModel = input.serviceBookingModels?.[input.serviceSlug];

    if (configuredModel) {
      return configuredModel;
    }
  }

  return input.offerings === undefined ? "legacy" : "operational";
}

export function getInitialOfferingSelection(
  offerings: readonly PublicBookingOffering[],
  serviceSlug: string | undefined,
): { offeringId: string; requiresProviderSelection: boolean } {
  const matchingOfferings = serviceSlug
    ? offerings.filter((offering) => offering.serviceSlug === serviceSlug)
    : [];

  return matchingOfferings.length === 1
    ? {
        offeringId: matchingOfferings[0].id,
        requiresProviderSelection: false,
      }
    : { offeringId: "", requiresProviderSelection: true };
}

export function BookingFlow({
  initialServiceSlug,
  offerings,
  serviceBookingModels,
  services = [],
  settings,
}: BookingFlowProps) {
  const pathname = usePathname();
  const hasInitialService = Boolean(initialServiceSlug);
  const initialBookingModel = getServiceBookingModel({
    offerings,
    serviceBookingModels,
    serviceSlug: initialServiceSlug,
  });
  const initialOfferingSelection = getInitialOfferingSelection(
    offerings ?? [],
    initialServiceSlug,
  );
  const legacyInitialStep: BookingFlowStep = hasInitialService ? "datetime" : "service";
  const [step, setStep] = useState<BookingFlowStep>(
    initialBookingModel === "operational" &&
      hasInitialService &&
      initialOfferingSelection.requiresProviderSelection
      ? "provider"
      : legacyInitialStep,
  );
  const [selectedServiceSlug, setSelectedServiceSlug] = useState<string>(
    initialServiceSlug || "",
  );
  const [selectedOfferingId, setSelectedOfferingId] = useState(
    initialOfferingSelection.offeringId,
  );
  const [slots, setSlots] = useState<BookingSlot[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<string>("");
  const [selectedDateState, setSelectedDateState] = useState<string>("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [isLoadingSlots, setIsLoadingSlots] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [selectedAddOnKey, setSelectedAddOnKey] = useState<string | null>(null);
  const [dateWindowStart, setDateWindowStart] = useState(0);
  const isOfferingFlow =
    getServiceBookingModel({
      offerings,
      serviceBookingModels,
      serviceSlug: selectedServiceSlug,
    }) === "operational";

  const currentService = useMemo(
    () => services.find((service) => service.slug === selectedServiceSlug),
    [services, selectedServiceSlug],
  );
  const currentOfferings = useMemo(
    () =>
      (offerings ?? []).filter(
        (offering) => offering.serviceSlug === selectedServiceSlug,
      ),
    [offerings, selectedServiceSlug],
  );
  const selectedOffering = useMemo(
    () =>
      currentOfferings.find((offering) => offering.id === selectedOfferingId),
    [currentOfferings, selectedOfferingId],
  );
  const currentServiceAddOns = useMemo<DisplayBookingAddOn[]>(
    () =>
      selectedOffering
        ? selectedOffering.addOns.map((addOn) => ({
            description: addOn.description,
            durationDeltaMinutes: addOn.durationDeltaMinutes,
            key: addOn.key,
            name: addOn.name,
            price: addOn.priceCents / 100,
          }))
        : isOfferingFlow
          ? []
          : (currentService?.addOns ?? []).map((addOn) => ({
              description: addOn.description,
              durationDeltaMinutes: 0,
              key: addOn._key,
              name: addOn.name,
              price: addOn.price,
            })),
    [currentService?.addOns, isOfferingFlow, selectedOffering],
  );
  const selectedAddOn = currentServiceAddOns.find(
    (addOn) => addOn.key === selectedAddOnKey,
  );
  const intakeQuestions = settings.intakeQuestions ?? [];

  useEffect(() => {
    if (
      step !== "datetime" ||
      (isOfferingFlow
        ? selectedOfferingId.length === 0
        : selectedServiceSlug.length === 0)
    ) {
      return;
    }

    let isMounted = true;

    async function loadSlots() {
      setIsLoadingSlots(true);
      setErrorMessage("");

      try {
        const res = isOfferingFlow
          ? await fetchOfferingAvailability(
              selectedOfferingId,
              selectedAddOnKey,
            )
          : await fetchAvailability(selectedServiceSlug);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(
            typeof data.error === "string"
              ? data.error
              : "Failed to fetch availability",
          );
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
          setErrorMessage(
            error instanceof Error
              ? error.message
              : "Could not load available times. Please try again later.",
          );
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
  }, [
    isOfferingFlow,
    selectedAddOnKey,
    selectedOfferingId,
    selectedServiceSlug,
    step,
  ]);

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

  const availableDates = useMemo(
    () => Object.keys(slotsByDate).sort(),
    [slotsByDate],
  );
  const selectedDate =
    availableDates.length > 0 && !availableDates.includes(selectedDateState)
      ? availableDates[0]
      : selectedDateState;
  const maxDateWindowStart = Math.max(
    availableDates.length - VISIBLE_DATE_COUNT,
    0,
  );
  const effectiveDateWindowStart = Math.min(
    dateWindowStart,
    maxDateWindowStart,
  );
  const visibleDates = availableDates.slice(
    effectiveDateWindowStart,
    effectiveDateWindowStart + VISIBLE_DATE_COUNT,
  );
  const canShowPreviousDates = effectiveDateWindowStart > 0;
  const canShowNextDates = effectiveDateWindowStart < maxDateWindowStart;

  const resetSlotSelectionState = () => {
    setSlots([]);
    setSelectedSlot("");
    setSelectedDateState("");
    setDateWindowStart(0);
    setErrorMessage("");
  };

  const resetDependentBookingState = () => {
    resetSlotSelectionState();
    setSelectedAddOnKey(null);
  };

  const handleServiceSelect = (slug: string) => {
    const matchingOfferings = (offerings ?? []).filter(
      (offering) => offering.serviceSlug === slug,
    );

    setSelectedServiceSlug(slug);
    setSelectedOfferingId(
      matchingOfferings.length === 1 ? matchingOfferings[0].id : "",
    );
    resetDependentBookingState();
  };

  const handleOfferingSelect = (offeringId: string) => {
    setSelectedOfferingId(offeringId);
    resetDependentBookingState();
  };

  const handleAddOnSelect = (addOnKey: string | null) => {
    setSelectedAddOnKey(addOnKey);
    resetSlotSelectionState();
  };

  const handleContinueFromService = () => {
    if (!isOfferingFlow) {
      setStep("datetime");
      return;
    }

    if (currentOfferings.length === 1) {
      setSelectedOfferingId(currentOfferings[0].id);
      setStep("datetime");
      return;
    }

    setStep("provider");
  };

  const handleSelectedSlotChange = (value: string) => {
    setSelectedSlot(value);
  };

  const handleSelectedDateChange = (dateStr: string) => {
    setSelectedDateState(dateStr);
    setSelectedSlot("");
  };

  const moveDateWindow = (direction: "previous" | "next") => {
    const offset =
      direction === "previous" ? -VISIBLE_DATE_COUNT : VISIBLE_DATE_COUNT;
    const nextWindowStart = Math.min(
      Math.max(effectiveDateWindowStart + offset, 0),
      maxDateWindowStart,
    );

    setDateWindowStart(nextWindowStart);

    const nextDate = availableDates[nextWindowStart];
    if (nextDate) {
      handleSelectedDateChange(nextDate);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (
      !selectedServiceSlug ||
      !selectedSlot ||
      (isOfferingFlow && !selectedOfferingId)
    ) {
      setErrorMessage("Please select an appointment time.");
      return;
    }

    const missingQuestion = intakeQuestions.find(
      (question) => question.required && !answers[question.id]?.trim(),
    );
    if (missingQuestion) {
      setErrorMessage(`${missingQuestion.label} is required.`);
      return;
    }

    setIsSubmitting(true);
    setErrorMessage("");

    try {
      const bookingAnswers = Object.entries(answers).map(
        ([questionId, answer]) => ({
          questionId,
          answer,
        }),
      );
      const holdInput: ServiceHoldInput = isOfferingFlow
        ? {
            answers: bookingAnswers,
            offeringId: selectedOfferingId,
            ...(selectedAddOnKey ? { selectedAddOnKey } : {}),
            start: selectedSlot,
          }
        : {
            answers: bookingAnswers,
            serviceSlug: selectedServiceSlug,
            ...(selectedAddOnKey ? { selectedAddOnKey } : {}),
            sourcePath: pathname,
            start: selectedSlot,
          };
      const { paymentPageUrl } = await createBookingHold(holdInput);

      window.location.assign(paymentPageUrl);
    } catch (error: unknown) {
      if (error instanceof BookingHoldExpiredError) {
        setErrorMessage(error.message);
      } else {
        setErrorMessage(
          error instanceof Error
            ? error.message
            : "An error occurred while booking. Please try again.",
        );
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
            <h1 className="section-heading mb-6 text-3xl md:text-3xl lg:text-3xl">
              Select Service
            </h1>
          </header>
          <div
            className="mb-6 flex gap-2 overflow-x-auto pb-2"
            role="group"
            aria-label="Service filters"
          >
            <div className="rounded-full bg-lh-primary px-4 py-2 text-sm font-medium text-white whitespace-nowrap">
              All Services
            </div>
            <div className="rounded-full border border-lh-line bg-white px-4 py-2 text-sm font-medium text-lh-muted whitespace-nowrap">
              Nataliea
            </div>
          </div>
          <div className="space-y-4">
            {services.length === 0 && offerings !== undefined ? (
              <section className="rounded-xl border border-lh-line bg-white p-6 text-center text-lh-muted">
                Online booking is temporarily unavailable while scheduling is
                being updated. Please check back later.
              </section>
            ) : services.length === 0 ? (
              <section className="rounded-xl border border-lh-line bg-white p-6 text-center text-lh-muted">
                We are currently updating our services. Please check back later.
              </section>
            ) : (
              services.map((service) => {
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
                      <h3 className="section-subheading mb-1 text-lg md:text-lg lg:text-lg">
                        {service.title}
                      </h3>
                      <p className="mb-2 text-sm text-lh-muted">
                        {service.durationMinutes} min
                      </p>
                      <p className="max-w-md text-sm font-light text-black">
                        {service.description}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-3">
                      <span className="font-medium text-black">
                        {formatCad(service.fullPrice)}
                      </span>
                      <div
                        className={`flex h-8 w-8 items-center justify-center rounded-full border ${isSelected ? "border-lh-primary bg-lh-primary text-white" : "border-lh-line text-lh-primary"}`}
                        aria-hidden="true"
                      >
                        {isSelected ? "✓" : "+"}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </section>
        <aside className="w-full shrink-0 lg:w-80">
          <section className="sticky top-24 rounded-xl border border-lh-line bg-white p-6">
            <h2 className="section-subheading mb-4 text-xl md:text-xl lg:text-xl">
              Summary
            </h2>
            <BookingSummary
              offering={selectedOffering}
              service={currentService}
              selectedAddOn={selectedAddOn}
              selectedSlot={selectedSlot}
              timezone={settings.timezone}
            />
            <Button
              className="mt-6 w-full"
              disabled={
                !selectedServiceSlug ||
                (isOfferingFlow && currentOfferings.length === 0)
              }
              onClick={handleContinueFromService}
            >
              Continue
            </Button>
          </section>
        </aside>
      </section>
    );
  }

  if (step === "provider") {
    return (
      <section className="flex flex-col gap-8 lg:flex-row">
        <section className="min-w-0 flex-1">
          <header className="mb-6 flex items-center gap-4">
            {!hasInitialService && (
              <button
                type="button"
                onClick={() => setStep("service")}
                className="text-lh-muted hover:text-black"
              >
                ← Back
              </button>
            )}
            <h1 className="section-heading text-3xl md:text-3xl lg:text-3xl">
              Select Provider
            </h1>
          </header>

          {currentOfferings.length === 0 ? (
            <section className="rounded-xl border border-lh-line bg-white p-6 text-center text-lh-muted">
              This service does not currently have an available provider.
            </section>
          ) : (
            <div className="space-y-4">
              {currentOfferings.map((offering) => {
                const isSelected = selectedOfferingId === offering.id;

                return (
                  <button
                    key={offering.id}
                    type="button"
                    aria-pressed={isSelected}
                    className={`editorial-card flex w-full cursor-pointer items-center justify-between gap-6 p-6 text-left transition-colors hover:border-lh-primary ${isSelected ? "border-lh-primary ring-1 ring-lh-primary" : ""}`}
                    onClick={() => handleOfferingSelect(offering.id)}
                  >
                    <div>
                      <h2 className="section-subheading mb-1 text-lg md:text-lg lg:text-lg">
                        {offering.provider.displayName}
                      </h2>
                      <p className="text-sm text-lh-muted">
                        {offering.serviceTitle} · {offering.durationMinutes} min
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-3">
                      <span className="font-medium text-black">
                        {formatCad(offering.fullPriceCents / 100)}
                      </span>
                      <span
                        className={`flex h-8 w-8 items-center justify-center rounded-full border ${isSelected ? "border-lh-primary bg-lh-primary text-white" : "border-lh-line text-lh-primary"}`}
                        aria-hidden="true"
                      >
                        {isSelected ? "✓" : "+"}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <aside className="w-full shrink-0 lg:w-80">
          <section className="sticky top-24 rounded-xl border border-lh-line bg-white p-6">
            <h2 className="section-subheading mb-4 text-xl md:text-xl lg:text-xl">
              Summary
            </h2>
            <BookingSummary
              offering={selectedOffering}
              service={currentService}
              selectedAddOn={selectedAddOn}
              selectedSlot={selectedSlot}
              timezone={settings.timezone}
            />
            <Button
              className="mt-6 w-full"
              disabled={!selectedOffering}
              onClick={() => setStep("datetime")}
            >
              Continue
            </Button>
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
            {(!hasInitialService ||
              (isOfferingFlow && currentOfferings.length > 1)) && (
              <button
                type="button"
                onClick={() =>
                  setStep(
                    isOfferingFlow && currentOfferings.length > 1
                      ? "provider"
                      : "service",
                  )
                }
                className="text-lh-muted hover:text-black"
              >
                ← Back
              </button>
            )}
            <h1 className="section-heading text-3xl md:text-3xl lg:text-3xl">
              Select Time
            </h1>
          </header>

          {isOfferingFlow && currentServiceAddOns.length > 0 && (
            <BookingAddOnPicker
              addOns={currentServiceAddOns}
              className="mb-8 rounded-xl border border-lh-line bg-white p-6"
              description="Choose an optional add-on before selecting a time. Added service time is included in the availability below."
              onChange={handleAddOnSelect}
              selectedAddOnKey={selectedAddOnKey}
            />
          )}

          {isLoadingSlots ? (
            <div className="py-12 text-center text-lh-muted">
              Loading available times...
            </div>
          ) : errorMessage ? (
            <FieldError className="py-12 text-center">
              {errorMessage}
            </FieldError>
          ) : slots.length === 0 ? (
            <div className="py-12 text-center text-lh-muted">
              No times available for this service.
            </div>
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
                    const dayName = new Intl.DateTimeFormat("en-US", {
                      weekday: "short",
                      timeZone: settings.timezone,
                    }).format(dateObj);
                    const dayNum = new Intl.DateTimeFormat("en-US", {
                      day: "numeric",
                      timeZone: settings.timezone,
                    }).format(dateObj);
                    const monthName = new Intl.DateTimeFormat("en-US", {
                      month: "short",
                      timeZone: settings.timezone,
                    }).format(dateObj);
                    const isSelected = selectedDate === dateStr;

                    return (
                      <button
                        key={dateStr}
                        type="button"
                        aria-pressed={isSelected}
                        onClick={() => handleSelectedDateChange(dateStr)}
                        className={`flex min-w-0 flex-col items-center justify-center rounded-xl border px-0.5 py-3 transition-colors sm:px-3 ${isSelected ? "border-lh-primary bg-lh-primary text-white" : "border-lh-line bg-white text-black hover:border-lh-primary"}`}
                      >
                        <span className="mb-1 text-[0.65rem] uppercase tracking-normal sm:text-xs sm:tracking-wider">
                          {dayName}
                        </span>
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
              <p className="mt-4 text-sm text-lh-muted">
                All times are shown in {settings.timezone}.
              </p>
            </section>
          )}
        </section>

        <aside className="w-full shrink-0 lg:w-80">
          <section className="sticky top-24 rounded-xl border border-lh-line bg-white p-6">
            <h2 className="section-subheading mb-4 text-xl md:text-xl lg:text-xl">
              Summary
            </h2>
            <BookingSummary
              offering={selectedOffering}
              service={currentService}
              selectedAddOn={selectedAddOn}
              selectedSlot={selectedSlot}
              timezone={settings.timezone}
            />
            <Button
              className="mt-6 w-full"
              disabled={!selectedSlot}
              onClick={() => setStep("details")}
            >
              Continue
            </Button>
          </section>
        </aside>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-8 lg:flex-row">
      <section className="min-w-0 flex-1">
        <header className="mb-6 flex items-center gap-4">
          <button
            type="button"
            onClick={() => setStep("datetime")}
            className="text-lh-muted hover:text-black"
          >
            ← Back
          </button>
          <h1 className="section-heading text-3xl md:text-3xl lg:text-3xl">
            Appointment Details
          </h1>
        </header>

        <form
          onSubmit={handleSubmit}
          className="space-y-8 rounded-xl border border-lh-line bg-white p-6"
        >
          {intakeQuestions.map((question) => (
            <Field key={question._key ?? question.id}>
              <FieldLabel htmlFor={question.id}>{question.label}</FieldLabel>
              {question.inputType === "textarea" ? (
                <Textarea
                  id={question.id}
                  required={question.required}
                  value={answers[question.id] || ""}
                  onChange={(event) =>
                    setAnswers({
                      ...answers,
                      [question.id]: event.target.value,
                    })
                  }
                />
              ) : question.inputType === "select" && question.options ? (
                <Select
                  value={answers[question.id] || ""}
                  onValueChange={(value) =>
                    setAnswers({ ...answers, [question.id]: value })
                  }
                >
                  <SelectTrigger id={question.id}>
                    <SelectValue placeholder="Select an option" />
                  </SelectTrigger>
                  <SelectContent>
                    {question.options.map((option) => (
                      <SelectItem key={option} value={option}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id={question.id}
                  required={question.required}
                  value={answers[question.id] || ""}
                  onChange={(event) =>
                    setAnswers({
                      ...answers,
                      [question.id]: event.target.value,
                    })
                  }
                />
              )}
            </Field>
          ))}

          {!isOfferingFlow && currentServiceAddOns.length > 0 && (
            <BookingAddOnPicker
              addOns={currentServiceAddOns}
              className="border-t border-border/50 pt-4"
              description="Only one add-on can be selected for this booking. Add-ons do not change your appointment duration."
              onChange={setSelectedAddOnKey}
              selectedAddOnKey={selectedAddOnKey}
            />
          )}

          {errorMessage && (
            <FieldError role="alert" className="text-center">
              {errorMessage}
            </FieldError>
          )}

          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? "Creating private hold..." : "Continue to payment"}
          </Button>
        </form>
      </section>

      <aside className="w-full shrink-0 lg:w-80">
        <section className="sticky top-24 rounded-xl border border-lh-line bg-white p-6">
          <h2 className="section-subheading mb-4 text-xl md:text-xl lg:text-xl">
            Summary
          </h2>
          <BookingSummary
            offering={selectedOffering}
            service={currentService}
            selectedAddOn={selectedAddOn}
            selectedSlot={selectedSlot}
            timezone={settings.timezone}
          />
        </section>
      </aside>
    </section>
  );
}

function BookingAddOnPicker({
  addOns,
  className,
  description,
  onChange,
  selectedAddOnKey,
}: {
  addOns: DisplayBookingAddOn[];
  className?: string;
  description: string;
  onChange: (addOnKey: string | null) => void;
  selectedAddOnKey: string | null;
}) {
  return (
    <fieldset className={className}>
      <legend className="section-subheading mb-4 text-lg text-primary md:text-lg lg:text-lg">
        Optional add-on
      </legend>
      <p className="mb-4 text-sm text-muted-foreground">{description}</p>
      <div className="space-y-3">
        <label
          className={`block w-full rounded-xl border p-4 text-left transition-colors ${selectedAddOnKey === null ? "border-lh-primary ring-1 ring-lh-primary" : "border-lh-line hover:border-lh-primary"}`}
        >
          <div className="flex items-center gap-3">
            <input
              type="radio"
              name="selectedAddOnKey"
              value=""
              checked={selectedAddOnKey === null}
              onChange={() => onChange(null)}
              className="h-4 w-4 shrink-0 border-lh-line text-lh-primary focus:ring-lh-primary"
            />
            <div className="flex flex-1 items-center justify-between gap-4">
              <span className="font-medium text-black">No add-on</span>
              <span className="text-sm text-lh-muted">Included</span>
            </div>
          </div>
        </label>
        {addOns.map((addOn) => {
          const isSelected = selectedAddOnKey === addOn.key;

          return (
            <label
              key={addOn.key}
              className={`block w-full rounded-xl border p-4 text-left transition-colors ${isSelected ? "border-lh-primary ring-1 ring-lh-primary" : "border-lh-line hover:border-lh-primary"}`}
            >
              <div className="flex items-start gap-3">
                <input
                  type="radio"
                  name="selectedAddOnKey"
                  value={addOn.key}
                  checked={isSelected}
                  onChange={() => onChange(addOn.key)}
                  className="mt-1 h-4 w-4 shrink-0 border-lh-line text-lh-primary focus:ring-lh-primary"
                />
                <div className="flex flex-1 items-start justify-between gap-4">
                  <div>
                    <p className="font-medium text-black">{addOn.name}</p>
                    <p className="mt-1 text-sm text-lh-muted">
                      {addOn.description}
                    </p>
                  </div>
                  <span className="shrink-0 font-medium text-black">
                    +{formatCad(addOn.price)}
                  </span>
                </div>
              </div>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function BookingSummary({
  offering,
  service,
  selectedAddOn,
  selectedSlot,
  timezone,
}: {
  offering?: PublicBookingOffering;
  service?: TService;
  selectedAddOn?: DisplayBookingAddOn;
  selectedSlot: string;
  timezone: string;
}) {
  if (!service && !offering) {
    return (
      <p className="text-sm text-lh-muted">Select a service to continue.</p>
    );
  }

  const title = offering?.serviceTitle ?? service?.title ?? "Service";
  const fullPrice = offering
    ? offering.fullPriceCents / 100
    : (service?.fullPrice ?? 0);
  const durationMinutes =
    (offering?.durationMinutes ?? service?.durationMinutes ?? 0) +
    (selectedAddOn?.durationDeltaMinutes ?? 0);

  return (
    <div className="space-y-4">
      <div className="flex justify-between text-sm">
        <span className="font-medium text-black">{title}</span>
        <span className="text-black">{formatCad(fullPrice)}</span>
      </div>
      {offering && (
        <div className="text-sm text-lh-muted">
          With {offering.provider.displayName}
        </div>
      )}
      <div className="text-sm text-lh-muted">{durationMinutes} min</div>
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
          <span>
            {formatCad(fullPrice + (selectedAddOn?.price ?? 0))}
          </span>
        </div>
      </div>
    </div>
  );
}

function fetchAvailability(serviceSlug: string): Promise<Response> {
  const availabilityParams = new URLSearchParams({ service: serviceSlug });
  return fetch(`/api/booking/availability?${availabilityParams.toString()}`, {
    cache: "no-store",
  });
}

export function fetchOfferingAvailability(
  offeringId: string,
  selectedAddOnKey: string | null = null,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const availabilityParams = new URLSearchParams({ offeringId });

  if (selectedAddOnKey) {
    availabilityParams.set("selectedAddOnKey", selectedAddOnKey);
  }

  return fetcher(
    `/api/booking/availability?${availabilityParams.toString()}`,
    { cache: "no-store" },
  );
}

export async function createBookingHold(
  input: ServiceHoldInput,
): Promise<{ paymentPageUrl: string; paymentSessionReference: string }> {
  const fetcher = input.fetcher ?? fetch;
  const bookingIdentity =
    "offeringId" in input
      ? { offeringId: input.offeringId }
      : { serviceSlug: input.serviceSlug };
  const legacySourcePath =
    "serviceSlug" in input ? { sourcePath: input.sourcePath } : {};
  const holdRes = await fetcher("/api/booking/holds", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      answers: input.answers,
      ...bookingIdentity,
      ...(input.selectedAddOnKey
        ? { selectedAddOnKey: input.selectedAddOnKey }
        : {}),
      ...legacySourcePath,
      start: input.start,
    }),
  });

  if (!holdRes.ok) {
    const data = await holdRes.json();
    throw new Error(readResponseError(data, "Failed to hold appointment time"));
  }

  const holdData = (await holdRes.json()) as {
    hold?: {
      paymentPageUrl?: unknown;
      paymentSessionReference?: unknown;
    };
  };
  const paymentPageUrl = holdData.hold?.paymentPageUrl;
  const paymentSessionReference = holdData.hold?.paymentSessionReference;

  if (
    typeof paymentPageUrl !== "string" ||
    paymentPageUrl.length === 0 ||
    typeof paymentSessionReference !== "string" ||
    paymentSessionReference.length === 0
  ) {
    throw new Error("Failed to hold appointment time");
  }

  return { paymentPageUrl, paymentSessionReference };
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
