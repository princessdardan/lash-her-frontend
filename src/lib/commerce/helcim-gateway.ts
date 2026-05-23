import {
  createHelcimInvoice,
  getHelcimCardTransaction,
  initializeHelcimPay,
} from "./helcim-client";
import type {
  HelcimCardTransactionResponse,
  HelcimInvoiceRequest,
  HelcimInvoiceResponse,
  HelcimPayInitializeRequest,
  HelcimPayInitializeResponse,
} from "./helcim-types";

export interface HelcimGateway {
  createInvoice(request: HelcimInvoiceRequest): Promise<HelcimInvoiceResponse>;
  initializePay(request: HelcimPayInitializeRequest): Promise<HelcimPayInitializeResponse>;
  getCardTransaction(cardTransactionId: string): Promise<HelcimCardTransactionResponse>;
}

export function createLiveHelcimGateway(): HelcimGateway {
  return {
    createInvoice: createHelcimInvoice,
    initializePay: initializeHelcimPay,
    getCardTransaction: getHelcimCardTransaction,
  };
}
