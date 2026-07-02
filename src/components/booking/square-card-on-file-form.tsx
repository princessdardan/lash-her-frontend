"use client";

import { useEffect, useId, useRef, useState } from "react";

import {
  SERVICE_NO_SHOW_POLICY_TEXT,
  SERVICE_NO_SHOW_POLICY_VERSION,
} from "@/lib/booking/payments/service-no-show-policy-copy";

interface SquareCardOnFileFormProps {
  cardholderName: string;
  maxChargeCents: number;
  paymentSessionReference: string;
  onSuccess: (result: CardOnFileConfirmationResult) => void;
  onError: (message: string) => void;
  onHoldExpired?: () => void;
  onConfigUnavailable?: () => void;
}

export interface CardOnFileConfirmationResult {
  bookingStatus: "booked" | "manual_followup";
  card: { brand?: string; expMonth?: number; expYear?: number; last4?: string };
  holdReference: string;
  noShowChargeStatus: "ready" | "provider_draft_created" | "manual_followup";
}

interface SquareConfigResponse {
  applicationId: string;
  environment: "sandbox" | "production";
  locationId: string;
  locale: string;
  scriptUrl: string;
}

interface SquarePaymentsInstance {
  card(): Promise<SquareCard>;
  setLocale?(locale: string): void | Promise<void>;
}

interface SquareCard {
  attach(selector: string): Promise<void>;
  destroy(): void;
  tokenize(
    verificationDetails?: SquareVerificationDetails,
  ): Promise<SquareTokenizeResult>;
}

interface SquareVerificationDetails {
  amount: string;
  currencyCode: string;
  intent: "STORE" | "CHARGE" | "CHARGE_AND_STORE";
  customerInitiated: boolean;
  sellerKeyedIn: boolean;
  billingContact?: {
    postalCode?: string;
  };
}

interface SquareTokenizeResult {
  status: "OK" | "ERROR";
  token?: string;
  verificationToken?: string;
  errors?: Array<{ message: string; code?: string }>;
}

interface SquareGlobal {
  payments(
    applicationId: string,
    locationId: string,
  ): Promise<SquarePaymentsInstance>;
}

declare global {
  interface Window {
    Square?: SquareGlobal;
  }
}

const scriptPromises = new Map<string, Promise<void>>();

export async function fetchSquareCardOnFileConfig(
  fetcher?: typeof fetch,
): Promise<SquareConfigResponse | null> {
  const f = fetcher ?? fetch;
  const response = await f("/api/booking/square/config", { cache: "no-store" });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(
      typeof data.error === "string"
        ? data.error
        : "Failed to load card-on-file configuration",
    );
  }

  return response.json() as Promise<SquareConfigResponse>;
}

export function SquareCardOnFileForm({
  cardholderName,
  maxChargeCents,
  paymentSessionReference,
  onSuccess,
  onError,
  onHoldExpired,
  onConfigUnavailable,
}: SquareCardOnFileFormProps) {
  const reactId = useId();
  const cardContainerId = `square-card-container-${reactId.replace(/:/g, "")}`;
  const [isConfigLoading, setIsConfigLoading] = useState(true);
  const [isInitializing, setIsInitializing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCardReady, setIsCardReady] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [policyAccepted, setPolicyAccepted] = useState(false);
  const [config, setConfig] = useState<SquareConfigResponse | null>(null);
  const cardRef = useRef<SquareCard | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;

    async function loadConfig() {
      try {
        const configData = await fetchSquareCardOnFileConfig();

        if (configData === null) {
          if (isMountedRef.current) {
            setIsConfigLoading(false);
            onConfigUnavailable?.();
          }
          return;
        }

        if (!isMountedRef.current) {
          return;
        }

        setConfig(configData);
        setIsConfigLoading(false);
      } catch (error: unknown) {
        if (!isMountedRef.current) {
          return;
        }

        setIsConfigLoading(false);
        onError(
          error instanceof Error
            ? error.message
            : "Failed to load card-on-file configuration",
        );
      }
    }

    loadConfig();

    return () => {
      isMountedRef.current = false;
    };
  }, [onConfigUnavailable, onError]);

  useEffect(() => {
    const currentConfig = config;

    if (currentConfig === null) {
      return;
    }

    const { applicationId, locationId, locale, scriptUrl } = currentConfig;
    let isCancelled = false;

    async function initializeSquare() {
      setIsInitializing(true);
      setIsCardReady(false);
      setErrorMessage("");

      try {
        await loadSquareScript(scriptUrl);

        if (isCancelled || typeof window.Square?.payments !== "function") {
          throw new Error("Square payments SDK is not available");
        }

        const payments = await window.Square.payments(
          applicationId,
          locationId,
        );
        await payments.setLocale?.(locale);
        const card = await payments.card();

        if (isCancelled) {
          card.destroy();
          return;
        }

        try {
          await card.attach(`#${cardContainerId}`);
        } catch (attachError: unknown) {
          card.destroy();
          throw attachError;
        }

        if (isCancelled) {
          card.destroy();
          return;
        }

        cardRef.current = card;
        setIsCardReady(true);
        setIsInitializing(false);
      } catch (error: unknown) {
        if (isCancelled) {
          return;
        }

        setIsCardReady(false);
        setIsInitializing(false);
        setErrorMessage(
          error instanceof Error
            ? error.message
            : "Failed to initialize secure card form",
        );
      }
    }

    initializeSquare();

    return () => {
      isCancelled = true;
      cardRef.current?.destroy();
      cardRef.current = null;
    };
  }, [config, cardContainerId]);

  const handleSaveCard = async () => {
    if (!policyAccepted) {
      setErrorMessage("Please accept the cancellation policy to continue.");
      return;
    }

    if (cardRef.current === null) {
      setErrorMessage(
        "Secure card form is not ready. Please wait a moment and try again.",
      );
      return;
    }

    setIsSubmitting(true);
    setErrorMessage("");

    try {
      const idempotencyKey = generateIdempotencyKey();
      const policyTextHash = await hashServiceNoShowPolicyText(
        SERVICE_NO_SHOW_POLICY_TEXT,
      );
      const verificationDetails: SquareVerificationDetails = {
        amount: formatCentsAsSquareAmount(maxChargeCents),
        currencyCode: "CAD",
        intent: "STORE",
        customerInitiated: true,
        sellerKeyedIn: false,
      };

      const tokenizeResult =
        await cardRef.current.tokenize(verificationDetails);

      if (
        tokenizeResult.status !== "OK" ||
        typeof tokenizeResult.token !== "string"
      ) {
        const messages = tokenizeResult.errors
          ?.map((error) => error.message)
          .filter(Boolean)
          .join("; ");
        throw new Error(
          messages ||
            "Your card could not be verified. Please check your details and try again.",
        );
      }

      const result = await confirmCardOnFileBooking({
        paymentSessionReference,
        cardholderName,
        sourceId: tokenizeResult.token,
        verificationToken: tokenizeResult.verificationToken,
        policy: {
          accepted: true,
          maxChargeCents,
          policyTextHash,
          policyVersion: SERVICE_NO_SHOW_POLICY_VERSION,
        },
        idempotencyKey,
      });

      onSuccess(result);
    } catch (error: unknown) {
      if (error instanceof BookingHoldExpiredError) {
        onHoldExpired?.();
        return;
      }

      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Failed to save card. Please try again.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const isConfigUnavailable = config === null && !isConfigLoading;

  if (isConfigUnavailable) {
    return null;
  }

  const maxChargeDollars = formatCentsAsDollars(maxChargeCents);

  return (
    <div className="space-y-5 rounded-[18px] border border-lh-line bg-lh-neutral-2 p-5 shadow-sm">
      <div className="text-center">
        <p className="font-heading text-lg uppercase tracking-[0.12em] text-lh-primary">
          Secure card on file
        </p>
        <p className="font-body text-sm font-bold leading-6 text-lh-muted">
          Your card will be stored for no-show protection. No payment is taken
          today.
        </p>
      </div>

      <div className="space-y-5">
        {(isConfigLoading || isInitializing) && (
          <p className="text-center font-body text-sm font-bold leading-6 text-lh-muted">
            Loading secure card form...
          </p>
        )}

        {/* Square card.attach() only accepts div or span containers, not section. */}
        <div
          id={cardContainerId}
          role="region"
          aria-label="Secure card entry"
          className="min-h-[120px] rounded-xl border border-lh-line bg-white p-4"
        />

        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            id="cardOnFilePolicyAccepted"
            checked={policyAccepted}
            onChange={(event) => setPolicyAccepted(event.target.checked)}
            className="mt-1 h-4 w-4 rounded border-input text-primary focus:ring-primary"
          />
          <label
            htmlFor="cardOnFilePolicyAccepted"
            className="text-sm leading-snug text-muted-foreground"
          >
            {SERVICE_NO_SHOW_POLICY_TEXT} The maximum authorized charge is{" "}
            <span className="font-medium text-black">{maxChargeDollars}</span>.
          </label>
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
          disabled={
            isSubmitting || isConfigLoading || isInitializing || !isCardReady
          }
          onClick={handleSaveCard}
          className="w-full rounded-full bg-lh-primary px-7 py-4 font-body text-sm font-bold uppercase tracking-[0.12em] text-lh-white transition-colors hover:bg-lh-accent disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSubmitting ? "Saving card..." : "Save card and confirm booking"}
        </button>
      </div>
    </div>
  );
}

export function loadSquareScript(
  scriptUrl: string,
  doc: Document = globalThis.document as Document,
): Promise<void> {
  const cached = scriptPromises.get(scriptUrl);
  if (cached !== undefined) {
    return cached;
  }

  const promise = new Promise<void>((resolve, reject) => {
    function failScript(error: Error, script?: Element | null) {
      if (script) {
        script.remove();
      }
      scriptPromises.delete(scriptUrl);
      reject(error);
    }

    const existing = doc.querySelector(`script[src="${scriptUrl}"]`);

    if (existing !== null) {
      if (typeof window !== "undefined" && window.Square !== undefined) {
        resolve();
        return;
      }

      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener(
        "error",
        () =>
          failScript(
            new Error("Failed to load Square payments script"),
            existing,
          ),
        { once: true },
      );
      return;
    }

    const script = doc.createElement("script");
    script.src = scriptUrl;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () =>
      failScript(new Error("Failed to load Square payments script"), script);
    doc.head.appendChild(script);
  });

  scriptPromises.set(scriptUrl, promise);
  return promise;
}

async function hashServiceNoShowPolicyText(text: string): Promise<string> {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
  const encoder = new TextEncoder();
  const data = encoder.encode(normalized);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function formatCentsAsSquareAmount(cents: number): string {
  return (cents / 100).toFixed(2);
}

function formatCentsAsDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function generateIdempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export class BookingHoldExpiredError extends Error {
  constructor() {
    super("Hold expired, choose another time.");
    this.name = "BookingHoldExpiredError";
  }
}

interface CardOnFileBookingRequestBody {
  cardholderName: string;
  fetcher?: typeof fetch;
  idempotencyKey: string;
  paymentSessionReference: string;
  policy: {
    accepted: true;
    maxChargeCents: number;
    policyTextHash: string;
    policyVersion: string;
  };
  sourceId: string;
  verificationToken?: string;
}

export async function confirmCardOnFileBooking(
  input: CardOnFileBookingRequestBody,
): Promise<CardOnFileConfirmationResult> {
  const fetcher = input.fetcher ?? fetch;
  const body = {
    paymentSessionReference: input.paymentSessionReference,
    cardholderName: input.cardholderName,
    sourceId: input.sourceId,
    verificationToken: input.verificationToken,
    policy: input.policy,
    idempotencyKey: input.idempotencyKey,
  };

  const response = await fetcher("/api/booking/card-on-file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));

    if (response.status === 409) {
      throw new BookingHoldExpiredError();
    }

    throw new Error(
      readResponseError(data, "Failed to save card and confirm booking"),
    );
  }

  const data = (await response.json()) as Record<string, unknown>;

  if (
    typeof data.holdReference !== "string" ||
    data.holdReference.length === 0 ||
    typeof data.bookingStatus !== "string" ||
    (data.bookingStatus !== "booked" &&
      data.bookingStatus !== "manual_followup") ||
    typeof data.noShowChargeStatus !== "string" ||
    !isValidNoShowChargeStatus(data.noShowChargeStatus)
  ) {
    throw new Error("Failed to save card and confirm booking");
  }

  return {
    holdReference: data.holdReference,
    bookingStatus:
      data.bookingStatus as CardOnFileConfirmationResult["bookingStatus"],
    noShowChargeStatus:
      data.noShowChargeStatus as CardOnFileConfirmationResult["noShowChargeStatus"],
    card: isCardDisplay(data.card) ? data.card : {},
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

function isValidNoShowChargeStatus(
  value: unknown,
): value is CardOnFileConfirmationResult["noShowChargeStatus"] {
  return (
    value === "ready" ||
    value === "provider_draft_created" ||
    value === "manual_followup"
  );
}

function isCardDisplay(
  value: unknown,
): value is CardOnFileConfirmationResult["card"] {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  const allowedKeys = ["brand", "expMonth", "expYear", "last4"];
  const keys = Object.keys(record);

  return keys.every((key) => allowedKeys.includes(key));
}
