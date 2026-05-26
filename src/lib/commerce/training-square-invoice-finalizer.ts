import type {
  CheckoutOrderRow,
  SquareInvoiceProviderMetadata,
} from "@/lib/commerce/order-store";
import type { SquareInvoiceDetails } from "@/lib/commerce/square-invoice-client";
import type {
  CreateTrainingEnrollmentInput,
  TrainingEnrollmentRow,
  getOrIssueTrainingSchedulingTokenForPaidOrder,
  getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId,
  markTrainingEnrollmentStaffAlerted,
} from "@/lib/commerce/training-enrollment-store";
import type { sendTrainingPaymentNotificationEmails } from "@/lib/commerce/training-payment-email";
import { buildTrainingScheduleUrl } from "@/lib/training-checkout";

export interface TrainingSquareInvoiceFinalizerInput {
  correlationId?: string;
  invoiceId: string;
  origin?: string;
  paymentId?: string;
}

export interface TrainingSquareInvoiceFinalizerResult {
  duplicate: boolean;
  finalized: boolean;
  reason?: string;
}

export interface TrainingSquareInvoiceFinalizerDependencies {
  createTrainingEnrollment(input: CreateTrainingEnrollmentInput): Promise<TrainingEnrollmentRow>;
  findOrderBySquareInvoiceId(invoiceId: string): Promise<CheckoutOrderRow | null>;
  getInvoice(invoiceId: string): Promise<SquareInvoiceDetails>;
  getOrIssueTrainingSchedulingTokenForPaidOrder: typeof getOrIssueTrainingSchedulingTokenForPaidOrder;
  getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId: typeof getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId;
  markSquareInvoiceFinalizationFailed(orderId: string, error: string, retryable: boolean): Promise<void>;
  markSquareInvoicePaid(orderId: string, paymentId: string): Promise<void>;
  markTrainingEnrollmentStaffAlerted: typeof markTrainingEnrollmentStaffAlerted;
  sendTrainingPaymentNotificationEmails: typeof sendTrainingPaymentNotificationEmails;
}

type VerificationResult =
  | { ok: true; paymentId: string }
  | { ok: false; reason: string };

export function createTrainingSquareInvoiceFinalizer(
  dependencies: TrainingSquareInvoiceFinalizerDependencies,
): (input: TrainingSquareInvoiceFinalizerInput) => Promise<TrainingSquareInvoiceFinalizerResult> {
  return async function finalizeTrainingSquareInvoiceWithDependencies(input) {
    const order = await dependencies.findOrderBySquareInvoiceId(input.invoiceId);

    if (order === null) {
      return {
        duplicate: false,
        finalized: false,
        reason: "Local Square invoice order not found",
      };
    }

    const invoice = await dependencies.getInvoice(input.invoiceId);
    const verification = verifySquareInvoice({ input, invoice, order });

    if (!verification.ok) {
      await dependencies.markSquareInvoiceFinalizationFailed(order.orderId, verification.reason, false);

      return {
        duplicate: false,
        finalized: false,
        reason: verification.reason,
      };
    }

    if (isAlreadyFinalized(order, verification.paymentId)) {
      return { duplicate: true, finalized: false };
    }

    try {
      await dependencies.markSquareInvoicePaid(order.orderId, verification.paymentId);
      await ensureTrainingEnrollment(order, dependencies);
      const schedulingToken = await dependencies.getOrIssueTrainingSchedulingTokenForPaidOrder(order.orderId);

      if (schedulingToken === null) {
        throw new Error("Training scheduling token could not be issued");
      }

      const enrollment = await dependencies.getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId(order.orderId);

      if (enrollment === null) {
        throw new Error("Training enrollment could not be loaded after payment");
      }

      if (enrollment.staffAlertedAt === null) {
        const alertClaimed = await dependencies.markTrainingEnrollmentStaffAlerted({
          enrollmentId: enrollment.enrollmentId,
        });

        if (alertClaimed) {
          await dependencies.sendTrainingPaymentNotificationEmails({
            customerEmail: enrollment.checkoutOrder.customerEmail,
            customerName: enrollment.checkoutOrder.customerName,
            orderId: enrollment.checkoutOrder.orderId,
            programTitle: enrollment.programSnapshot.title,
            schedulingUrl: buildAbsoluteSchedulingUrl({
              origin: resolveSchedulingOrigin(input.origin),
              programSlug: requireProgramSlug(enrollment.programSnapshot.slug),
              schedulingToken: schedulingToken.schedulingToken,
            }),
          });
        }
      }

      return { duplicate: false, finalized: true };
    } catch (error) {
      const message = getErrorMessage(error);
      await dependencies.markSquareInvoiceFinalizationFailed(order.orderId, message, true);

      return {
        duplicate: false,
        finalized: false,
        reason: message,
      };
    }
  };
}

export async function finalizeTrainingSquareInvoice(
  input: TrainingSquareInvoiceFinalizerInput,
): Promise<TrainingSquareInvoiceFinalizerResult> {
  const [orderStore, enrollmentStore, email, squareInvoiceClient] = await Promise.all([
    import("@/lib/commerce/order-store"),
    import("@/lib/commerce/training-enrollment-store"),
    import("@/lib/commerce/training-payment-email"),
    import("@/lib/commerce/square-invoice-client"),
  ]);
  const client = squareInvoiceClient.createTrainingAfterpaySquareInvoiceClient();

  return createTrainingSquareInvoiceFinalizer({
    createTrainingEnrollment: enrollmentStore.createTrainingEnrollment,
    findOrderBySquareInvoiceId: orderStore.findOrderBySquareInvoiceId,
    getInvoice: client.getInvoice,
    getOrIssueTrainingSchedulingTokenForPaidOrder: enrollmentStore.getOrIssueTrainingSchedulingTokenForPaidOrder,
    getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId:
      enrollmentStore.getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId,
    markSquareInvoiceFinalizationFailed: orderStore.markSquareInvoiceFinalizationFailed,
    markSquareInvoicePaid: orderStore.markSquareInvoicePaid,
    markTrainingEnrollmentStaffAlerted: enrollmentStore.markTrainingEnrollmentStaffAlerted,
    sendTrainingPaymentNotificationEmails: email.sendTrainingPaymentNotificationEmails,
  })(input);
}

async function ensureTrainingEnrollment(
  order: CheckoutOrderRow,
  dependencies: Pick<
    TrainingSquareInvoiceFinalizerDependencies,
    "createTrainingEnrollment" | "getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId"
  >,
): Promise<void> {
  const existing = await dependencies.getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId(order.orderId);

  if (existing !== null) {
    return;
  }

  await dependencies.createTrainingEnrollment(toTrainingEnrollmentInput(order));
}

function verifySquareInvoice(input: {
  input: TrainingSquareInvoiceFinalizerInput;
  invoice: SquareInvoiceDetails;
  order: CheckoutOrderRow;
}): VerificationResult {
  const metadata = getValidSquareInvoiceProviderMetadata(input.order);

  if (metadata === null) {
    return { ok: false, reason: "Square invoice order metadata is invalid" };
  }

  const invoiceId = getString(input.invoice.id);

  if (invoiceId !== input.input.invoiceId || invoiceId !== input.order.providerCheckoutId) {
    return { ok: false, reason: "Square invoice ID did not match local order" };
  }

  if (input.order.paymentProvider !== "square" || input.order.purpose !== "training") {
    return { ok: false, reason: "Local order is not a Square training invoice order" };
  }

  if (metadata.flow !== "training_square_invoice") {
    return { ok: false, reason: "Local order is not a training Square invoice flow" };
  }

  const invoiceCustomerId = getInvoiceCustomerId(input.invoice);
  if (invoiceCustomerId !== metadata.squareCustomerId) {
    return { ok: false, reason: "Square invoice customer did not match local order" };
  }

  const invoiceOrderId = getString(input.invoice.order_id);
  if (invoiceOrderId !== null && invoiceOrderId !== input.order.providerOrderId) {
    return { ok: false, reason: "Square invoice order did not match local order" };
  }

  const correlationId = input.input.correlationId ?? getInvoiceCorrelationId(input.invoice);
  if (correlationId !== undefined && correlationId !== metadata.correlationId) {
    return { ok: false, reason: "Square invoice correlation did not match local order" };
  }

  const amountCents = getInvoiceAmountCents(input.invoice);
  if (amountCents !== input.order.amountCents || amountCents !== metadata.amountCents) {
    return { ok: false, reason: "Square invoice amount did not match local order" };
  }

  const currency = getInvoiceCurrency(input.invoice);
  if (currency !== "CAD" || input.order.currency !== "CAD" || metadata.currency !== "CAD") {
    return { ok: false, reason: "Square invoice currency did not match local order" };
  }

  if (!isPaidInvoiceStatus(input.invoice.status)) {
    return { ok: false, reason: "Square invoice is not paid" };
  }

  const paymentId = input.input.paymentId ?? getInvoicePaymentId(input.invoice);
  if (paymentId === undefined || paymentId.length === 0) {
    return { ok: false, reason: "Square invoice payment ID was missing" };
  }

  return { ok: true, paymentId };
}

function isAlreadyFinalized(order: CheckoutOrderRow, paymentId: string): boolean {
  const metadata = getSquareInvoiceProviderMetadata(order);

  return order.status === "paid" &&
    order.providerStatus === "paid" &&
    order.providerPaymentId === paymentId &&
    metadata.finalizationStatus === "paid";
}

function toTrainingEnrollmentInput(order: CheckoutOrderRow): CreateTrainingEnrollmentInput {
  const metadata = getSquareInvoiceProviderMetadata(order);
  const lineItem = order.lineItems[0];
  const programSlug = metadata.programSlug;
  const title = lineItem?.description?.trim() || programSlug;

  return {
    checkoutEmail: order.customerEmail,
    checkoutOrderId: order.id,
    productSnapshot: {
      currency: "CAD",
      id: lineItem?.productId || programSlug,
      priceCents: lineItem?.unitPriceCents ?? lineItem?.totalCents ?? order.amountCents,
      sku: lineItem?.sku || `TRAINING-${programSlug.toUpperCase()}`,
      title,
    },
    programSnapshot: {
      id: programSlug,
      slug: programSlug,
      title,
    },
  };
}

function getSquareInvoiceProviderMetadata(order: CheckoutOrderRow): SquareInvoiceProviderMetadata {
  const metadata = getValidSquareInvoiceProviderMetadata(order);

  if (metadata === null) {
    throw new Error("Square invoice order metadata is invalid");
  }

  return metadata;
}

function getValidSquareInvoiceProviderMetadata(order: CheckoutOrderRow): SquareInvoiceProviderMetadata | null {
  const metadata = order.providerMetadata;

  if (!isRecord(metadata) ||
    metadata.flow !== "training_square_invoice" ||
    typeof metadata.amountCents !== "number" ||
    metadata.currency !== "CAD" ||
    typeof metadata.correlationId !== "string" ||
    typeof metadata.programSlug !== "string") {
    return null;
  }

  return metadata as SquareInvoiceProviderMetadata;
}

function getInvoiceAmountCents(invoice: SquareInvoiceDetails): number | null {
  const payment = getRecord(invoice.payment);
  const paymentAmount = getMoneyAmount(payment?.amount_money) ?? getMoneyAmount(payment?.total_money);
  if (paymentAmount !== null) {
    return paymentAmount;
  }

  const requestAmount = getInvoicePaymentRequests(invoice)
    .map((request) => getMoneyAmount(request.computed_amount_money) ?? getMoneyAmount(request.total_completed_amount_money))
    .find((amount): amount is number => amount !== null);

  return requestAmount ?? getMoneyAmount(invoice.total_money) ?? getMoneyAmount(invoice.amount_money);
}

function getInvoiceCurrency(invoice: SquareInvoiceDetails): string | null {
  const payment = getRecord(invoice.payment);
  const paymentCurrency = getMoneyCurrency(payment?.amount_money) ?? getMoneyCurrency(payment?.total_money);
  if (paymentCurrency !== null) {
    return paymentCurrency;
  }

  const requestCurrency = getInvoicePaymentRequests(invoice)
    .map((request) => getMoneyCurrency(request.computed_amount_money) ?? getMoneyCurrency(request.total_completed_amount_money))
    .find((currency): currency is string => currency !== null);

  return requestCurrency ?? getMoneyCurrency(invoice.total_money) ?? getMoneyCurrency(invoice.amount_money);
}

function getInvoicePaymentId(invoice: SquareInvoiceDetails): string | undefined {
  const directPaymentId = getString(invoice.payment_id) ?? getString(getRecord(invoice.payment)?.id);
  if (directPaymentId !== null) {
    return directPaymentId;
  }

  for (const request of getInvoicePaymentRequests(invoice)) {
    const paymentIds = request.payment_ids;
    if (Array.isArray(paymentIds) && typeof paymentIds[0] === "string") {
      return paymentIds[0];
    }
  }

  return undefined;
}

function getInvoiceCorrelationId(invoice: SquareInvoiceDetails): string | undefined {
  return getString(invoice.reference_id) ??
    getString(invoice.order_reference_id) ??
    getString(getRecord(invoice.order)?.reference_id) ??
    undefined;
}

function getInvoiceCustomerId(invoice: SquareInvoiceDetails): string | null {
  return getString(getRecord(invoice.primary_recipient)?.customer_id);
}

function getInvoicePaymentRequests(invoice: SquareInvoiceDetails): Record<string, unknown>[] {
  if (!Array.isArray(invoice.payment_requests)) {
    return [];
  }

  return invoice.payment_requests.filter(isRecord);
}

function isPaidInvoiceStatus(status: unknown): boolean {
  if (typeof status !== "string") {
    return false;
  }

  return ["complete", "completed", "paid"].includes(status.trim().toLowerCase());
}

function getMoneyAmount(value: unknown): number | null {
  const money = getRecord(value);

  return typeof money?.amount === "number" ? money.amount : null;
}

function getMoneyCurrency(value: unknown): string | null {
  const money = getRecord(value);

  return typeof money?.currency === "string" ? money.currency.toUpperCase() : null;
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildAbsoluteSchedulingUrl(input: {
  origin: string;
  programSlug: string;
  schedulingToken: string;
}): string {
  return new URL(
    buildTrainingScheduleUrl({
      programSlug: input.programSlug,
      schedulingToken: input.schedulingToken,
    }),
    input.origin,
  ).toString();
}

function resolveSchedulingOrigin(origin: string | undefined): string {
  const resolved = origin ?? process.env.NEXT_PUBLIC_SITE_URL ?? toVercelOrigin(process.env.VERCEL_URL);

  if (resolved === undefined || resolved.length === 0) {
    throw new Error("Training scheduling origin is required");
  }

  return resolved;
}

function toVercelOrigin(vercelUrl: string | undefined): string | undefined {
  if (vercelUrl === undefined || vercelUrl.length === 0) {
    return undefined;
  }

  return vercelUrl.startsWith("http") ? vercelUrl : `https://${vercelUrl}`;
}

function requireProgramSlug(programSlug: string | undefined): string {
  if (programSlug === undefined || programSlug.length === 0) {
    throw new Error("Training program slug is required for scheduling");
  }

  return programSlug;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown training Square invoice finalization error";
}
