"use client";

import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import { loadSquareScript } from "@/components/booking/square-card-on-file-form";

interface SquareConfigResponse {
  applicationId: string;
  environment: "sandbox" | "production";
  locationId: string;
  locale: string;
  scriptUrl: string;
}

/**
 * Public Web Payments SDK config for product/training checkout. Returns null
 * when Square commerce checkout is not enabled (the caller should fall back).
 */
export async function fetchSquareCommerceConfig(
  fetcher?: typeof fetch,
): Promise<SquareConfigResponse | null> {
  const f = fetcher ?? fetch;
  const response = await f("/api/checkout/square/config", {
    cache: "no-store",
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(
      typeof data.error === "string"
        ? data.error
        : "Failed to load Square checkout configuration",
    );
  }

  return response.json() as Promise<SquareConfigResponse>;
}

export interface SquareCommerceBuyerDetails {
  amountCents: number;
  email: string;
  fullName: string;
  phone?: string;
}

export interface SquareCommerceTokenResult {
  sourceId: string;
  verificationToken?: string;
}

interface SquareCommerceCardFormProps {
  buyer: SquareCommerceBuyerDetails | null;
  disabled: boolean;
  onError: (message: string) => void;
  onReadyChange?: (ready: boolean) => void;
  onConfigUnavailable?: () => void;
  onTokenized: (result: SquareCommerceTokenResult) => Promise<void>;
}

export interface SquareCommerceCardFormHandle {
  tokenize(): Promise<void>;
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
  intent: "CHARGE";
  customerInitiated: boolean;
  sellerKeyedIn: boolean;
  billingContact: {
    givenName: string;
    familyName: string;
    email: string;
    phone?: string;
    countryCode: string;
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

export const SquareCommerceCardForm = forwardRef<
  SquareCommerceCardFormHandle,
  SquareCommerceCardFormProps
>(function SquareCommerceCardForm(
  { buyer, disabled, onError, onReadyChange, onConfigUnavailable, onTokenized },
  ref,
) {
  const reactId = useId();
  const cardContainerId = `square-commerce-card-container-${reactId.replace(/:/g, "")}`;
  const [isConfigLoading, setIsConfigLoading] = useState(true);
  const [isInitializing, setIsInitializing] = useState(false);
  const [isCardReady, setIsCardReady] = useState(false);
  const [config, setConfig] = useState<SquareConfigResponse | null>(null);
  const cardRef = useRef<SquareCard | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    onReadyChange?.(isCardReady);
  }, [isCardReady, onReadyChange]);

  useEffect(() => {
    isMountedRef.current = true;

    async function loadConfig() {
      try {
        const configData = await fetchSquareCommerceConfig();

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
            : "Failed to load Square checkout configuration",
        );
      }
    }

    loadConfig();

    return () => {
      isMountedRef.current = false;
    };
  }, [onError, onConfigUnavailable]);

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

      try {
        await loadSquareScript(scriptUrl);

        const squareGlobal = (window as unknown as { Square?: SquareGlobal })
          .Square;

        if (isCancelled || typeof squareGlobal?.payments !== "function") {
          throw new Error("Square payments SDK is not available");
        }

        const payments = await squareGlobal.payments(applicationId, locationId);
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
        onError(
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
  }, [config, cardContainerId, onError]);

  useImperativeHandle(
    ref,
    () => ({
      async tokenize() {
        // Throw (rather than onError + return) so the caller's try/catch resets
        // its busy state. Returning normally here would leave the Pay button
        // stuck on "Processing…" with no way forward, since the success path
        // deliberately keeps the busy state while it navigates away.
        if (disabled || buyer === null) {
          throw new Error("Please complete the form before paying.");
        }

        if (cardRef.current === null) {
          throw new Error(
            "Secure card form is not ready. Please wait a moment and try again.",
          );
        }

        const [givenName, familyName] = splitFullName(buyer.fullName);
        const verificationDetails: SquareVerificationDetails = {
          amount: formatCentsAsSquareAmount(buyer.amountCents),
          currencyCode: "CAD",
          intent: "CHARGE",
          customerInitiated: true,
          sellerKeyedIn: false,
          billingContact: {
            givenName,
            familyName,
            email: buyer.email,
            ...(buyer.phone ? { phone: buyer.phone } : {}),
            countryCode: "CA",
          },
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

        await onTokenized({
          sourceId: tokenizeResult.token,
          verificationToken: tokenizeResult.verificationToken,
        });
      },
    }),
    [buyer, disabled, onTokenized],
  );

  const isConfigUnavailable = config === null && !isConfigLoading;

  if (isConfigUnavailable) {
    return null;
  }

  return (
    <div className="space-y-3">
      {(isConfigLoading || isInitializing) && (
        <p className="text-center font-body text-sm font-bold leading-6 text-lh-muted">
          Loading secure card form...
        </p>
      )}

      <p className="text-sm leading-snug text-lh-muted">
        Secure card entry, including postal code when required by your card
        issuer
      </p>

      {/* Square card.attach() only accepts div or span containers. */}
      <div
        id={cardContainerId}
        className="min-h-[120px] rounded-xl border border-lh-line bg-white p-4"
      />

      {!isCardReady && !isConfigLoading && !isInitializing && (
        <div
          role="alert"
          className="text-center text-sm font-medium text-red-600"
        >
          Secure card form failed to load. Please refresh the page.
        </div>
      )}
    </div>
  );
});

function splitFullName(fullName: string): [string, string] {
  const trimmed = fullName.trim();
  const parts = trimmed.split(/\s+/);
  const givenName = parts[0] ?? "";
  const familyName = parts.slice(1).join(" ");
  return [givenName, familyName];
}

function formatCentsAsSquareAmount(cents: number): string {
  return (cents / 100).toFixed(2);
}
