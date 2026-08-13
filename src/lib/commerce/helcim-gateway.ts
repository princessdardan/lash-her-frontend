import {
  createHelcimInvoice,
  getHelcimCardTransaction,
  refundHelcimPayment,
  initializeHelcimPay,
} from "./helcim-client";
import type {
  HelcimCardTransactionResponse,
  HelcimInvoiceRequest,
  HelcimInvoiceResponse,
  HelcimPayInitializeRequest,
  HelcimPayInitializeResponse,
  HelcimRefundRequest,
  HelcimRefundResponse,
} from "./helcim-types";

export interface HelcimGateway {
  createInvoice(request: HelcimInvoiceRequest): Promise<HelcimInvoiceResponse>;
  initializePay(
    request: HelcimPayInitializeRequest,
  ): Promise<HelcimPayInitializeResponse>;
  getCardTransaction(
    cardTransactionId: string,
  ): Promise<HelcimCardTransactionResponse>;
  refundPayment(
    request: HelcimRefundRequest,
    idempotencyKey: string,
  ): Promise<HelcimRefundResponse>;
}

export function createLiveHelcimGateway(): HelcimGateway {
  return {
    createInvoice: createHelcimInvoice,
    initializePay: initializeHelcimPay,
    getCardTransaction: getHelcimCardTransaction,
    refundPayment: refundHelcimPayment,
  };
}
