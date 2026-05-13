import type { ValidatedCartLineItem } from "./cart";

export type HelcimPayloadValue = string | number | boolean | null;

export type HelcimInvoiceLineItem = Pick<
  ValidatedCartLineItem,
  "sku" | "description" | "quantity" | "price"
>;

export interface HelcimInvoiceRequest {
  type: "INVOICE";
  status: "DUE";
  currency: "CAD";
  notes: string;
  lineItems: HelcimInvoiceLineItem[];
}

export interface HelcimInvoiceResponse {
  invoiceId: number;
  invoiceNumber: string;
}

export interface HelcimPayInitializeRequest {
  paymentType: "purchase";
  amount: number;
  currency: "CAD";
  invoiceNumber: string;
}

export interface HelcimPayInitializeResponse {
  checkoutToken: string;
  secretToken: string;
}

export interface HelcimPaySuccessPayload {
  data: Record<string, HelcimPayloadValue>;
  hash: string;
}

export type HelcimCardTransactionResponse = Record<string, unknown>;

export interface HelcimTransactionReconciliationFields {
  amount?: number | string;
  approvalCode?: string;
  cardLast4?: string;
  cardType?: string;
  currency?: string;
  invoiceNumber?: string;
  status?: string;
  transactionId?: string;
}
