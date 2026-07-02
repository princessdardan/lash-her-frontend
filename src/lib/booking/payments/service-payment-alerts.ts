export type ServicePaymentAlertSeverity = "info" | "warning" | "error";

export type ServicePaymentAlertCategory =
  | "square_return_pending_verification"
  | "square_webhook_non_finalized"
  | "square_webhook_retryable_failure"
  | "square_amount_or_currency_mismatch"
  | "square_customer_creation_failed"
  | "square_card_save_failed"
  | "booking_without_saved_card"
  | "booking_without_no_show_record"
  | "booking_calendar_finalization_failed"
  | "no_show_charge_failed"
  | "no_show_publish_unknown"
  | "no_show_charge_unknown_provider_event"
  | "no_show_charge_finalize_failed"
  | "no_show_charge_persistence_failed"
  | "no_show_charge_pending_reconciliation"
  | "no_show_charge_provider_mismatch"
  | "no_show_charge_recovery_lookup_failed"
  | "no_show_charge_missing_provider_reference"
  | "no_show_charge_paid_requires_manual_validation"
  | "no_show_charge_paid_without_payment_id"
  | "stuck_payment_state";

export interface ServicePaymentAlertContext {
  [key: string]: unknown;
}

export interface ServicePaymentAlertInput {
  category: ServicePaymentAlertCategory;
  context?: ServicePaymentAlertContext;
  message: string;
  severity: ServicePaymentAlertSeverity;
}

export interface ServicePaymentAlertLoggerDependencies {
  logError?: (...args: unknown[]) => void;
  logInfo?: (...args: unknown[]) => void;
  logWarn?: (...args: unknown[]) => void;
}

export interface ServicePaymentAlertLogger {
  alert(input: ServicePaymentAlertInput): void;
}

const SENSITIVE_KEY_PATTERN =
  /card|token|secret|cvv|cvc|pan|raw|source|paymentSessionReference|sessionReference/i;

// Provider reference identifiers may contain substrings like "card" or "payment"
// but are not secret values. Keep them visible in alerts for reconciliation.
const SAFE_PROVIDER_REFERENCE_KEYS = new Set([
  "squareCardId",
  "squareCustomerId",
  "squareInvoiceId",
  "squareOrderId",
  "squarePaymentId",
]);

function isSensitiveKey(key: string): boolean {
  if (SAFE_PROVIDER_REFERENCE_KEYS.has(key)) {
    return false;
  }

  return SENSITIVE_KEY_PATTERN.test(key);
}

function redactSensitiveValues(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveValues(item));
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const redacted: Record<string, unknown> = {};

    for (const [key, item] of Object.entries(record)) {
      if (isSensitiveKey(key)) {
        redacted[key] = "[redacted]";
      } else {
        redacted[key] = redactSensitiveValues(item);
      }
    }

    return redacted;
  }

  return value;
}

export function createServicePaymentAlertLogger(
  dependencies: ServicePaymentAlertLoggerDependencies,
): ServicePaymentAlertLogger {
  return {
    alert(input: ServicePaymentAlertInput): void {
      const payload = {
        category: input.category,
        context: input.context
          ? redactSensitiveValues(input.context)
          : undefined,
        severity: input.severity,
      };

      const message = `[service-payment-alert] ${input.message}`;

      if (input.severity === "error") {
        const logError =
          dependencies.logError ?? dependencies.logWarn ?? console.error;
        logError(message, payload);
      } else if (input.severity === "info") {
        const logInfo =
          dependencies.logInfo ?? dependencies.logWarn ?? console.warn;
        logInfo(message, payload);
      } else {
        const logWarn = dependencies.logWarn ?? console.warn;
        logWarn(message, payload);
      }
    },
  };
}
