import {
  createHelcimInvoice,
  getHelcimCardTransaction,
  getHelcimInvoice,
  getHelcimInvoicesByNumber,
  refundHelcimPayment,
  initializeHelcimPay,
} from "./helcim-client";
import type {
  HelcimCardTransactionResponse,
  HelcimInvoiceRequest,
  HelcimInvoiceCollectionResponse,
  HelcimInvoiceDetails,
  HelcimInvoiceResponse,
  HelcimPayInitializeRequest,
  HelcimPayInitializeResponse,
  HelcimRefundRequest,
  HelcimRefundResponse,
} from "./helcim-types";

export interface HelcimGateway {
  createInvoice(request: HelcimInvoiceRequest): Promise<HelcimInvoiceResponse>;
  getInvoice?(invoiceId: number): Promise<HelcimInvoiceDetails>;
  getInvoicesByNumber?(
    invoiceNumber: string,
  ): Promise<HelcimInvoiceCollectionResponse>;
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
    getInvoice: getHelcimInvoice,
    getInvoicesByNumber: getHelcimInvoicesByNumber,
    initializePay: initializeHelcimPay,
    getCardTransaction: getHelcimCardTransaction,
    refundPayment: refundHelcimPayment,
  };
}
