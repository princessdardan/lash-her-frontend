import "server-only";

import {
  and,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import {
  appointmentHolds,
  appointments,
  bookingBusinessSettings,
  bookingPaymentAttempts,
  bookingProviders,
  checkoutOrders,
  productOrderAddressChangeRequests,
  productOrderCustomerDecisions,
  productOrderRefunds,
  productShippingCases,
  productShipments,
  marketingContactSubmissions,
  squarePaymentRefundEvents,
  trainingEnrollments,
  type CheckoutOrderLineItemSnapshot,
  type CheckoutOrderShippingAddressSnapshot,
} from "@/lib/private-db/schema";
import { evaluateCheckoutReadiness } from "@/lib/shipping/readiness";

import { buildAdminRefundQueries } from "./admin-refund-query";
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
  ADMIN_FULFILLMENT_QUEUE_LIMIT,
  boundedFulfillmentQueueSelectionSql,
} from "./fulfillment-queue-pagination";
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
  operations: {
    addressChangeReconciliationState: string | null;
    addressChangeStatus: string | null;
    customerDecisionStatus: string | null;
    fraudClassification: string;
    fraudRiskReasons: string[];
    latestRefundStatus: string | null;
    openCaseCount: number;
    shipmentHistoryCount: number;
  };
  shipment: {
    id: string;
    stateVersion: number;
    status: string;
    providerStatus: string | null;
    trackingNumber: string | null;
    trackingUrl: string | null;
    quotedShippingCents: number | null;
    actualShippingCents: number | null;
    packageWeightGrams: number;
    selectedPostageType: string | null;
    sequence: number;
    purpose: string;
    handoffDeadlineAt: Date | null;
    autoRefundDeadlineAt: Date | null;
    signatureRequired: boolean;
    manualReviewAcknowledgedAt: Date | null;
  } | null;
}

export const ADMIN_FULFILLMENT_QUEUE_KEYS = [
  "risk",
  "provider-jobs",
  "notifications",
  "shipment-generations",
  "addresses-and-supplements",
  "decisions-and-extensions",
  "cases-claims-replacements-returns",
  "refunds",
  "manual-fulfillment",
  "calendar-tax-policy-readiness",
] as const;

export type AdminFulfillmentQueueKey =
  (typeof ADMIN_FULFILLMENT_QUEUE_KEYS)[number];

export interface AdminFulfillmentQueueState {
  limit: number;
  returned: number;
  total: number;
  truncated: boolean;
}

export interface AdminFulfillmentOperationRow {
  conflictToken: string;
  deadlineAt: Date | null;
  detail: string;
  evidence: string[];
  id: string;
  kind: string;
  legalNextActions: string[];
  orderReference: string | null;
  queue: AdminFulfillmentQueueKey;
  stateVersion: number;
  title: string;
}

export interface AdminFulfillmentOperations {
  generatedAt: Date;
  queues: Record<AdminFulfillmentQueueKey, AdminFulfillmentQueueState>;
  rows: AdminFulfillmentOperationRow[];
  timezone: string;
  timezoneLabel: string;
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
  await requirePermission("fulfillment:view");

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
      fraudClassification: checkoutOrders.fraudClassification,
      fraudRiskReasons: checkoutOrders.fraudRiskReasons,
      openCaseCount: sql<number>`(select count(*)::int from ${productShippingCases} where ${productShippingCases.orderId} = ${checkoutOrders.id} and ${productShippingCases.status} not in ('resolved', 'cancelled'))`,
      latestRefundStatus: sql<
        string | null
      >`(select ${productOrderRefunds.status}::text from ${productOrderRefunds} where ${productOrderRefunds.orderId} = ${checkoutOrders.id} order by ${productOrderRefunds.createdAt} desc limit 1)`,
      customerDecisionStatus: sql<
        string | null
      >`(select ${productOrderCustomerDecisions.status}::text from ${productOrderCustomerDecisions} where ${productOrderCustomerDecisions.orderId} = ${checkoutOrders.id} order by ${productOrderCustomerDecisions.createdAt} desc limit 1)`,
      addressChangeStatus: sql<
        string | null
      >`(select ${productOrderAddressChangeRequests.status}::text from ${productOrderAddressChangeRequests} where ${productOrderAddressChangeRequests.orderId} = ${checkoutOrders.id} order by ${productOrderAddressChangeRequests.createdAt} desc limit 1)`,
      addressChangeReconciliationState: sql<
        string | null
      >`(select ${productOrderAddressChangeRequests.reconciliationState} from ${productOrderAddressChangeRequests} where ${productOrderAddressChangeRequests.orderId} = ${checkoutOrders.id} order by ${productOrderAddressChangeRequests.createdAt} desc limit 1)`,
      shipmentHistoryCount: sql<number>`(select count(*)::int from ${productShipments} shipment_history where shipment_history.order_id = ${checkoutOrders.id})`,
      shipmentStatus: productShipments.status,
      shipmentId: productShipments.id,
      shipmentStateVersion: productShipments.stateVersion,
      shipmentProviderStatus: productShipments.providerStatus,
      shipmentTrackingNumber: productShipments.trackingNumber,
      shipmentTrackingUrl: productShipments.trackingUrl,
      shipmentQuotedShippingCents: productShipments.quotedShippingCents,
      shipmentActualPostageCents: productShipments.actualPostageCents,
      shipmentActualInsuranceCents: productShipments.actualInsuranceCents,
      shipmentActualPurchaseTotalCents:
        productShipments.actualPurchaseTotalCents,
      shipmentPackageSnapshot: productShipments.packageSnapshot,
      shipmentSelectedPostageType: productShipments.selectedPostageType,
      shipmentSequence: productShipments.sequence,
      shipmentPurpose: productShipments.purpose,
      shipmentHandoffDeadlineAt: productShipments.originalHandoffDeadlineAt,
      shipmentAutoRefundDeadlineAt: productShipments.autoRefundDeadlineAt,
      shipmentSignatureRequired: productShipments.signatureRequired,
      shipmentManualReviewAcknowledgedAt:
        productShipments.manualReviewAcknowledgedAt,
    })
    .from(checkoutOrders)
    .leftJoin(
      productShipments,
      eq(productShipments.id, checkoutOrders.activeFulfillmentShipmentId),
    )
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
        operations: {
          addressChangeReconciliationState:
            row.addressChangeReconciliationState,
          addressChangeStatus: row.addressChangeStatus,
          customerDecisionStatus: row.customerDecisionStatus,
          fraudClassification: row.fraudClassification,
          fraudRiskReasons: row.fraudRiskReasons,
          latestRefundStatus: row.latestRefundStatus,
          openCaseCount: row.openCaseCount,
          shipmentHistoryCount: row.shipmentHistoryCount,
        },
        shipment:
          row.shipmentStatus === null
            ? null
            : {
                id: row.shipmentId!,
                stateVersion: row.shipmentStateVersion!,
                status: row.shipmentStatus,
                providerStatus: row.shipmentProviderStatus,
                trackingNumber: row.shipmentTrackingNumber,
                trackingUrl: row.shipmentTrackingUrl,
                quotedShippingCents: row.shipmentQuotedShippingCents,
                actualShippingCents: row.shipmentActualPurchaseTotalCents,
                packageWeightGrams:
                  row.shipmentPackageSnapshot?.totalWeightGrams ?? 0,
                selectedPostageType: row.shipmentSelectedPostageType,
                sequence: row.shipmentSequence ?? 0,
                purpose: row.shipmentPurpose ?? "original",
                handoffDeadlineAt: row.shipmentHandoffDeadlineAt,
                autoRefundDeadlineAt: row.shipmentAutoRefundDeadlineAt,
                signatureRequired: row.shipmentSignatureRequired ?? false,
                manualReviewAcknowledgedAt:
                  row.shipmentManualReviewAcknowledgedAt,
              },
      };
    }),
    search,
    timezone,
    total,
  });
}

interface RawFulfillmentOperationRow extends Record<string, unknown> {
  conflict_token: string;
  deadline_at: Date | null;
  detail: string;
  evidence: string[];
  id: string;
  kind: string;
  order_reference: string | null;
  queue: AdminFulfillmentQueueKey;
  queue_position: number;
  queue_total: number;
  state_version: number;
  title: string;
}

export function returnObservationNeedsReviewSql(alias = "observation"): SQL {
  const table = sql.identifier(alias);
  return sql`(
    ${table}.${sql.identifier("resolved_at")} is null
    or ${table}.${sql.identifier("resolved_state_version")}
      is distinct from ${table}.${sql.identifier("state_version")}
  )`;
}

export async function listAdminFulfillmentOperations(
  input: {
    now?: Date;
  } = {},
): Promise<AdminFulfillmentOperations> {
  await requirePermission("fulfillment:view");

  const db = getPrivateDb();
  const now = input.now ?? new Date();
  const [timezone, result, canadaReadiness, usReadiness] = await Promise.all([
    getAdminBusinessTimezone(db),
    db.execute<RawFulfillmentOperationRow>(sql`
      with queue_items as (
        select
          'risk'::text as queue,
          incident.id::text as id,
          'payment-risk'::text as kind,
          ('Risk review for ' || orders.order_id)::text as title,
          ('Status ' || incident.status::text || '; policy ' || incident.policy_version)::text as detail,
          orders.order_id::text as order_reference,
          coalesce(incident.cooling_off_until, incident.created_at) as deadline_at,
          incident.state_version::int as state_version,
          (incident.id::text || ':' || incident.state_version::text || ':' || extract(epoch from incident.updated_at)::bigint::text)::text as conflict_token,
          array_remove(array[
            case when jsonb_array_length(incident.reason_codes) > 0 then 'Reasons: ' || incident.reason_codes::text end,
            case when incident.provider_evidence is not null then 'Provider evidence recorded' end,
            case when incident.owner_admin_user_id is not null then 'Owner assigned' end
          ], null)::text[] as evidence
        from product_payment_risk_incidents incident
        join checkout_orders orders on orders.id = incident.order_id
        where incident.status in ('pending', 'review_required') and incident.redacted_at is null

        union all

        select
          (case when quarantine.entity_type = 'checkout_payment_event' then 'refunds' else 'risk' end), quarantine.id::text, ('quarantine-' || quarantine.reason_code),
          ('Quarantined ' || replace(quarantine.entity_type, '_', ' ')),
          ('Automation denied until provider-backed conflict resolution; status ' || quarantine.status),
          orders.order_id,
          quarantine.created_at,
          1,
          (quarantine.id::text || ':1:' || extract(epoch from quarantine.updated_at)::bigint::text),
          array[
            'Entity: ' || quarantine.entity_id,
            'Reason: ' || quarantine.reason_code,
            'Evidence: ' || quarantine.evidence::text
          ]::text[]
        from fulfillment_data_quarantine quarantine
        left join checkout_orders orders
          on quarantine.entity_type = 'checkout_order'
          and quarantine.entity_id = orders.id::text
        where quarantine.status = 'open' and quarantine.redacted_at is null

        union all

        select
          'provider-jobs', alert.id::text, 'risk-alert',
          ('Risk alert delivery for ' || alert.incident_key),
          ('Status ' || alert.status || '; attempts ' || alert.attempt_count::text),
          orders.order_id,
          coalesce(alert.lease_expires_at, alert.available_at, alert.created_at),
          1,
          (alert.id::text || ':1:' || extract(epoch from alert.updated_at)::bigint::text),
          array_remove(array[
            'Idempotency: ' || alert.idempotency_key,
            case when alert.last_error is not null then 'Last error: ' || left(alert.last_error, 180) end
          ], null)::text[]
        from fulfillment_risk_alert_outbox alert
        join product_payment_risk_incidents incident on incident.id = alert.incident_id
        join checkout_orders orders on orders.id = incident.order_id
        where alert.status in ('queued', 'sending', 'dead_letter') and alert.redacted_at is null

        union all

        select
          'notifications', email.id::text, email.status,
          ('Customer email ' || replace(email.kind, '_', ' ')),
          ('Status ' || email.status || '; attempts ' || email.attempt_count::text),
          orders.order_id,
          coalesce(email.lease_expires_at, email.available_at, email.created_at),
          email.attempt_count,
          (email.id::text || ':' || email.attempt_count::text || ':' || round(extract(epoch from email.updated_at) * 1000)::bigint::text),
          array_remove(array[
            'Idempotency: ' || email.provider_idempotency_key,
            case when email.last_error is not null then 'Sanitized delivery error recorded' end,
            case when email.status = 'dead_letter' then 'Owner requeue required after cause review' end
          ], null)::text[]
        from customer_email_outbox email
        left join checkout_orders orders on orders.id = email.order_id
        where email.status in ('queued', 'sending', 'failed', 'dead_letter')
          and email.redacted_at is null

        union all

        select
          'provider-jobs', job.id::text,
          (case when job.status = 'dead_letter' then 'provider-job-dead-letter' else 'provider-job' end),
          ('Provider job ' || job.type::text || ' for shipment ' || shipment.public_reference),
          ('Status ' || job.status::text || '; attempts ' || job.attempt_count::text),
          orders.order_id,
          coalesce(job.next_attempt_at, job.available_at, job.created_at),
          job.state_version,
          (job.id::text || ':' || job.state_version::text || ':' || extract(epoch from job.updated_at)::bigint::text),
          array_remove(array[
            case when job.outcome_unknown then 'Provider outcome is unknown' end,
            case when job.outcome_code is not null then 'Outcome: ' || job.outcome_code end,
            case when job.last_error is not null then 'Last error: ' || left(job.last_error, 180) end,
            case when job.operation_payload_hash is not null then 'Payload hash: ' || job.operation_payload_hash end
          ], null)::text[]
        from product_shipment_jobs job
        join product_shipments shipment on shipment.id = job.shipment_id
        left join checkout_orders orders on orders.id = shipment.order_id
        where job.status in ('queued', 'processing', 'retryable_failed', 'dead_letter')

        union all

        select
          'shipment-generations', shipment.id::text,
          (case when shipment.status = 'manual_review' and shipment.manual_review_acknowledged_at is null then 'shipment-manual-review' else 'shipment-generation' end),
          (initcap(shipment.purpose::text) || ' shipment #' || shipment.sequence::text),
          ('Status ' || shipment.status::text || '; provider ' || coalesce(shipment.provider_status, 'not reported')),
          orders.order_id,
          coalesce(shipment.original_handoff_deadline_at, shipment.auto_refund_deadline_at, shipment.quote_expires_at),
          shipment.state_version,
          (shipment.id::text || ':' || shipment.state_version::text || ':' || extract(epoch from shipment.updated_at)::bigint::text),
          array_remove(array[
            'Reference: ' || shipment.public_reference,
            case when shipment.supersedes_shipment_id is not null then 'Supersedes: ' || shipment.supersedes_shipment_id::text end,
            case when shipment.provider_shipment_id is not null then 'Provider shipment: ' || shipment.provider_shipment_id end
          ], null)::text[]
        from product_shipments shipment
        left join checkout_orders orders on orders.id = shipment.order_id
        where shipment.sequence > 0
          and shipment.status not in ('delivered', 'voided', 'abandoned')
          and shipment.redacted_at is null

        union all

        select
          'addresses-and-supplements', request.id::text, request.status::text,
          ('Address change for ' || orders.order_id),
          ('Status ' || request.status::text || '; reconciliation ' || request.reconciliation_state),
          orders.order_id,
          least(request.expires_at, coalesce(request.offer_expires_at, request.expires_at), coalesce(obligation.expires_at, request.expires_at)),
          request.state_version,
          (request.id::text || ':' || request.state_version::text || ':' || extract(epoch from request.updated_at)::bigint::text),
          array_remove(array[
            case when jsonb_array_length(request.risk_flags) > 0 then 'Risk flags: ' || request.risk_flags::text end,
            case when request.postage_difference_cents is not null then 'Postage difference: ' || request.postage_difference_cents::text || ' cents' end,
            case when obligation.id is not null then 'Supplement ' || obligation.status::text || ': ' || obligation.total_amount_cents::text || ' cents' end,
            case when request.provider_reconciliation is not null then 'Provider reconciliation recorded' end
          ], null)::text[]
        from product_order_address_change_requests request
        join checkout_orders orders on orders.id = request.order_id
        left join order_payment_obligations obligation on obligation.id = request.supplemental_obligation_id
        where request.status not in ('applied', 'rejected', 'expired', 'revoked')
          and request.redacted_at is null

        union all

        select
          'decisions-and-extensions', decision.id::text,
          (case when decision.legal_follow_up_recorded_at is null then 'customer-decision-follow-up' else 'customer-decision-reviewed' end),
          ('Customer decision for ' || orders.order_id),
          ('Pending outcome; scope ' || decision.scope_key || ' v' || decision.scope_version::text),
          orders.order_id,
          coalesce(decision.wait_until, decision.expires_at),
          decision.state_version,
          (decision.id::text || ':' || decision.state_version::text || ':' || extract(epoch from decision.updated_at)::bigint::text),
          array_remove(array[
            'Allowed: ' || decision.allowed_outcomes::text,
            case when decision.proposed_conditions is not null then 'Conditions recorded' end,
            case when decision.supersedes_decision_id is not null then 'Supersedes: ' || decision.supersedes_decision_id::text end,
            case when decision.legal_follow_up_recorded_at is not null then 'Legal follow-up evidence: ' || decision.legal_follow_up_evidence_reference end
          ], null)::text[]
        from product_order_customer_decisions decision
        join checkout_orders orders on orders.id = decision.order_id
        where (
            decision.status = 'pending'
            or (
              decision.status = 'selected'
              and decision.selected_outcome = 'wait'
              and decision.processed_at is null
            )
          )
          and decision.legal_follow_up_recorded_at is null
          and decision.redacted_at is null

        union all

        select
          'cases-claims-replacements-returns', observation.id::text, 'return-observation',
          ('Chit Chats return ' || observation.provider_return_id),
          ('Match ' || observation.match_status || '; provider status ' || coalesce(observation.provider_status, 'not reported')),
          orders.order_id,
          observation.observed_at,
          observation.state_version,
          (observation.id::text || ':' || observation.state_version::text || ':' || extract(epoch from observation.updated_at)::bigint::text),
          array_remove(array[
            'Provider return: ' || observation.provider_return_id,
            case when observation.provider_shipment_id is not null then 'Provider shipment: ' || observation.provider_shipment_id end,
            case when observation.return_reason is not null then 'Return reason: ' || observation.return_reason end,
            case when observation.resolution is not null then 'Provider resolution: ' || observation.resolution end,
            case when observation.case_id is not null then 'Linked case: ' || observation.case_id::text end,
            case when observation.resolved_at is not null then 'Prior owner review: ' || observation.admin_resolution_action end,
            case when observation.resolved_at is not null then 'Prior review evidence: ' || observation.admin_resolution_evidence_reference end,
            case when observation.resolved_state_version is distinct from observation.state_version then 'Provider evidence changed after the prior review; re-review is required' end
          ], null)::text[]
        from product_shipment_return_observations observation
        left join product_shipments shipment on shipment.id = observation.shipment_id
        left join checkout_orders orders on orders.id = shipment.order_id
        where ${returnObservationNeedsReviewSql()}
          and observation.redacted_at is null

        union all

        select
          'cases-claims-replacements-returns', shipping_case.id::text, shipping_case.type::text,
          (initcap(replace(shipping_case.type::text, '_', ' ')) || ' case for ' || orders.order_id),
          ('Status ' || shipping_case.status::text || coalesce('; remedy ' || shipping_case.remedy_choice, '')),
          orders.order_id,
          nullif(least(
            coalesce(shipping_case.customer_update_due_at, 'infinity'::timestamptz),
            coalesce(shipping_case.carrier_deadline_at, 'infinity'::timestamptz),
            coalesce(shipping_case.remedy_deadline_at, 'infinity'::timestamptz)
          ), 'infinity'::timestamptz),
          shipping_case.state_version,
          (shipping_case.id::text || ':' || shipping_case.state_version::text || ':' || extract(epoch from shipping_case.updated_at)::bigint::text),
          array_remove(array[
            case when shipping_case.provider_claim_reference is not null then 'Claim: ' || shipping_case.provider_claim_reference end,
            case when shipping_case.cause is not null then 'Cause: ' || shipping_case.cause end,
            'Evidence complete: ' || (
              select count(*)::text from jsonb_each_text(shipping_case.evidence_checklist) evidence_item where evidence_item.value = 'true'
            )
          ], null)::text[]
        from product_shipping_cases shipping_case
        join checkout_orders orders on orders.id = shipping_case.order_id
        where shipping_case.status in ('open', 'waiting_customer', 'waiting_provider', 'remedy_pending')
          and shipping_case.redacted_at is null

        union all

        select
          'refunds', refund.id::text,
          (case
            when refund.status in ('outcome_unknown', 'manual_review') and refund.manual_review_recorded_at is null then 'refund-manual-review'
            when refund.status in ('outcome_unknown', 'manual_review') then 'refund-reviewed'
            else 'refund-operation'
          end),
          ('Refund for ' || orders.order_id),
          ('Status ' || refund.status::text || '; ' || refund.amount_cents::text || ' ' || orders.currency || ' cents'),
          orders.order_id,
          coalesce(refund.lease_expires_at, refund.unknown_outcome_at, refund.created_at),
          refund.state_version,
          (refund.id::text || ':' || refund.state_version::text || ':' || extract(epoch from refund.updated_at)::bigint::text),
          array_remove(array[
            'Reason: ' || refund.reason,
            case when refund.provider_refund_id is not null then 'Provider refund: ' || refund.provider_refund_id end,
            case when refund.last_error_code is not null then 'Last error: ' || refund.last_error_code end,
            'Attempts: ' || refund.attempt_count::text,
            case when refund.manual_review_recorded_at is not null then 'Manual reconciliation evidence: ' || refund.manual_review_evidence_reference end
          ], null)::text[]
        from product_order_refunds refund
        join checkout_orders orders on orders.id = refund.order_id
        where (
            refund.status in ('queued', 'processing', 'failed')
            or (
              refund.status in ('outcome_unknown', 'manual_review')
              and refund.manual_review_recorded_at is null
            )
          )
          and refund.redacted_at is null

        union all

        select
          'provider-jobs', obligation.id::text, 'payment-initialization-' || coalesce(obligation.initialization_outcome, 'queued'),
          ('Payment initialization for ' || orders.order_id),
          ('Status ' || obligation.initialization_status::text || '; outcome ' || coalesce(obligation.initialization_outcome, 'queued')),
          orders.order_id,
          coalesce(obligation.initialization_lease_expires_at, obligation.updated_at),
          obligation.initialization_state_version,
          (obligation.id::text || ':' || obligation.initialization_state_version::text || ':' || extract(epoch from obligation.updated_at)::bigint::text),
          array_remove(array[
            'Merchant reference: ' || obligation.id::text,
            case when obligation.initialization_payload_hash is not null then 'Payload hash: ' || obligation.initialization_payload_hash end,
            case when obligation.initialization_last_error is not null then 'Last error: ' || obligation.initialization_last_error end,
            'Attempts: ' || obligation.initialization_attempt_count::text,
            'Policy: ' || obligation.policy_version,
            'Tax policy: ' || obligation.tax_policy_version
          ], null)::text[]
        from order_payment_obligations obligation
        join checkout_orders orders on orders.id = obligation.order_id
        where obligation.initialization_status = 'failed'
          and obligation.initialization_outcome in ('failed', 'outcome_unknown', 'manual_review')
          and obligation.payment_provider = 'square'
          and obligation.quarantined_at is null

        union all

        select
          'refunds', obligation.id::text, 'late-supplemental-capture',
          ('Late supplemental capture for ' || orders.order_id),
          ('Paid ' || obligation.purpose::text || ' obligation requires refund review; ' || obligation.total_amount_cents::text || ' ' || obligation.currency || ' cents'),
          orders.order_id,
          coalesce(obligation.paid_at, obligation.updated_at),
          obligation.quote_version,
          (obligation.id::text || ':' || obligation.quote_version::text || ':' || extract(epoch from obligation.updated_at)::bigint::text),
          array[
            'Obligation: ' || obligation.id::text,
            'Source: ' || obligation.source_workflow,
            'Policy: ' || obligation.policy_version,
            'Tax policy: ' || obligation.tax_policy_version
          ]::text[]
        from order_payment_obligations obligation
        join checkout_orders orders on orders.id = obligation.order_id
        where obligation.purpose in ('manual_shipping', 'address_increase')
          and obligation.status = 'paid'
          and obligation.quarantined_at is null
          and (orders.status in ('cancelled', 'refunded') or orders.manual_fulfillment_status = 'cancelled')
          and not exists (
            select 1
            from order_payment_transactions transaction
            join product_order_refunds linked_refund on linked_refund.payment_transaction_id = transaction.id
            where transaction.obligation_id = obligation.id
              and linked_refund.status in ('queued', 'processing', 'succeeded', 'outcome_unknown', 'manual_review')
          )

        union all

        select
          'manual-fulfillment', orders.id::text, orders.fulfillment_mode::text,
          (case when orders.fulfillment_mode = 'manual_pickup' then 'Manual pickup ' else 'Manual shipping ' end || orders.order_id),
          ('Status ' || coalesce(orders.manual_fulfillment_status, 'not started')),
          orders.order_id,
          coalesce(orders.paid_at, orders.created_at),
          1,
          (orders.id::text || ':1:' || extract(epoch from orders.updated_at)::bigint::text),
          array_remove(array[
            'Payment: ' || orders.status::text,
            case when orders.shipping_policy_version is not null then 'Policy: ' || orders.shipping_policy_version end,
            case when orders.tax_policy_version is not null then 'Tax: ' || orders.tax_policy_version end
          ], null)::text[]
        from checkout_orders orders
        where orders.fulfillment_mode in ('manual_pickup', 'manual_shipping')
          and coalesce(orders.manual_fulfillment_status, 'not_started') not in ('dispatched', 'completed', 'cancelled')
          and orders.deleted_at is null
      )
      ${boundedFulfillmentQueueSelectionSql()}
    `),
    evaluateCheckoutReadiness({ destinationCountryCode: "CA", now }),
    evaluateCheckoutReadiness({ destinationCountryCode: "US", now }),
  ]);

  const databaseQueueTotals = new Map<AdminFulfillmentQueueKey, number>();
  const rows: AdminFulfillmentOperationRow[] = result.rows.map((row) => {
    databaseQueueTotals.set(row.queue, Number(row.queue_total));
    return {
      conflictToken: row.conflict_token,
      deadlineAt: row.deadline_at === null ? null : new Date(row.deadline_at),
      detail: row.detail,
      evidence: row.evidence,
      id: row.id,
      kind: row.kind,
      legalNextActions: getFulfillmentLegalNextActions(row),
      orderReference: row.order_reference,
      queue: row.queue,
      stateVersion: Number(row.state_version),
      title: row.title,
    };
  });

  const readinessCounts = new Map<AdminFulfillmentQueueKey, number>();

  for (const [scope, readiness] of [
    ["CA", canadaReadiness],
    ["US", usReadiness],
  ] as const) {
    for (const blocker of readiness.blockers) {
      readinessCounts.set(
        "calendar-tax-policy-readiness",
        (readinessCounts.get("calendar-tax-policy-readiness") ?? 0) + 1,
      );
      rows.push({
        conflictToken: `readiness:${scope}:${blocker}`,
        deadlineAt: now,
        detail: `${scope} checkout is blocked: ${blocker}`,
        evidence: [
          `Policy version: ${readiness.policyVersion ?? "missing"}`,
          `Tax policy version: ${readiness.taxPolicyVersion ?? "missing"}`,
        ],
        id: `readiness:${scope}:${blocker}`,
        kind: blocker,
        legalNextActions: [
          "Complete the named readiness control; checkout remains blocked until authoritative evidence is current.",
        ],
        orderReference: null,
        queue: "calendar-tax-policy-readiness",
        stateVersion: 1,
        title: `${scope} readiness blocker`,
      });
    }
  }

  rows.sort(compareFulfillmentOperations);
  const queues = Object.fromEntries(
    ADMIN_FULFILLMENT_QUEUE_KEYS.map((queue) => {
      const returned = rows.filter((row) => row.queue === queue).length;
      const total =
        (databaseQueueTotals.get(queue) ?? 0) +
        (readinessCounts.get(queue) ?? 0);
      return [
        queue,
        {
          limit: ADMIN_FULFILLMENT_QUEUE_LIMIT,
          returned,
          total,
          truncated: total > returned,
        } satisfies AdminFulfillmentQueueState,
      ];
    }),
  ) as Record<AdminFulfillmentQueueKey, AdminFulfillmentQueueState>;
  return {
    generatedAt: now,
    queues,
    rows,
    timezone,
    timezoneLabel: getHumanTimezoneLabel(timezone),
  };
}

function getFulfillmentLegalNextActions(
  row: RawFulfillmentOperationRow,
): string[] {
  if (
    row.kind === "payment-initialization-outcome_unknown" ||
    row.kind === "payment-initialization-manual_review"
  ) {
    return [
      "Use the payment-obligation initialization reconciliation control. Reconcile-and-retry re-queues the obligation for an idempotent Square payment-link re-mint (matched by reference_id, adopting the existing link or creating it); record manual handoff when the obligation must leave the automated flow.",
    ];
  }
  if (row.kind === "payment-initialization-failed") {
    return [
      "Correct the deterministic validation or readiness failure. This state is not eligible for ambiguous provider-mutation reissue.",
    ];
  }
  if (row.kind === "provider-job-dead-letter") {
    return [
      "Request a leased reconciliation pass. The worker must reconcile by provider identity before any provider mutation.",
    ];
  }
  if (row.queue === "provider-jobs") {
    return [
      "Review the recorded outcome and allow only the existing leased worker or provider reconciliation path to proceed.",
    ];
  }
  if (row.kind === "shipment-manual-review") {
    return [
      "Acknowledge the exact shipment generation after documenting the evidence reviewed; do not activate another generation from this action.",
    ];
  }
  if (row.kind === "customer-decision-follow-up") {
    return [
      "Record the legal/customer follow-up evidence for this exact scoped decision. Issuance, revocation, and remedy processing remain separate actions.",
    ];
  }
  if (row.kind === "return-observation") {
    return [
      "Resolve this provider return observation through its dedicated control after inspection, unmatched-return escalation, or linked-case confirmation.",
    ];
  }
  if (row.kind === "refund-manual-review") {
    return [
      "Record durable external reconciliation handoff evidence. Do not submit another refund; authoritative settlement remains a separate provider reconciliation.",
    ];
  }
  if (
    row.kind.includes("quarantine") ||
    row.detail.includes("Automation denied")
  ) {
    return [
      "Reconcile authoritative provider evidence only. Quarantined data cannot be repaired or retried from this workspace.",
    ];
  }
  return [
    "Follow the recorded deadline and evidence without bypassing the domain workflow.",
  ];
}

function compareFulfillmentOperations(
  left: AdminFulfillmentOperationRow,
  right: AdminFulfillmentOperationRow,
): number {
  const leftDeadline = left.deadlineAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const rightDeadline = right.deadlineAt?.getTime() ?? Number.POSITIVE_INFINITY;
  return (
    leftDeadline - rightDeadline ||
    left.queue.localeCompare(right.queue) ||
    left.id.localeCompare(right.id)
  );
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
