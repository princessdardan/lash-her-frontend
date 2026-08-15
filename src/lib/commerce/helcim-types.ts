import type { ValidatedCartLineItem } from "./cart";

export type HelcimPayloadValue = string | number | boolean | null;

export type HelcimInvoiceLineItem = Pick<
  ValidatedCartLineItem,
  "sku" | "description" | "quantity" | "price"
> & {
  discountCode?: string;
  total?: number;
  taxAmount?: number;
  taxName?: string;
  taxRate?: number;
};

export interface HelcimInvoiceRequest {
  type: "INVOICE";
  status: "DUE";
  currency: "CAD";
  invoiceNumber?: string;
  notes: string;
  lineItems: HelcimInvoiceLineItem[];
}

export interface HelcimInvoiceResponse {
  invoiceId: number;
  invoiceNumber: string;
}

export interface HelcimInvoiceDetails {
  amount?: number | string;
  currency?: string;
  invoiceId?: number | string;
  invoiceNumber?: string;
  lineItems?: Array<Record<string, unknown>>;
  notes?: string;
  status?: string;
  type?: string;
  [key: string]: unknown;
}

export type HelcimInvoiceCollectionResponse =
  | HelcimInvoiceDetails[]
  | {
      data?: HelcimInvoiceDetails[];
      invoices?: HelcimInvoiceDetails[];
      [key: string]: unknown;
    };

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

export interface HelcimRefundRequest {
  originalTransactionId: number;
  amount: number;
  ipAddress: string;
  ecommerce: true;
}

export interface HelcimRefundResponse {
  transactionId: number | string;
  status?: string;
  transactionType?: string;
  originalTransactionId?: number | string;
  amount?: number;
  currency?: string;
  [key: string]: unknown;
}

export interface HelcimTransactionReconciliationFields {
  amount?: number | string;
  approvalCode?: string;
  cardLast4?: string;
  cardType?: string;
  currency?: string;
  invoiceId?: number;
  invoiceNumber?: string;
  status?: string;
  transactionId?: string;
  transactionType?: string;
  originalTransactionId?: string;
  avsCode?: string;
  cvvCode?: string;
}
