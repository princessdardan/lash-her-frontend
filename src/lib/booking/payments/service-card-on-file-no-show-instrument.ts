import type { SquareInvoicesClient } from "@/lib/payments/square/invoice-client";

import type { NoShowInstrumentStep } from "./service-card-on-file";
import {
  createDraftNoShowInvoice,
  NoShowInvoiceBlockedError,
  NoShowInvoicePersistenceError,
  NoShowInvoiceSquareApiError,
  type CreateDraftNoShowInvoiceRepository,
} from "./service-no-show-invoice";
import type { ServicePaymentAlertLogger } from "./service-payment-alerts";

export interface CardOnFileNoShowInstrumentOptions {
  allowLocalFallback: boolean;
  locationId: string;
  repository: CreateDraftNoShowInvoiceRepository;
  squareInvoices: SquareInvoicesClient;
  alerts: ServicePaymentAlertLogger;
}

export function createCardOnFileNoShowInstrumentStep(
  options: CardOnFileNoShowInstrumentOptions,
): NoShowInstrumentStep {
  return {
    async createInstrument(input) {
      try {
        const result = await createDraftNoShowInvoice(
          {
            cardId: input.squareCardId,
            customerEmail: input.customerEmail,
            customerId: input.squareCustomerId,
            holdId: input.holdId,
            idempotencyKey: input.idempotencyKey,
            maxChargeCents: input.maxChargeCents,
            noShowChargeRecordId: input.noShowChargeRecordId,
            serviceDescription: input.serviceDescription,
          },
          {
            locationId: options.locationId,
            repository: options.repository,
            squareInvoices: options.squareInvoices,
          },
        );

        return { status: result.status };
      } catch (error) {
        const reason =
          error instanceof Error
            ? error.message
            : "Unknown no-show invoice failure";

        if (
          error instanceof NoShowInvoiceSquareApiError &&
          options.allowLocalFallback
        ) {
          try {
            await options.repository.updateNoShowChargeRecord({
              noShowChargeRecordId: input.noShowChargeRecordId,
              status: "manual_followup",
            });
          } catch {
            throw new NoShowInvoiceBlockedError(
              error instanceof Error
                ? error.message
                : "Failed to fall back to manual no-show record",
            );
          }

          await options.alerts.alert({
            category: "no_show_charge_failed",
            severity: "warning",
            message:
              "Square no-show invoice creation failed; local manual follow-up enabled",
            context: {
              holdId: input.holdId,
              noShowChargeRecordId: input.noShowChargeRecordId,
              reason,
              squareApiError: true,
            },
          });

          return { status: "manual_followup" };
        }

        if (
          error instanceof NoShowInvoiceBlockedError ||
          error instanceof NoShowInvoicePersistenceError
        ) {
          throw new NoShowInvoiceBlockedError(
            error instanceof Error
              ? error.message
              : "No-show invoice creation failed",
            error.context,
          );
        }

        throw new NoShowInvoiceBlockedError(reason);
      }
    },
  };
}
