import { escapeHtml } from "@/lib/transactional-email";
import * as v from "valibot";
import type { CourseOrder } from "./store";
import { rateTableTaxReference, readCourseTaxComponents } from "./tax";

type ReceiptOrder = Pick<
  CourseOrder,
  | "id"
  | "courseTitle"
  | "billing"
  | "chargedAt"
  | "receiptSeller"
  | "purchaseTerms"
  | "termsAcceptedAt"
  | "taxBreakdown"
  | "taxCents"
  | "totalCents"
  | "disclosure"
>;

const cad = Intl.NumberFormat("en-CA", {
  style: "currency",
  currency: "CAD",
  currencyDisplay: "code",
});
const dollars = (cents: number) => cad.format(cents / 100);

const torontoDate = Intl.DateTimeFormat("en-CA", {
  dateStyle: "long",
  timeZone: "America/Toronto",
});

const torontoDateTime = Intl.DateTimeFormat("en-CA", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "America/Toronto",
});

export function renderCourseReceipt(order: ReceiptOrder) {
  const heading = `<h1>Course payment receipt</h1><p>${escapeHtml(order.courseTitle)}</p>`;
  const disclosure = `<p>${escapeHtml(order.disclosure)}</p>`;
  const seller = order.receiptSeller;

  // Preserve the body for legacy outbox jobs that may already have used their
  // Resend idempotency key.
  if (seller === null) {
    return `${heading}<p>Order ${order.id}</p><p>Paid ${dollars(order.totalCents)} including tax of ${dollars(order.taxCents)}.</p>${disclosure}`;
  }

  if (!order.chargedAt) throw new Error("Course receipt requires a capture date");

  const components = readCourseTaxComponents(order.taxBreakdown);
  if (!components.length || components.reduce((sum, { amount }) => sum + amount, 0) !== order.taxCents)
    throw new Error("Course receipt requires a consistent tax snapshot");
  const taxDetails = components.map(({ label, amount, registrationNumber }) => {
    const registration = registrationNumber
      ? ` (registration number ${escapeHtml(registrationNumber)})`
      : "";
    return `<p>${escapeHtml(label)}: ${dollars(amount)}${registration}</p>`;
  });

  // Capture and quote fields describe the original sale even after a refund.
  const saleReceipt = [
    heading,
    `<p>Order ${escapeHtml(order.id)}</p>`,
    `<p>Payment date: ${torontoDate.format(order.chargedAt)}</p>`,
    `<p>Subtotal: ${dollars(order.totalCents - order.taxCents)}</p>`,
    ...taxDetails,
    `<p>Total paid: ${dollars(order.totalCents)}</p>`,
    `<p>${[seller.name, seller.address, seller.email, seller.phone].filter((line): line is string => Boolean(line)).map(escapeHtml).join("<br>")}</p>`,
    disclosure,
  ].join("");
  if (!order.purchaseTerms) return saleReceipt;
  if (!order.termsAcceptedAt) throw new Error("Course agreement requires an acceptance time");
  const { name, line1, city, region, postalCode, country } = order.billing;
  return [
    saleReceipt,
    "<h2>Course Purchase Terms</h2>",
    `<p>Buyer: ${[name, line1, `${city}, ${region} ${postalCode}`, country].map(escapeHtml).join("<br>")}</p>`,
    `<p>Version ${escapeHtml(order.purchaseTerms.version)}<br>Accepted ${torontoDateTime.format(order.termsAcceptedAt)} (Toronto time)</p>`,
    `<p>${escapeHtml(order.purchaseTerms.text).replaceAll("\n", "<br>")}</p>`,
  ].join("");
}

const refundTaxCents = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const refundTaxReceipt = v.object({
  version: v.literal(1),
  taxTransactionId: v.string(),
  refundId: v.string(),
  taxCents: refundTaxCents,
  fullyRefunded: v.boolean(),
  components: v.array(v.object({ taxCode: v.string(), taxCents: refundTaxCents })),
});

export function renderCourseRefundReceipt(
  order: ReceiptOrder,
  refund: { id: string; amountCents: number; confirmedAt: Date },
  recordedTax: string,
  issuedAt: Date,
) {
  const allocation = v.parse(refundTaxReceipt, JSON.parse(recordedTax));
  const original = readCourseTaxComponents(order.taxBreakdown);
  const byCode = new Map(allocation.components.map(({ taxCode, taxCents }) => [taxCode, taxCents]));
  if (
    !order.receiptSeller || !order.chargedAt || !original.length ||
    allocation.taxTransactionId !== rateTableTaxReference(order.id) ||
    allocation.refundId !== refund.id || allocation.taxCents > refund.amountCents ||
    byCode.size !== original.length || byCode.size !== allocation.components.length ||
    allocation.components.reduce((sum, { taxCents }) => sum + taxCents, 0) !== allocation.taxCents
  ) throw new Error("Course refund confirmation requires a consistent tax allocation");

  const taxDetails = original.map(({ taxCode, label, amount, registrationNumber }) => {
    const refunded = byCode.get(taxCode);
    if (refunded === undefined || refunded > amount || (refunded > 0 && !registrationNumber))
      throw new Error("Course refund confirmation requires the original tax components");
    const registration = refunded > 0 && registrationNumber ? ` (${escapeHtml(registrationNumber)})` : "";
    return `<p>${escapeHtml(label)} refunded: ${dollars(refunded)}${registration}</p>`;
  });
  const seller = order.receiptSeller;
  return [
    "<h1>Course refund confirmation</h1>",
    `<p>We issued a refund for ${escapeHtml(order.courseTitle)}.</p>`,
    allocation.taxCents > 0 ? "<h2>Credit note</h2>" : "",
    `<p>${escapeHtml(seller.name)}<br>${escapeHtml(seller.address)}</p>`,
    `<p>Buyer: ${escapeHtml(order.billing.name)}</p>`,
    `<p>Original order ${escapeHtml(order.id)} · ${torontoDate.format(order.chargedAt)}</p>`,
    `<p>Refund date: ${torontoDate.format(refund.confirmedAt)}<br>Issue date: ${torontoDate.format(issuedAt)}</p>`,
    `<p>Course price refunded: ${dollars(refund.amountCents - allocation.taxCents)}</p>`,
    ...taxDetails,
    `<p>Total refunded in this transaction: ${dollars(refund.amountCents)}</p>`,
    allocation.fullyRefunded ? "<p>A full refund ends the access granted by this purchase. Independent access remains valid.</p>" : "",
    `<p>For help with this refund, email ${escapeHtml(seller.email)} and include your order number.</p>`,
  ].join("");
}
