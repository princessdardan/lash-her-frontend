import { createHash } from "node:crypto";

import type {
  HelcimInvoiceCollectionResponse,
  HelcimInvoiceDetails,
  HelcimInvoiceLineItem,
  HelcimInvoiceRequest,
} from "./helcim-types";
import type {
  checkoutOrders,
  orderPaymentObligations,
} from "@/lib/private-db/schema";

type Obligation = Pick<
  typeof orderPaymentObligations.$inferSelect,
  | "currency"
  | "id"
  | "merchandiseAmountCents"
  | "policyVersion"
  | "purpose"
  | "shippingAmountCents"
  | "taxAmountCents"
  | "taxPolicyVersion"
  | "totalAmountCents"
> & {
  disclosureSnapshot?: Record<string, unknown> | null;
};

type OrderInvoiceContext = Pick<
  typeof checkoutOrders.$inferSelect,
  | "lineItems"
  | "promotionCode"
  | "promotionDiscountCents"
  | "shippingAmountCents"
>;

export interface PaymentObligationInvoicePlan {
  invoiceNumber: string;
  lineItems: HelcimInvoiceLineItem[];
  notes: string;
  request: HelcimInvoiceRequest;
  totalAmountCents: number;
}

export interface VerifiedHelcimInvoiceEvidence {
  amountCents: number;
  currency: "CAD";
  evidenceHash: string;
  invoiceId: number;
  invoiceNumber: string;
  kind: "invoice_verified";
  lineItemsHash: string;
  notesHash: string;
  observedAt: string;
  source: "helcim_api_get_invoice";
  status: "DUE";
  type: "INVOICE";
}

export interface VerifiedHelcimInvoiceAbsenceEvidence {
  evidenceHash: string;
  invoiceNumber: string;
  kind: "invoice_absent";
  observedAt: string;
  resultCount: 0;
  source: "helcim_api_get_invoices_exact_number";
}

export interface ManualPaymentInitializationHandoffEvidence {
  evidenceHash: string;
  kind: "manual_handoff";
  observedAt: string;
  source: "owner_manual_handoff";
}

export type PaymentInitializationProviderEvidence =
  | VerifiedHelcimInvoiceEvidence
  | VerifiedHelcimInvoiceAbsenceEvidence
  | ManualPaymentInitializationHandoffEvidence;

export function buildPaymentObligationInvoicePlan(
  obligation: Obligation,
  order: OrderInvoiceContext,
): PaymentObligationInvoicePlan {
  const lineItems =
    obligation.purpose === "primary"
      ? primaryInvoiceLines(obligation, order)
      : componentInvoiceLines(obligation);
  const computedTotalCents = lineItems.reduce(
    (total, line) => total + moneyToCents(line.price) * line.quantity,
    0,
  );
  if (computedTotalCents !== obligation.totalAmountCents) {
    throw new Error(
      "Invoice lines do not equal the immutable payment obligation",
    );
  }
  if (obligation.currency.toUpperCase() !== "CAD") {
    throw new Error("Only CAD payment obligations may create Helcim invoices");
  }
  const invoiceNumber = paymentObligationInvoiceNumber(obligation.id);
  const notes = paymentObligationInvoiceNotes(obligation.id);
  return {
    invoiceNumber,
    lineItems,
    notes,
    request: {
      currency: "CAD",
      invoiceNumber,
      lineItems,
      notes,
      status: "DUE",
      type: "INVOICE",
    },
    totalAmountCents: obligation.totalAmountCents,
  };
}

export function paymentObligationInvoiceNumber(obligationId: string): string {
  const compact = obligationId.replaceAll("-", "").toUpperCase();
  if (!/^[0-9A-F]{32}$/.test(compact)) {
    throw new Error("Payment obligation ID is invalid");
  }
  return `LH-${compact}`;
}

export function paymentObligationInvoiceNotes(obligationId: string): string {
  return `Lash Her payment obligation ${obligationId}`;
}

export function paymentObligationInitializationPayloadHash(input: {
  disclosureSnapshot?: Record<string, unknown> | null;
  id: string;
  policyVersion: string;
  purpose: string;
  taxPolicyVersion: string;
  totalAmountCents: number;
  currency: string;
}): string {
  return `v2:${sha256({
    currency: input.currency.toUpperCase(),
    helcimContract: input.disclosureSnapshot?.helcimContract ?? null,
    id: input.id,
    invoiceNumber: paymentObligationInvoiceNumber(input.id),
    policyVersion: input.policyVersion,
    purpose: input.purpose,
    taxPolicyVersion: input.taxPolicyVersion,
    totalAmountCents: input.totalAmountCents,
  })}`;
}

export function verifyHelcimInvoiceForObligation(input: {
  expectedInvoiceId: number;
  expectedInvoiceNumber?: string;
  invoice: HelcimInvoiceDetails;
  observedAt: Date;
  plan: PaymentObligationInvoicePlan;
}): VerifiedHelcimInvoiceEvidence {
  const invoiceId = positiveInteger(input.invoice.invoiceId, "invoice ID");
  if (invoiceId !== input.expectedInvoiceId) {
    throw new Error("Helcim invoice ID does not match the requested invoice");
  }
  const invoiceNumber = requiredText(
    input.invoice.invoiceNumber,
    "invoice number",
  );
  if (
    input.expectedInvoiceNumber &&
    invoiceNumber !== input.expectedInvoiceNumber.trim()
  ) {
    throw new Error("Helcim invoice number does not match submitted evidence");
  }
  const currency = requiredText(
    input.invoice.currency,
    "currency",
  ).toUpperCase();
  if (currency !== "CAD") throw new Error("Helcim invoice currency is not CAD");
  const status = requiredText(input.invoice.status, "status").toUpperCase();
  if (status !== "DUE")
    throw new Error("Helcim invoice is not payable in DUE state");
  const type = requiredText(input.invoice.type, "type").toUpperCase();
  if (type !== "INVOICE") throw new Error("Helcim record is not an invoice");
  const notes = requiredText(input.invoice.notes, "notes");
  if (notes !== input.plan.notes) {
    throw new Error(
      "Helcim invoice merchant reference does not match the obligation",
    );
  }
  const amountCents = moneyToCents(input.invoice.amount);
  if (amountCents !== input.plan.totalAmountCents) {
    throw new Error("Helcim invoice amount does not match the obligation");
  }
  const actualLineItems = normalizeProviderLineItems(input.invoice.lineItems);
  const expectedLineItems = normalizeExpectedLineItems(input.plan.lineItems);
  if (stableJson(actualLineItems) !== stableJson(expectedLineItems)) {
    throw new Error("Helcim invoice line items do not match the obligation");
  }
  const base = {
    amountCents,
    currency: "CAD" as const,
    invoiceId,
    invoiceNumber,
    kind: "invoice_verified" as const,
    lineItemsHash: sha256(actualLineItems),
    notesHash: sha256(notes),
    observedAt: input.observedAt.toISOString(),
    source: "helcim_api_get_invoice" as const,
    status: "DUE" as const,
    type: "INVOICE" as const,
  };
  return { ...base, evidenceHash: sha256(base) };
}

export function verifyHelcimInvoiceAbsence(input: {
  collection: HelcimInvoiceCollectionResponse;
  invoiceNumber: string;
  observedAt: Date;
}): VerifiedHelcimInvoiceAbsenceEvidence {
  const invoices = normalizeInvoiceCollection(input.collection);
  if (invoices.length !== 0) {
    const ids = invoices
      .map((invoice) => invoice.invoiceId)
      .filter((value) => value !== undefined)
      .map(String)
      .join(", ");
    throw new Error(
      `Helcim reports an existing invoice for the exact merchant invoice number${ids ? ` (${ids})` : ""}; adopt and verify it instead of reissuing`,
    );
  }
  const base = {
    invoiceNumber: input.invoiceNumber,
    kind: "invoice_absent" as const,
    observedAt: input.observedAt.toISOString(),
    resultCount: 0 as const,
    source: "helcim_api_get_invoices_exact_number" as const,
  };
  return { ...base, evidenceHash: sha256(base) };
}

export function manualPaymentInitializationHandoffEvidence(
  observedAt: Date,
): ManualPaymentInitializationHandoffEvidence {
  const base = {
    kind: "manual_handoff" as const,
    observedAt: observedAt.toISOString(),
    source: "owner_manual_handoff" as const,
  };
  return { ...base, evidenceHash: sha256(base) };
}

export function paymentInitializationProviderEvidenceIsValid(
  evidence: PaymentInitializationProviderEvidence,
  now: Date,
): boolean {
  const { evidenceHash, ...base } = evidence;
  const observedAt = Date.parse(evidence.observedAt);
  return (
    evidenceHash === sha256(base) &&
    Number.isFinite(observedAt) &&
    observedAt <= now.getTime() + 1_000 &&
    now.getTime() - observedAt <= 5 * 60_000
  );
}

function primaryInvoiceLines(
  obligation: Obligation,
  order: OrderInvoiceContext,
): HelcimInvoiceLineItem[] {
  const lines: HelcimInvoiceLineItem[] = order.lineItems.map((line) => ({
    description: line.description,
    price: line.unitPriceCents / 100,
    quantity: line.quantity,
    sku: line.sku,
  }));
  if ((order.promotionDiscountCents ?? 0) > 0) {
    lines.push({
      description: order.promotionCode
        ? `Promotion code ${order.promotionCode}`
        : "Promotion",
      price: -(order.promotionDiscountCents! / 100),
      quantity: 1,
      sku: order.promotionCode ?? "PROMOTION",
    });
  }
  if (obligation.shippingAmountCents > 0) {
    lines.push({
      description: "Insured tracked shipping",
      price: obligation.shippingAmountCents / 100,
      quantity: 1,
      sku: "SHIPPING",
    });
  }
  if (obligation.taxAmountCents > 0) {
    lines.push({
      description: "Product tax",
      price: obligation.taxAmountCents / 100,
      quantity: 1,
      sku: "TAX",
    });
  }
  return lines;
}

function componentInvoiceLines(
  obligation: Obligation,
): HelcimInvoiceLineItem[] {
  const lines: HelcimInvoiceLineItem[] = [];
  if (obligation.merchandiseAmountCents > 0) {
    lines.push({
      description: "Merchandise supplement",
      price: obligation.merchandiseAmountCents / 100,
      quantity: 1,
      sku: "MERCHANDISE-SUPPLEMENT",
    });
  }
  if (obligation.shippingAmountCents > 0) {
    lines.push({
      description:
        obligation.purpose === "address_increase"
          ? "Address-change shipping increase"
          : "Agreed manual shipping",
      price: obligation.shippingAmountCents / 100,
      quantity: 1,
      sku:
        obligation.purpose === "address_increase"
          ? "ADDRESS-INCREASE"
          : "MANUAL-SHIPPING",
    });
  }
  if (obligation.taxAmountCents > 0) {
    lines.push({
      description: "Supplemental tax",
      price: obligation.taxAmountCents / 100,
      quantity: 1,
      sku: "TAX-SUPPLEMENT",
    });
  }
  return lines;
}

function normalizeExpectedLineItems(lineItems: HelcimInvoiceLineItem[]) {
  return lineItems
    .map((line) => ({
      description: line.description.trim(),
      priceCents: moneyToCents(line.price),
      quantity: numeric(line.quantity, "line-item quantity"),
      sku: line.sku.trim(),
    }))
    .sort(compareLineItems);
}

function normalizeProviderLineItems(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Helcim invoice line items are missing");
  }
  return value
    .map((line) => {
      if (!line || typeof line !== "object" || Array.isArray(line)) {
        throw new Error("Helcim invoice line item is malformed");
      }
      const record = line as Record<string, unknown>;
      return {
        description: requiredText(record.description, "line-item description"),
        priceCents: moneyToCents(record.price),
        quantity: numeric(record.quantity, "line-item quantity"),
        sku: requiredText(record.sku, "line-item SKU"),
      };
    })
    .sort(compareLineItems);
}

function normalizeInvoiceCollection(
  value: HelcimInvoiceCollectionResponse,
): HelcimInvoiceDetails[] {
  const rows = Array.isArray(value)
    ? value
    : Array.isArray(value.data)
      ? value.data
      : Array.isArray(value.invoices)
        ? value.invoices
        : null;
  if (!rows) throw new Error("Helcim invoice search response is malformed");
  return rows;
}

function compareLineItems(
  left: {
    sku: string;
    description: string;
    quantity: number;
    priceCents: number;
  },
  right: {
    sku: string;
    description: string;
    quantity: number;
    priceCents: number;
  },
) {
  return stableJson(left).localeCompare(stableJson(right));
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Helcim ${label} is invalid`);
  }
  return parsed;
}

function numeric(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Helcim ${label} is invalid`);
  return parsed;
}

function moneyToCents(value: unknown): number {
  const amount = numeric(value, "money amount");
  const cents = Math.round(amount * 100);
  if (Math.abs(amount * 100 - cents) > 0.000001) {
    throw new Error("Helcim money amount has unsupported precision");
  }
  return cents;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Helcim ${label} is missing`);
  }
  return value.trim();
}

function sha256(value: unknown): string {
  const text = typeof value === "string" ? value : stableJson(value);
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
