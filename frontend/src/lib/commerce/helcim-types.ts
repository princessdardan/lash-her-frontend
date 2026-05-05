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
  amount: number;
  currency: "CAD";
  invoiceId?: number;
  [key: string]: HelcimPayloadValue | undefined;
}

export interface HelcimPayInitializeResponse {
  checkoutToken: string;
  secretToken: string;
}

export interface HelcimPaySuccessPayload {
  data: Record<string, HelcimPayloadValue>;
  hash: string;
}
