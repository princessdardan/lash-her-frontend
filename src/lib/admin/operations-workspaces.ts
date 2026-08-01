import "server-only";

import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import {
  appointmentHolds,
  appointments,
  bookingBusinessSettings,
  bookingPaymentAttempts,
  bookingProviders,
  checkoutOrders,
  marketingContactSubmissions,
  squarePaymentRefundEvents,
  trainingEnrollments,
  type CheckoutOrderLineItemSnapshot,
  type CheckoutOrderShippingAddressSnapshot,
} from "@/lib/private-db/schema";

import { requirePermission } from "./auth";
import {
  addCalendarDays,
  getBusinessDateRange,
  getBusinessRollingDateRange,
} from "./business-time";
import {
  getBookingIssueFilter,
  getCapturedBookingPaymentExistsExpression,
} from "./booking-issue-filter";
import {
  getAdminWorkspacePagination,
  getBookingIssuePresentation,
  getCheckoutPurposePresentation,
  getCheckoutOrderStatusPresentation,
  getHumanTimezoneLabel,
  getInquiryConsentLabel,
  getInquiryContentPresentation,
  getInquiryTypeLabel,
  getProductConfirmationPresentation,
  getTrainingNotificationPresentation,
  getTrainingSchedulingPresentation,
  normalizeAdminWorkspaceSearch,
  readSnapshotLabel,
  type AdminInquiryContentPresentation,
  type AdminWorkspaceStatusPresentation,
} from "./operations-workspaces-presentation";
import { buildAdminRefundQueries } from "./admin-refund-query";

const DEFAULT_BUSINESS_TIMEZONE = "America/Toronto";

export class AdminWorkspaceRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminWorkspaceRangeError";
  }
}

export interface AdminWorkspaceListInput {
  now?: Date;
  page?: number;
  search?: string;
}

export interface AdminPaymentsListInput extends AdminWorkspaceListInput {
  from?: string;
  to?: string;
}

export interface AdminWorkspacePage<Row> {
  page: number;
  pageCount: number;
  pageSize: number;
  rows: Row[];
  search: string;
  timezone: string;
  timezoneLabel: string;
  total: number;
}

export interface AdminPaymentsPage extends AdminWorkspacePage<AdminPaymentRow> {
  from: string;
  to: string;
  totalReceivedCents: number;
  totalTipCents: number;
}

export interface AdminRefundsPage extends AdminWorkspacePage<AdminRefundRow> {
  from: string;
  to: string;
  totalRefundedCents: number;
}

export interface AdminPaymentRow {
  currency: string;
  customerEmail: string | null;
  customerName: string;
  id: string;
  paidAt: Date;
  paymentProviderLabel: string;
  purpose: ReturnType<typeof getCheckoutPurposePresentation>;
  reference: string;
  receivedAmountCents: number;
  status: AdminWorkspaceStatusPresentation;
  subtotalAmountCents: number;
  tipAmountCents: number;
}

export interface AdminRefundRow {
  amountCents: number;
  currency: string;
  customerEmail: string | null;
  customerName: string;
  id: string;
  occurredAt: Date;
  reference: string;
  sourceLabel: string;
}

export interface AdminProductOrderRow {
  amountCents: number;
  confirmation: AdminWorkspaceStatusPresentation;
  createdAt: Date;
  currency: string;
  customerEmail: string | null;
  customerName: string;
  id: string;
  lineItems: AdminOrderLineItemPresentation[];
  paidAt: Date | null;
  reference: string;
  shippingLines: string[] | null;
  status: AdminWorkspaceStatusPresentation;
}

export interface AdminOrderLineItemPresentation {
  description: string;
  quantity: number;
  totalCents: number;
}

export interface AdminTrainingOrderRow {
  amountCents: number;
  createdAt: Date;
  currency: string;
  customerEmail: string | null;
  customerName: string;
  id: string;
  notification: AdminWorkspaceStatusPresentation;
  paidAt: Date | null;
  paymentProviderLabel: string;
  paymentStatus: AdminWorkspaceStatusPresentation;
  programTitle: string;
  reference: string;
  scheduling: AdminWorkspaceStatusPresentation;
  tokenExpiresAt: Date | null;
}

export interface AdminBookingIssueRow {
  amountCents: number | null;
  amountLabel: string;
  appointmentId: string | null;
  appointmentReference: string | null;
  currency: string;
  customerEmail: string | null;
  customerName: string;
  customerPhone: string | null;
  hasCompletedRefundEvent: boolean;
  id: string;
  issue: AdminWorkspaceStatusPresentation;
  paymentEvidenceDescription: string;
  paymentRecordedAt: Date | null;
  providerName: string;
  publicReference: string;
  selectedEnd: Date;
  selectedStart: Date;
  serviceTitle: string;
}

export interface AdminInquiryRow {
  consentLabel: string;
  content: AdminInquiryContentPresentation;
  email: string | null;
  id: string;
  instagram: string | null;
  name: string;
  phone: string | null;
  submittedAt: Date;
  typeLabel: string;
}

export async function listAdminPayments(
  input: AdminPaymentsListInput = {},
): Promise<AdminPaymentsPage> {
  await requirePermission("payments:view");

  const db = getPrivateDb();
  const timezone = await getAdminBusinessTimezone(db);
  const range = getAdminFinancialRange(input, timezone);

  const search = normalizeAdminWorkspaceSearch(input.search);
  const purposeExpression = sql<string>`${checkoutOrders.purpose}::text`;
  const searchFilter = search
    ? or(
        ilike(checkoutOrders.orderId, `%${search}%`),
        ilike(checkoutOrders.customerName, `%${search}%`),
        ilike(checkoutOrders.customerEmail, `%${search}%`),
        ilike(purposeExpression, `%${search}%`),
      )
    : undefined;
  const where = and(
    inArray(checkoutOrders.status, ["paid", "refunded"]),
    gte(checkoutOrders.paidAt, range.start),
    lt(checkoutOrders.paidAt, range.endExclusive),
    searchFilter,
  );
  const [summary] = await db
    .select({
      total: sql<number>`count(*)::int`,
      totalReceivedCents: sql<number>`coalesce(
        sum(
          ${checkoutOrders.amountCents}
          + coalesce(${checkoutOrders.squareTipAmountCents}, 0)
        ),
        0
      )::int`,
      totalTipCents: sql<number>`coalesce(
        sum(coalesce(${checkoutOrders.squareTipAmountCents}, 0)),
        0
      )::int`,
    })
    .from(checkoutOrders)
    .where(where);
  const total = summary?.total ?? 0;
  const pagination = getAdminWorkspacePagination(input.page, total);
  const rows = await db
    .select({
      amountCents: checkoutOrders.amountCents,
      currency: checkoutOrders.currency,
      customerEmail: checkoutOrders.customerEmail,
      customerName: checkoutOrders.customerName,
      id: checkoutOrders.id,
      paidAt: checkoutOrders.paidAt,
      paymentProvider: checkoutOrders.paymentProvider,
      purpose: checkoutOrders.purpose,
      redactedAt: checkoutOrders.redactedAt,
      reference: checkoutOrders.orderId,
      squareTipAmountCents: checkoutOrders.squareTipAmountCents,
      status: checkoutOrders.status,
    })
    .from(checkoutOrders)
    .where(where)
    .orderBy(desc(checkoutOrders.paidAt), desc(checkoutOrders.id))
    .limit(pagination.pageSize)
    .offset(pagination.offset);
  const presentedRows = rows.map((row): AdminPaymentRow => {
    if (row.paidAt === null) {
      throw new Error("A payment result is missing its recorded payment date");
    }

    const redacted = row.redactedAt !== null;
    const tipAmountCents = row.squareTipAmountCents ?? 0;

    return {
      currency: row.currency,
      customerEmail: redacted ? null : row.customerEmail,
      customerName: redacted ? "Retained payment record" : row.customerName,
      id: row.id,
      paidAt: row.paidAt,
      paymentProviderLabel:
        row.paymentProvider === "square" ? "Square" : "Helcim",
      purpose: getCheckoutPurposePresentation(row.purpose),
      receivedAmountCents: row.amountCents + tipAmountCents,
      reference: row.reference,
      status: getCheckoutOrderStatusPresentation(row.status),
      subtotalAmountCents: row.amountCents,
      tipAmountCents,
    };
  });

  return {
    ...toWorkspacePage({
      pagination,
      rows: presentedRows,
      search,
      timezone,
      total,
    }),
    from: range.from,
    to: range.to,
    totalReceivedCents: summary?.totalReceivedCents ?? 0,
    totalTipCents: summary?.totalTipCents ?? 0,
  };
}

export async function listAdminRefunds(
  input: AdminPaymentsListInput = {},
): Promise<AdminRefundsPage> {
  await requirePermission("payments:view");

  const db = getPrivateDb();
  const timezone = await getAdminBusinessTimezone(db);
  const range = getAdminFinancialRange(input, timezone);
  const search = normalizeAdminWorkspaceSearch(input.search);
  const queries = buildAdminRefundQueries(db, {
    endExclusive: range.endExclusive,
    search,
    start: range.start,
  });
  const [summary] = await queries.summary;
  const total = summary?.total ?? 0;
  const pagination = getAdminWorkspacePagination(input.page, total);
  const rows = await queries.rows
    .limit(pagination.pageSize)
    .offset(pagination.offset);

  return {
    ...toWorkspacePage({
      pagination,
      rows: rows.map((row) => {
        const redacted = row.customerEmail === "[redacted]";

        return {
          amountCents: row.amountCents,
          currency: row.currency,
          customerEmail: redacted ? null : row.customerEmail,
          customerName: redacted
            ? "Retained refund record"
            : (row.customerName ?? "Customer unavailable"),
          id: row.id,
          occurredAt: row.occurredAt,
          reference: row.reference,
          sourceLabel: row.sourceLabel,
        };
      }),
      search,
      timezone,
      total,
    }),
    from: range.from,
    to: range.to,
    totalRefundedCents: summary?.totalRefundedCents ?? 0,
  };
}

export async function listAdminProductOrders(
  input: AdminWorkspaceListInput = {},
): Promise<AdminWorkspacePage<AdminProductOrderRow>> {
  await requirePermission("payments:view");

  const db = getPrivateDb();
  const search = normalizeAdminWorkspaceSearch(input.search);
  const searchFilter = search
    ? or(
        ilike(checkoutOrders.orderId, `%${search}%`),
        ilike(checkoutOrders.customerName, `%${search}%`),
        ilike(checkoutOrders.customerEmail, `%${search}%`),
      )
    : undefined;
  const where = and(
    eq(checkoutOrders.purpose, "product"),
    isNull(checkoutOrders.deletedAt),
    searchFilter,
  );
  const [countRows, timezone] = await Promise.all([
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(checkoutOrders)
      .where(where),
    getAdminBusinessTimezone(db),
  ]);
  const total = countRows[0]?.total ?? 0;
  const pagination = getAdminWorkspacePagination(input.page, total);
  const rows = await db
    .select({
      amountCents: checkoutOrders.amountCents,
      createdAt: checkoutOrders.createdAt,
      currency: checkoutOrders.currency,
      customerEmail: checkoutOrders.customerEmail,
      customerName: checkoutOrders.customerName,
      id: checkoutOrders.id,
      lineItems: checkoutOrders.lineItems,
      paidAt: checkoutOrders.paidAt,
      productConfirmationEmailLastError:
        checkoutOrders.productConfirmationEmailLastError,
      productConfirmationEmailSentAt:
        checkoutOrders.productConfirmationEmailSentAt,
      redactedAt: checkoutOrders.redactedAt,
      reference: checkoutOrders.orderId,
      shippingAddress: checkoutOrders.shippingAddress,
      status: checkoutOrders.status,
    })
    .from(checkoutOrders)
    .where(where)
    .orderBy(desc(checkoutOrders.createdAt), desc(checkoutOrders.id))
    .limit(pagination.pageSize)
    .offset(pagination.offset);

  return toWorkspacePage({
    pagination,
    rows: rows.map((row) => {
      const redacted = row.redactedAt !== null;

      return {
        amountCents: row.amountCents,
        confirmation: getProductConfirmationPresentation({
          lastError: row.productConfirmationEmailLastError,
          sentAt: row.productConfirmationEmailSentAt,
          status: row.status,
        }),
        createdAt: row.createdAt,
        currency: row.currency,
        customerEmail: redacted ? null : row.customerEmail,
        customerName: redacted ? "Retained order" : row.customerName,
        id: row.id,
        lineItems: presentLineItems(row.lineItems),
        paidAt: row.paidAt,
        reference: row.reference,
        shippingLines: redacted
          ? null
          : presentShippingAddress(row.shippingAddress),
        status: getCheckoutOrderStatusPresentation(row.status),
      };
    }),
    search,
    timezone,
    total,
  });
}

export async function listAdminTrainingOrders(
  input: AdminWorkspaceListInput = {},
): Promise<AdminWorkspacePage<AdminTrainingOrderRow>> {
  await requirePermission("payments:view");

  const db = getPrivateDb();
  const now = input.now ?? new Date();
  const search = normalizeAdminWorkspaceSearch(input.search);
  const programTitleExpression = sql<
    string | null
  >`${trainingEnrollments.programSnapshot}->>'title'`;
  const programSlugExpression = sql<
    string | null
  >`${checkoutOrders.providerMetadata}->>'programSlug'`;
  const searchFilter = search
    ? or(
        ilike(checkoutOrders.orderId, `%${search}%`),
        ilike(checkoutOrders.customerName, `%${search}%`),
        ilike(checkoutOrders.customerEmail, `%${search}%`),
        ilike(programTitleExpression, `%${search}%`),
        ilike(programSlugExpression, `%${search}%`),
      )
    : undefined;
  const where = and(
    eq(checkoutOrders.purpose, "training"),
    isNull(checkoutOrders.deletedAt),
    searchFilter,
  );
  const [countRows, timezone] = await Promise.all([
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(checkoutOrders)
      .leftJoin(
        trainingEnrollments,
        eq(trainingEnrollments.checkoutOrderId, checkoutOrders.id),
      )
      .where(where),
    getAdminBusinessTimezone(db),
  ]);
  const total = countRows[0]?.total ?? 0;
  const pagination = getAdminWorkspacePagination(input.page, total);
  const rows = await db
    .select({
      amountCents: checkoutOrders.amountCents,
      createdAt: checkoutOrders.createdAt,
      currency: checkoutOrders.currency,
      customerEmail: checkoutOrders.customerEmail,
      customerName: checkoutOrders.customerName,
      enrollmentId: trainingEnrollments.id,
      enrollmentStatus: trainingEnrollments.schedulingStatus,
      id: checkoutOrders.id,
      lineItems: checkoutOrders.lineItems,
      paidAt: checkoutOrders.paidAt,
      paymentProvider: checkoutOrders.paymentProvider,
      productSnapshot: trainingEnrollments.productSnapshot,
      programSnapshot: trainingEnrollments.programSnapshot,
      providerStatus: checkoutOrders.providerStatus,
      redactedAt: checkoutOrders.redactedAt,
      reference: checkoutOrders.orderId,
      staffAlertedAt: trainingEnrollments.staffAlertedAt,
      status: checkoutOrders.status,
      studentEmailSentAt: trainingEnrollments.studentPaymentEmailSentAt,
      tokenExpiresAt: trainingEnrollments.tokenExpiresAt,
      tokenUsedAt: trainingEnrollments.tokenUsedAt,
      trainingEmailLastError: trainingEnrollments.trainingEmailLastError,
    })
    .from(checkoutOrders)
    .leftJoin(
      trainingEnrollments,
      eq(trainingEnrollments.checkoutOrderId, checkoutOrders.id),
    )
    .where(where)
    .orderBy(desc(checkoutOrders.createdAt), desc(checkoutOrders.id))
    .limit(pagination.pageSize)
    .offset(pagination.offset);

  return toWorkspacePage({
    pagination,
    rows: rows.map((row) => {
      const hasEnrollment = row.enrollmentId !== null;
      const redacted = row.redactedAt !== null;
      const fallbackTitle =
        presentLineItems(row.lineItems)[0]?.description.replace(
          /^Training program:\s*/i,
          "",
        ) ?? "Training purchase";
      const programTitle = readSnapshotLabel(
        row.programSnapshot,
        ["title"],
        readSnapshotLabel(row.productSnapshot, ["title"], fallbackTitle),
      );

      return {
        amountCents: row.amountCents,
        createdAt: row.createdAt,
        currency: row.currency,
        customerEmail: redacted ? null : row.customerEmail,
        customerName: redacted ? "Retained enrollment" : row.customerName,
        id: row.id,
        notification: getTrainingNotificationPresentation({
          hasEnrollment,
          lastError: row.trainingEmailLastError,
          orderStatus: row.status,
          staffAlertedAt: row.staffAlertedAt,
          studentEmailSentAt: row.studentEmailSentAt,
        }),
        paidAt: row.paidAt,
        paymentProviderLabel:
          row.paymentProvider === "square" ? "Square" : "Helcim",
        paymentStatus: getCheckoutOrderStatusPresentation(row.status),
        programTitle,
        reference: row.reference,
        scheduling: getTrainingSchedulingPresentation({
          enrollmentStatus: row.enrollmentStatus,
          hasEnrollment,
          now,
          orderStatus: row.status,
          providerStatus: row.providerStatus,
          tokenExpiresAt: row.tokenExpiresAt,
          tokenUsedAt: row.tokenUsedAt,
        }),
        tokenExpiresAt: row.tokenExpiresAt,
      };
    }),
    search,
    timezone,
    total,
  });
}

export async function listAdminBookingIssues(
  input: AdminWorkspaceListInput = {},
): Promise<AdminWorkspacePage<AdminBookingIssueRow>> {
  await requirePermission("payments:view");

  const db = getPrivateDb();
  const now = input.now ?? new Date();
  const search = normalizeAdminWorkspaceSearch(input.search);
  const customerNameExpression = sql<string>`${appointmentHolds.customerSnapshot}->>'name'`;
  const customerEmailExpression = sql<string>`${appointmentHolds.customerSnapshot}->>'email'`;
  const serviceTitleExpression = sql<string>`coalesce(
    ${appointmentHolds.offeringSnapshot}->>'publicTitle',
    ${appointmentHolds.offeringSnapshot}->>'displayTitle',
    ${appointmentHolds.offeringSnapshot}->>'title'
  )`;
  const capturedPaymentExists = getCapturedBookingPaymentExistsExpression();
  const completedRefundEventExists = sql<boolean>`exists (
    select 1
    from ${squarePaymentRefundEvents}
    where ${squarePaymentRefundEvents.status} = 'COMPLETED'
      and ${squarePaymentRefundEvents.squarePaymentId} = coalesce(
        ${appointmentHolds.squarePaymentId},
        ${checkoutOrders.providerPaymentId}
      )
  )`;
  const paymentEvidenceExists = sql<boolean>`(
    (${capturedPaymentExists})
    or ${appointmentHolds.paidAt} is not null
    or ${appointments.paymentStatus} in ('paid', 'partially_paid')
    or ${checkoutOrders.status} in ('paid', 'refunded')
    or (${completedRefundEventExists})
  )`;
  const issueFilter = getBookingIssueFilter(now);
  const searchFilter = search
    ? or(
        ilike(appointmentHolds.publicReference, `%${search}%`),
        ilike(checkoutOrders.orderId, `%${search}%`),
        ilike(appointments.publicReference, `%${search}%`),
        ilike(customerNameExpression, `%${search}%`),
        ilike(customerEmailExpression, `%${search}%`),
        ilike(serviceTitleExpression, `%${search}%`),
        ilike(bookingProviders.displayName, `%${search}%`),
      )
    : undefined;
  const where = and(issueFilter, searchFilter);
  const [countRows, timezone] = await Promise.all([
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(appointmentHolds)
      .leftJoin(
        checkoutOrders,
        eq(checkoutOrders.id, appointmentHolds.checkoutOrderId),
      )
      .leftJoin(
        appointments,
        eq(appointments.sourceHoldId, appointmentHolds.id),
      )
      .leftJoin(
        bookingProviders,
        eq(bookingProviders.id, appointmentHolds.providerId),
      )
      .where(where),
    getAdminBusinessTimezone(db),
  ]);
  const total = countRows[0]?.total ?? 0;
  const pagination = getAdminWorkspacePagination(input.page, total);
  const rows = await db
    .select({
      appointmentId: appointments.id,
      appointmentReference: appointments.publicReference,
      capturedAmountCents: sql<number | null>`(
        select ${bookingPaymentAttempts.amountCents}
        from ${bookingPaymentAttempts}
        where ${bookingPaymentAttempts.holdId} = ${appointmentHolds.id}
          and ${bookingPaymentAttempts.status} in ('captured', 'refunded')
        order by ${bookingPaymentAttempts.capturedAt} desc nulls last,
          ${bookingPaymentAttempts.updatedAt} desc
        limit 1
      )`,
      capturedAt: sql<Date | null>`(
        select ${bookingPaymentAttempts.capturedAt}
        from ${bookingPaymentAttempts}
        where ${bookingPaymentAttempts.holdId} = ${appointmentHolds.id}
          and ${bookingPaymentAttempts.status} in ('captured', 'refunded')
        order by ${bookingPaymentAttempts.capturedAt} desc nulls last,
          ${bookingPaymentAttempts.updatedAt} desc
        limit 1
      )`.mapWith(bookingPaymentAttempts.capturedAt),
      currency: sql<string>`coalesce((
        select ${bookingPaymentAttempts.currency}
        from ${bookingPaymentAttempts}
        where ${bookingPaymentAttempts.holdId} = ${appointmentHolds.id}
          and ${bookingPaymentAttempts.status} in ('captured', 'refunded')
        order by ${bookingPaymentAttempts.capturedAt} desc nulls last,
          ${bookingPaymentAttempts.updatedAt} desc
        limit 1
      ), ${checkoutOrders.currency}, 'CAD')`,
      customerEmail: customerEmailExpression,
      customerName: customerNameExpression,
      customerPhone: sql<
        string | null
      >`${appointmentHolds.customerSnapshot}->>'phone'`,
      finalizationStatus: appointmentHolds.finalizationStatus,
      hasCapturedPayment: capturedPaymentExists,
      hasCompletedRefundEvent: completedRefundEventExists,
      hasCustomerEmailFailure: sql<boolean>`(
        ${appointments.id} is null
        and ${appointmentHolds.bookingConfirmationEmailSentAt} is null
        and ${appointmentHolds.bookingConfirmationEmailLastError} is not null
      )`,
      hasPaymentEvidence: paymentEvidenceExists,
      holdStatus: appointmentHolds.status,
      id: appointmentHolds.id,
      orderAmountCents: checkoutOrders.amountCents,
      orderPaidAt: checkoutOrders.paidAt,
      paidAt: appointmentHolds.paidAt,
      providerName: bookingProviders.displayName,
      providerSnapshot: appointmentHolds.providerSnapshot,
      publicReference: appointmentHolds.publicReference,
      selectedEnd: appointmentHolds.selectedEnd,
      selectedStart: appointmentHolds.selectedStart,
      serviceTitle: serviceTitleExpression,
      offeringSnapshot: appointmentHolds.offeringSnapshot,
    })
    .from(appointmentHolds)
    .leftJoin(
      checkoutOrders,
      eq(checkoutOrders.id, appointmentHolds.checkoutOrderId),
    )
    .leftJoin(appointments, eq(appointments.sourceHoldId, appointmentHolds.id))
    .leftJoin(
      bookingProviders,
      eq(bookingProviders.id, appointmentHolds.providerId),
    )
    .where(where)
    .orderBy(
      desc(appointmentHolds.manualFollowupAt),
      desc(appointmentHolds.updatedAt),
      desc(appointmentHolds.id),
    )
    .limit(pagination.pageSize)
    .offset(pagination.offset);

  return toWorkspacePage({
    pagination,
    rows: rows.map((row) => {
      const amountCents = row.capturedAmountCents ?? row.orderAmountCents;
      const amountLabel = row.hasCapturedPayment
        ? "Captured amount"
        : row.hasPaymentEvidence
          ? "Recorded payment amount"
          : amountCents === null
            ? "Amount unavailable"
            : "Checkout amount";
      const paymentEvidenceDescription = row.hasCapturedPayment
        ? "A captured or subsequently refunded payment attempt is recorded."
        : row.hasCompletedRefundEvent
          ? "A completed Square refund event is recorded."
          : row.hasPaymentEvidence
            ? "A local paid record exists; provider capture should still be verified during review."
            : "Payment capture is not verified in local records.";

      return {
        amountCents,
        amountLabel,
        appointmentId: row.appointmentId,
        appointmentReference: row.appointmentReference,
        currency: row.currency,
        customerEmail: row.customerEmail || null,
        customerName: row.customerName || "Customer name unavailable",
        customerPhone: row.customerPhone || null,
        hasCompletedRefundEvent: row.hasCompletedRefundEvent,
        id: row.id,
        issue: getBookingIssuePresentation({
          appointmentId: row.appointmentId,
          finalizationStatus: row.finalizationStatus,
          hasCustomerEmailFailure: row.hasCustomerEmailFailure,
          hasPaymentEvidence: row.hasPaymentEvidence,
          holdStatus: row.holdStatus,
        }),
        paymentEvidenceDescription,
        paymentRecordedAt: row.capturedAt ?? row.paidAt ?? row.orderPaidAt,
        providerName:
          row.providerName ??
          readSnapshotLabel(
            row.providerSnapshot,
            ["displayName", "name"],
            "Provider unavailable",
          ),
        publicReference: row.publicReference,
        selectedEnd: row.selectedEnd,
        selectedStart: row.selectedStart,
        serviceTitle:
          row.serviceTitle ??
          readSnapshotLabel(
            row.offeringSnapshot,
            ["publicTitle", "displayTitle", "title"],
            "Service unavailable",
          ),
      };
    }),
    search,
    timezone,
    total,
  });
}

export async function listAdminInquiries(
  input: AdminWorkspaceListInput = {},
): Promise<AdminWorkspacePage<AdminInquiryRow>> {
  await requirePermission("marketing:view");

  const db = getPrivateDb();
  const search = normalizeAdminWorkspaceSearch(input.search);
  const messageExpression = sql<
    string | null
  >`${marketingContactSubmissions.payload}->>'message'`;
  const programTitleExpression = sql<
    string | null
  >`${marketingContactSubmissions.payload}->>'programTitle'`;
  const searchFilter = search
    ? or(
        ilike(marketingContactSubmissions.name, `%${search}%`),
        ilike(marketingContactSubmissions.email, `%${search}%`),
        ilike(marketingContactSubmissions.phone, `%${search}%`),
        ilike(messageExpression, `%${search}%`),
        ilike(programTitleExpression, `%${search}%`),
      )
    : undefined;
  const where = and(
    inArray(marketingContactSubmissions.submissionType, [
      "general_inquiry",
      "training_contact",
    ]),
    searchFilter,
  );
  const [countRows, timezone] = await Promise.all([
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(marketingContactSubmissions)
      .where(where),
    getAdminBusinessTimezone(db),
  ]);
  const total = countRows[0]?.total ?? 0;
  const pagination = getAdminWorkspacePagination(input.page, total);
  const rows = await db
    .select({
      consentChoice: marketingContactSubmissions.consentChoice,
      email: marketingContactSubmissions.email,
      id: marketingContactSubmissions.id,
      instagram: marketingContactSubmissions.instagram,
      name: marketingContactSubmissions.name,
      payload: marketingContactSubmissions.payload,
      phone: marketingContactSubmissions.phone,
      submissionType: marketingContactSubmissions.submissionType,
      submittedAt: marketingContactSubmissions.submittedAt,
    })
    .from(marketingContactSubmissions)
    .where(where)
    .orderBy(
      desc(marketingContactSubmissions.submittedAt),
      desc(marketingContactSubmissions.id),
    )
    .limit(pagination.pageSize)
    .offset(pagination.offset);

  return toWorkspacePage({
    pagination,
    rows: rows.map((row) => {
      const submissionType =
        row.submissionType === "training_contact"
          ? "training_contact"
          : "general_inquiry";
      const redacted = row.email === "[redacted]";

      return {
        consentLabel: getInquiryConsentLabel(row.consentChoice),
        content: getInquiryContentPresentation({
          payload: row.payload,
          submissionType,
        }),
        email: redacted ? null : row.email,
        id: row.id,
        instagram: redacted ? null : row.instagram,
        name: redacted ? "Retained inquiry" : (row.name ?? "Name unavailable"),
        phone: redacted ? null : row.phone,
        submittedAt: row.submittedAt,
        typeLabel: getInquiryTypeLabel(submissionType),
      };
    }),
    search,
    timezone,
    total,
  });
}

function presentLineItems(
  lineItems: CheckoutOrderLineItemSnapshot[],
): AdminOrderLineItemPresentation[] {
  return lineItems.slice(0, 50).map((lineItem) => ({
    description: lineItem.description,
    quantity: lineItem.quantity,
    totalCents: lineItem.totalCents,
  }));
}

function presentShippingAddress(
  address: CheckoutOrderShippingAddressSnapshot | null,
): string[] | null {
  if (address === null) {
    return null;
  }

  return [
    address.line1,
    address.line2,
    `${address.city}, ${address.province} ${address.postalCode}`,
    address.country,
  ].filter(
    (line): line is string =>
      typeof line === "string" && line.trim().length > 0,
  );
}

type AdminWorkspaceDb = ReturnType<typeof getPrivateDb>;

function getAdminFinancialRange(
  input: Pick<AdminPaymentsListInput, "from" | "now" | "to">,
  timezone: string,
) {
  const defaultRange = getBusinessRollingDateRange(
    input.now ?? new Date(),
    timezone,
    30,
  );

  try {
    const range = getBusinessDateRange(
      input.from?.trim() || defaultRange.from,
      input.to?.trim() || defaultRange.to,
      timezone,
    );
    if (range.to > addCalendarDays(range.from, 365)) {
      throw new AdminWorkspaceRangeError(
        "The date range cannot exceed 366 days.",
      );
    }
    return range;
  } catch (error) {
    if (error instanceof AdminWorkspaceRangeError) {
      throw error;
    }

    throw new AdminWorkspaceRangeError(
      "Enter a valid start and end date. The start must not be after the end.",
    );
  }
}

async function getAdminBusinessTimezone(db: AdminWorkspaceDb): Promise<string> {
  const rows = await db
    .select({ timezone: bookingBusinessSettings.timezone })
    .from(bookingBusinessSettings)
    .where(eq(bookingBusinessSettings.singletonKey, "default"))
    .limit(1);

  return rows[0]?.timezone ?? DEFAULT_BUSINESS_TIMEZONE;
}

function toWorkspacePage<Row>(input: {
  pagination: ReturnType<typeof getAdminWorkspacePagination>;
  rows: Row[];
  search: string;
  timezone: string;
  total: number;
}): AdminWorkspacePage<Row> {
  return {
    page: input.pagination.page,
    pageCount: input.pagination.pageCount,
    pageSize: input.pagination.pageSize,
    rows: input.rows,
    search: input.search,
    timezone: input.timezone,
    timezoneLabel: getHumanTimezoneLabel(input.timezone),
    total: input.total,
  };
}
