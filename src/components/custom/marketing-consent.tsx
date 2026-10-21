"use client";
import { useState } from "react";
import {
  EMAIL_CONSENT_TEXT,
  SMS_CONSENT_TEXT,
  type CheckoutMarketing,
} from "@/lib/highlevel/contract";

/** Native named controls work with both FormData and existing controlled forms. */
export function MarketingConsent({
  id,
  disabled = false,
  includeEmail = true,
  includePhone = false,
  onChange,
}: {
  id: string;
  disabled?: boolean;
  includeEmail?: boolean;
  includePhone?: boolean;
  onChange?: (value: CheckoutMarketing) => void;
}) {
  const [sms, setSms] = useState(false);
  const [email, setEmail] = useState(false);
  const [phone, setPhone] = useState("");
  const emit = (values: CheckoutMarketing) =>
    onChange?.({
      marketingConsent: email,
      smsMarketingConsent: sms,
      phone,
      ...values,
    });
  return (
    <fieldset className="space-y-3 text-sm leading-relaxed" disabled={disabled}>
      <legend className="mb-2 text-sm font-medium">
        Marketing preferences (optional)
      </legend>
      {includeEmail && (
        <label
          htmlFor={`${id}-email-consent`}
          className="flex items-start gap-3"
        >
          <input
            id={`${id}-email-consent`}
            name="marketingConsent"
            type="checkbox"
            checked={email}
            onChange={(event) => {
              setEmail(event.target.checked);
              emit({ marketingConsent: event.target.checked });
            }}
            className="mt-1 size-4 shrink-0 accent-lh-primary"
          />
          <span>{EMAIL_CONSENT_TEXT}</span>
        </label>
      )}
      <label htmlFor={`${id}-sms-consent`} className="flex items-start gap-3">
        <input
          id={`${id}-sms-consent`}
          name="smsMarketingConsent"
          type="checkbox"
          checked={sms}
          onChange={(event) => {
            setSms(event.target.checked);
            emit({ smsMarketingConsent: event.target.checked });
          }}
          className="mt-1 size-4 shrink-0 accent-lh-primary"
        />
        <span>{SMS_CONSENT_TEXT}</span>
      </label>
      {includePhone && sms && (
        <div className="space-y-1">
          <label htmlFor={`${id}-marketing-phone`}>
            Phone number for text messages
          </label>
          <input
            id={`${id}-marketing-phone`}
            name="marketingPhone"
            value={phone}
            onChange={(event) => {
              setPhone(event.target.value);
              emit({ phone: event.target.value });
            }}
            type="tel"
            autoComplete="tel"
            required
            maxLength={40}
            placeholder="+1 416 555 0123"
            className="form-input w-full"
          />
        </div>
      )}
    </fieldset>
  );
}
