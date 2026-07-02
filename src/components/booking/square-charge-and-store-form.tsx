"use client";

import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import {
  fetchSquareCardOnFileConfig,
  loadSquareScript,
} from "./square-card-on-file-form";

export interface SquareChargeAndStoreBuyerDetails {
  amountCents: number;
  email: string;
  fullName: string;
  phone: string;
}

export interface SquareChargeAndStoreTokenResult {
  sourceId: string;
  verificationToken?: string;
}

interface SquareChargeAndStoreFormProps {
  buyer: SquareChargeAndStoreBuyerDetails | null;
  disabled: boolean;
  onError: (message: string) => void;
  onTokenized: (result: SquareChargeAndStoreTokenResult) => Promise<void>;
}

export interface SquareChargeAndStoreFormHandle {
  tokenize(): Promise<void>;
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
  intent: "CHARGE_AND_STORE";
  customerInitiated: boolean;
  sellerKeyedIn: boolean;
  billingContact: {
    givenName: string;
    familyName: string;
    email: string;
    phone: string;
    countryCode: string;
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

export const SquareChargeAndStoreForm = forwardRef<
  SquareChargeAndStoreFormHandle,
  SquareChargeAndStoreFormProps
>(function SquareChargeAndStoreForm(
  { buyer, disabled, onError, onTokenized },
  ref,
) {
  const reactId = useId();
  const cardContainerId = `square-charge-card-container-${reactId.replace(/:/g, "")}`;
  const [isConfigLoading, setIsConfigLoading] = useState(true);
  const [isInitializing, setIsInitializing] = useState(false);
  const [isCardReady, setIsCardReady] = useState(false);
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
            onError("Square booking payments are not available.");
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
            : "Failed to load Square payments configuration",
        );
      }
    }

    loadConfig();

    return () => {
      isMountedRef.current = false;
    };
  }, [onError]);

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
        if (disabled) {
          onError("Please complete the form before paying.");
          return;
        }

        if (buyer === null) {
          onError("Please complete the form before paying.");
          return;
        }

        if (cardRef.current === null) {
          onError(
            "Secure card form is not ready. Please wait a moment and try again.",
          );
          return;
        }

        const [givenName, familyName] = splitFullName(buyer.fullName);
        const verificationDetails: SquareVerificationDetails = {
          amount: formatCentsAsSquareAmount(buyer.amountCents),
          currencyCode: "CAD",
          intent: "CHARGE_AND_STORE",
          customerInitiated: true,
          sellerKeyedIn: false,
          billingContact: {
            givenName,
            familyName,
            email: buyer.email,
            phone: buyer.phone,
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
    [buyer, disabled, onError, onTokenized],
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

      {/* Square card.attach() only accepts div or span containers, not section. */}
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
