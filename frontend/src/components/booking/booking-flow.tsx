"use client";

import { useState, useEffect, useMemo } from "react";
import { nanoid } from "nanoid";
import type { BookingSettings, BookingType, BookingSlot, BookingAnswerInput } from "@/lib/booking/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, FieldLabel, FieldError, FieldDescription } from "@/components/ui/field";

interface BookingFlowProps {
  settings: BookingSettings;
  initialBookingType?: BookingType;
}

export function BookingFlow({ settings, initialBookingType }: BookingFlowProps) {
  const defaultType = initialBookingType ?? settings.bookingTypes[0]?.type ?? "training-call";
  const [bookingType, setBookingType] = useState<BookingType | "">(defaultType);
  const [slots, setSlots] = useState<BookingSlot[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<string>("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  
  const [isLoadingSlots, setIsLoadingSlots] = useState(!!defaultType);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitStatus, setSubmitStatus] = useState<"idle" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");

  const activeTypeConfig = useMemo(() => {
    return settings.bookingTypes.find((t) => t.type === bookingType);
  }, [bookingType, settings.bookingTypes]);

  useEffect(() => {
    if (!bookingType) {
      return;
    }

    let isMounted = true;

    fetch(`/api/booking/availability?type=${bookingType}`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch availability");
        return res.json();
      })
      .then((data) => {
        if (isMounted) {
          setSlots(data.slots || []);
          setSelectedSlot("");
          setIsLoadingSlots(false);
        }
      })
      .catch(() => {
        if (isMounted) {
          setErrorMessage("Could not load available times. Please try again later.");
          setIsLoadingSlots(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [bookingType]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bookingType || !selectedSlot || !name || !email || !phone) {
      setErrorMessage("Please fill in all required fields.");
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
          idempotencyKey: nanoid(),
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
      <div aria-live="polite" className="sr-only">
        {errorMessage && `Error: ${errorMessage}`}
        {isLoadingSlots && "Loading available times..."}
      </div>

      <Field>
        <FieldLabel htmlFor="bookingType">Service Type</FieldLabel>
        <Select 
          value={bookingType} 
          onValueChange={(val) => {
            setBookingType(val as BookingType);
            if (!val) {
              setSlots([]);
              setSelectedSlot("");
              setIsLoadingSlots(false);
            } else {
              setIsLoadingSlots(true);
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
      </Field>

      {bookingType && (
        <Field>
          <FieldLabel htmlFor="selectedSlot">Available Times</FieldLabel>
          <Select value={selectedSlot} onValueChange={setSelectedSlot} disabled={isLoadingSlots || slots.length === 0}>
            <SelectTrigger id="selectedSlot">
              <SelectValue placeholder={isLoadingSlots ? "Loading..." : slots.length === 0 ? "No times available" : "Select a time"} />
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
            <Field>
              <FieldLabel htmlFor="email">Email Address</FieldLabel>
              <Input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="jane@example.com"
              />
            </Field>
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

          {activeTypeConfig?.questions.map((q) => (
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

          <div className="flex items-start gap-3 pt-4">
            <input
              type="checkbox"
              id="marketingOptIn"
              checked={marketingOptIn}
              onChange={(e) => setMarketingOptIn(e.target.checked)}
              className="mt-1 h-4 w-4 rounded border-input text-primary focus:ring-primary"
            />
            <label htmlFor="marketingOptIn" className="text-sm text-muted-foreground leading-snug">
              {settings.marketingOptInLabel || "I would like to receive updates and offers."}
            </label>
          </div>

          {errorMessage && (
            <FieldError className="text-center">{errorMessage}</FieldError>
          )}

          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? "Confirming..." : "Confirm Booking"}
          </Button>
        </div>
      )}
    </form>
  );
}
