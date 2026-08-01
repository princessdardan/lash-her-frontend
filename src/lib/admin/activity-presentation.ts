import type {
  AdminAuditMetadata,
  AdminAuditOutcome,
  AdminRole,
} from "@/lib/private-db/schema";

import { localDateTimeToUtc } from "./local-time";

export const ADMIN_ACTIVITY_PAGE_SIZE = 25;
export const ADMIN_ACTIVITY_TIMEZONE = "America/Toronto";

export const ADMIN_ACTIVITY_AREA_OPTIONS = [
  {
    domains: ["bookings", "appointments"],
    label: "Appointments",
    value: "appointments",
  },
  {
    domains: ["booking_setup"],
    label: "Booking settings",
    value: "booking-settings",
  },
  {
    domains: ["authorization"],
    label: "Access control",
    value: "authorization",
  },
  {
    domains: ["calendar"],
    label: "Calendar sync",
    value: "calendar",
  },
  {
    domains: ["marketing"],
    label: "Marketing audience",
    value: "marketing",
  },
  {
    domains: ["offerings", "service_promotions"],
    label: "Services & pricing",
    value: "services",
  },
  {
    domains: ["square_attribution"],
    label: "Square sales matching",
    value: "square",
  },
  {
    domains: ["staff"],
    label: "Team",
    value: "team",
  },
  {
    domains: ["schedules"],
    label: "Availability",
    value: "availability",
  },
] as const;

export const ADMIN_ACTIVITY_RESULT_OPTIONS = [
  { label: "Completed", value: "success" },
  { label: "Not allowed", value: "denied" },
  { label: "Failed", value: "failure" },
] as const;

export type AdminActivityArea =
  (typeof ADMIN_ACTIVITY_AREA_OPTIONS)[number]["value"];

export interface AdminActivityQueryFilters {
  actorId?: string;
  area?: AdminActivityArea;
  createdFrom?: Date;
  createdToExclusive?: Date;
  outcome?: AdminAuditOutcome;
  page: number;
  pageSize: number;
}

export interface AdminActivityFilterValues {
  actorId: string;
  area: string;
  from: string;
  outcome: string;
  to: string;
}

export interface ParsedAdminActivityQuery {
  dateError: string | null;
  filters: AdminActivityQueryFilters;
  values: AdminActivityFilterValues;
}

export interface AdminActivitySourceRecord {
  action: string;
  actorDisplayName: string | null;
  actorEmail: string | null;
  actorRole: AdminRole;
  correlationId: string | null;
  createdAt: Date;
  domain: string;
  id: string;
  metadata: AdminAuditMetadata | null;
  outcome: AdminAuditOutcome;
  reason: string | null;
  targetId: string | null;
  targetLabel: string | null;
  targetType: string | null;
}

export interface AdminActivityPresentation {
  actorLabel: string;
  areaLabel: string;
  createdAt: Date;
  description: string;
  id: string;
  result: {
    label: string;
    tone: "attention" | "success";
  };
  systemDetails: {
    action: string;
    actorRole: AdminRole;
    correlationId: string | null;
    domain: string;
    outcome: AdminAuditOutcome;
    reason: string | null;
    requestedPermission: string | null;
    targetId: string | null;
    targetType: string | null;
  };
  targetHref: string | null;
  targetLabel: string | null;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseAdminActivityQuery(input: {
  actor?: string | string[];
  area?: string | string[];
  from?: string | string[];
  page?: string | string[];
  result?: string | string[];
  to?: string | string[];
}): ParsedAdminActivityQuery {
  const actorId = firstString(input.actor).trim();
  const area = firstString(input.area).trim();
  const from = firstString(input.from).trim();
  const outcome = firstString(input.result).trim();
  const to = firstString(input.to).trim();
  const page = parsePositiveInteger(firstString(input.page), 1);
  const filters: AdminActivityQueryFilters = {
    page,
    pageSize: ADMIN_ACTIVITY_PAGE_SIZE,
  };

  if (UUID_PATTERN.test(actorId)) {
    filters.actorId = actorId;
  }
  if (isAdminActivityArea(area)) {
    filters.area = area;
  }
  if (isAdminActivityOutcome(outcome)) {
    filters.outcome = outcome;
  }

  let dateError: string | null = null;
  try {
    if (from) {
      filters.createdFrom = parseBusinessDateStart(from);
    }
    if (to) {
      filters.createdToExclusive = parseBusinessDateStart(
        addCalendarDays(to, 1),
      );
    }
  } catch {
    dateError = "Use valid From and To dates.";
    delete filters.createdFrom;
    delete filters.createdToExclusive;
  }

  if (
    filters.createdFrom &&
    filters.createdToExclusive &&
    filters.createdFrom >= filters.createdToExclusive
  ) {
    dateError = "The From date must be on or before the To date.";
    delete filters.createdFrom;
    delete filters.createdToExclusive;
  }

  return {
    dateError,
    filters,
    values: {
      actorId: filters.actorId ?? "",
      area: filters.area ?? "",
      from,
      outcome: filters.outcome ?? "",
      to,
    },
  };
}

export function getAdminActivityDomains(area: AdminActivityArea): string[] {
  const option = ADMIN_ACTIVITY_AREA_OPTIONS.find(
    (candidate) => candidate.value === area,
  );
  return option ? [...option.domains] : [];
}

export function presentAdminActivity(
  record: AdminActivitySourceRecord,
): AdminActivityPresentation {
  const actorLabel =
    cleanLabel(record.actorDisplayName) ??
    cleanLabel(record.actorEmail) ??
    "Former staff member";
  const targetLabel =
    cleanLabel(record.targetLabel) ?? getFallbackTargetLabel(record.targetType);
  const attempt = getActivityAttempt(
    record.action,
    record.metadata,
    targetLabel,
  );
  const description = describeOutcome({
    action: record.action,
    actorLabel,
    attempt,
    outcome: record.outcome,
    targetLabel,
  });
  const displayedOutcome = isRecordedFailureAction(record.action)
    ? "failure"
    : record.outcome;
  const result =
    displayedOutcome === "success"
      ? { label: "Completed", tone: "success" as const }
      : {
          label: displayedOutcome === "denied" ? "Not allowed" : "Failed",
          tone: "attention" as const,
        };

  return {
    actorLabel,
    areaLabel: getAdminActivityAreaLabel(record.domain),
    createdAt: record.createdAt,
    description,
    id: record.id,
    result,
    systemDetails: {
      action: record.action,
      actorRole: record.actorRole,
      correlationId: record.correlationId,
      domain: record.domain,
      outcome: record.outcome,
      reason: record.reason,
      requestedPermission: getMetadataString(
        record.metadata,
        "requestedPermission",
      ),
      targetId: record.targetId,
      targetType: record.targetType,
    },
    targetHref: getTargetHref(record.targetType, record.targetId),
    targetLabel:
      record.targetType &&
      targetLabel !== getFallbackTargetLabel(record.targetType)
        ? targetLabel
        : null,
  };
}

function describeOutcome(input: {
  action: string;
  actorLabel: string;
  attempt: ActivityAttempt;
  outcome: AdminAuditOutcome;
  targetLabel: string;
}): string {
  if (
    input.outcome === "success" &&
    input.action === "developer_session_started"
  ) {
    return `A privileged developer session started for ${input.targetLabel}.`;
  }

  if (input.outcome === "success" && isRecordedFailureAction(input.action)) {
    return `${input.actorLabel} recorded a failed Google Calendar authorization for ${input.targetLabel}.`;
  }

  if (input.outcome === "success") {
    return `${input.actorLabel} ${input.attempt.completed}.`;
  }
  if (input.outcome === "denied") {
    return `${input.actorLabel} was not allowed to ${input.attempt.infinitive}.`;
  }
  return `An attempt by ${input.actorLabel} to ${input.attempt.infinitive} failed.`;
}

function isRecordedFailureAction(action: string): boolean {
  return (
    action === "calendar_connection_authorization_failed" ||
    action === "employee_calendar_authorization_failed"
  );
}

interface ActivityAttempt {
  completed: string;
  infinitive: string;
}

function getActivityAttempt(
  action: string,
  metadata: AdminAuditMetadata | null,
  target: string,
): ActivityAttempt {
  const status = getMetadataString(metadata, "status");

  switch (action) {
    case "staff_created":
      return attempt(
        `added ${target} to the team`,
        `add ${target} to the team`,
      );
    case "staff_status_changed":
      if (status === "disabled") {
        return attempt(
          `disabled ${target}'s access`,
          `disable ${target}'s access`,
        );
      }
      if (status === "active") {
        return attempt(
          `restored ${target}'s access`,
          `restore ${target}'s access`,
        );
      }
      return attempt(`updated ${target}'s access`, `update ${target}'s access`);
    case "staff_resource_assigned":
      return attempt(
        `gave ${target} access to a bookable resource`,
        `give ${target} access to a bookable resource`,
      );
    case "staff_resource_unassigned":
      return attempt(
        `removed bookable-resource access from ${target}`,
        `remove bookable-resource access from ${target}`,
      );
    case "booking_resource_created":
      return attempt(`created ${target}`, `create ${target}`);
    case "booking_resource_profile_updated":
      return attempt(`updated ${target}`, `update ${target}`);
    case "booking_resource_status_changed":
      return statusAttempt(target, status);
    case "booking_service_created":
      return attempt(`created ${target}`, `create ${target}`);
    case "booking_service_profile_updated":
      return attempt(`updated ${target}`, `update ${target}`);
    case "booking_service_status_changed":
      return statusAttempt(target, status);
    case "service_offering_created":
      return attempt(`created ${target}`, `create ${target}`);
    case "service_offering_order_updated":
      return attempt(
        "changed service display order",
        "change service display order",
      );
    case "service_offering_updated":
      return attempt(`updated ${target}`, `update ${target}`);
    case "service_offering_status_changed":
      return statusAttempt(target, status);
    case "service_offering_resource_assigned":
      return attempt(
        `assigned a room or piece of equipment to ${target}`,
        `assign a room or piece of equipment to ${target}`,
      );
    case "service_offering_resource_removed":
      return attempt(
        `removed a room or piece of equipment from ${target}`,
        `remove a room or piece of equipment from ${target}`,
      );
    case "offering_add_on_created":
      return attempt(`created ${target}`, `create ${target}`);
    case "offering_add_on_status_changed":
      return statusAttempt(target, status);
    case "service_promotion_created":
      return attempt(`created ${target}`, `create ${target}`);
    case "service_promotion_updated":
      return attempt(`updated ${target}`, `update ${target}`);
    case "service_promotion_status_changed":
      return statusAttempt(target, status);
    case "booking_settings_updated":
      return attempt("updated booking settings", "update booking settings");
    case "resource_schedule_created":
      return attempt(
        `added regular hours for ${target}`,
        `add regular hours for ${target}`,
      );
    case "resource_schedule_disabled":
      return attempt(
        `disabled regular hours for ${target}`,
        `disable regular hours for ${target}`,
      );
    case "schedule_exception_created":
      return getMetadataString(metadata, "kind") === "available"
        ? attempt(
            `opened extra hours for ${target}`,
            `open extra hours for ${target}`,
          )
        : attempt(`added time off for ${target}`, `add time off for ${target}`);
    case "schedule_exception_cancelled":
      return attempt(
        `cancelled an availability change for ${target}`,
        `cancel an availability change for ${target}`,
      );
    case "calendar_connection_created":
    case "employee_calendar_connection_created":
      return attempt(
        `started connecting ${target}`,
        `start connecting ${target}`,
      );
    case "calendar_connection_authorized":
    case "employee_calendar_oauth_completed":
      return attempt(`connected ${target}`, `connect ${target}`);
    case "calendar_connection_authorization_failed":
    case "employee_calendar_authorization_failed":
      return attempt(`connected ${target}`, `connect ${target}`);
    case "calendar_connection_disabled":
    case "employee_calendar_connection_disconnected":
      return attempt(`disconnected ${target}`, `disconnect ${target}`);
    case "calendar_connection_ownership_transferred":
      return attempt(
        `changed who manages ${target}`,
        `change who manages ${target}`,
      );
    case "calendar_assignment_saved":
    case "employee_calendar_assignment_saved":
      return attempt(`updated ${target}`, `update ${target}`);
    case "calendar_assignment_disabled":
    case "employee_calendar_assignment_disabled":
      return attempt(`disabled ${target}`, `disable ${target}`);
    case "square_team_mappings_refreshed":
      return attempt(
        "checked Square sales matching",
        "check Square sales matching",
      );
    case "square_team_mapping_changed":
      return attempt(
        `updated Square sales matching for ${target}`,
        `update Square sales matching for ${target}`,
      );
    case "square_team_mapping_removed":
      return attempt(
        `removed Square sales matching from ${target}`,
        `remove Square sales matching from ${target}`,
      );
    case "square_attribution_enforcement_changed":
      return attempt(
        "updated the Square sales-matching requirement",
        "update the Square sales-matching requirement",
      );
    case "appointment_completed":
      return attempt(`marked ${target} complete`, `mark ${target} complete`);
    case "appointment_marked_no_show":
      return attempt(
        `marked ${target} as a no-show`,
        `mark ${target} as a no-show`,
      );
    case "appointment_detail_view":
      return attempt(`viewed ${target}`, `view ${target}`);
    case "marketing_contacts_view":
      return attempt(
        "viewed the marketing audience",
        "view the marketing audience",
      );
    case "audit_log_view":
      return attempt("viewed Activity history", "view Activity history");
    case "permission_denied":
      return attempt(
        "accessed a restricted admin area",
        "access a restricted admin area",
      );
    case "developer_session_started":
      return attempt(
        `started a privileged developer session for ${target}`,
        `start a privileged developer session for ${target}`,
      );
    default:
      return attempt(
        "performed an administrative action",
        "perform an administrative action",
      );
  }
}

function statusAttempt(target: string, status: string | null): ActivityAttempt {
  switch (status) {
    case "active":
      return attempt(`made ${target} active`, `make ${target} active`);
    case "archived":
      return attempt(`archived ${target}`, `archive ${target}`);
    case "disabled":
      return attempt(`disabled ${target}`, `disable ${target}`);
    case "draft":
      return attempt(`moved ${target} to draft`, `move ${target} to draft`);
    default:
      return attempt(`changed ${target}'s status`, `change ${target}'s status`);
  }
}

function attempt(completed: string, infinitive: string): ActivityAttempt {
  return { completed, infinitive };
}

function getAdminActivityAreaLabel(domain: string): string {
  const option = ADMIN_ACTIVITY_AREA_OPTIONS.find((candidate) =>
    candidate.domains.some((candidateDomain) => candidateDomain === domain),
  );
  return option?.label ?? "Administration";
}

function getFallbackTargetLabel(targetType: string | null): string {
  switch (targetType) {
    case "admin_user":
      return "a team member";
    case "appointment":
      return "an appointment";
    case "booking_provider":
      return "a provider";
    case "booking_resource":
      return "a bookable resource";
    case "booking_service":
      return "a service";
    case "calendar_assignment":
      return "a calendar assignment";
    case "calendar_connection":
      return "a Google Calendar account";
    case "offering_add_on":
      return "a service add-on";
    case "resource_schedule":
      return "a regular-hours schedule";
    case "schedule_exception":
      return "an availability change";
    case "service_offering":
      return "a service offering";
    case "service_promotion_code":
      return "a promotion code";
    case "square_team_directory":
      return "the Square team directory";
    default:
      return "an administrative record";
  }
}

function getTargetHref(
  targetType: string | null,
  targetId: string | null,
): string | null {
  switch (targetType) {
    case "admin_user":
    case "booking_provider":
    case "booking_resource":
      return "/admin/staff";
    case "appointment":
      return targetId
        ? `/admin/appointments/${encodeURIComponent(targetId)}`
        : "/admin/appointments";
    case "booking_service":
    case "offering_add_on":
    case "service_offering":
      return "/admin/offerings";
    case "calendar_assignment":
    case "calendar_connection":
      return "/admin/calendar-connections";
    case "resource_schedule":
    case "schedule_exception":
      return "/admin/schedules";
    case "service_promotion_code":
      return "/admin/service-promotions";
    default:
      return null;
  }
}

function getMetadataString(
  metadata: AdminAuditMetadata | null,
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isAdminActivityArea(value: string): value is AdminActivityArea {
  return ADMIN_ACTIVITY_AREA_OPTIONS.some((option) => option.value === value);
}

function isAdminActivityOutcome(value: string): value is AdminAuditOutcome {
  return ADMIN_ACTIVITY_RESULT_OPTIONS.some((option) => option.value === value);
}

function parseBusinessDateStart(value: string): Date {
  if (!DATE_PATTERN.test(value)) {
    throw new Error("Invalid date");
  }
  return localDateTimeToUtc(`${value}T00:00`, ADMIN_ACTIVITY_TIMEZONE);
}

function addCalendarDays(value: string, amount: number): string {
  if (!DATE_PATTERN.test(value)) {
    throw new Error("Invalid date");
  }
  const [year, month, day] = value.split("-").map(Number);
  const source = new Date(Date.UTC(year, month - 1, day));
  if (source.toISOString().slice(0, 10) !== value) {
    throw new Error("Invalid date");
  }
  source.setUTCDate(source.getUTCDate() + amount);
  return source.toISOString().slice(0, 10);
}

function parsePositiveInteger(value: string, fallback: number): number {
  if (!/^\d+$/.test(value)) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function firstString(value: string | string[] | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  return Array.isArray(value) ? (value[0] ?? "") : "";
}

function cleanLabel(value: string | null): string | null {
  const cleaned = value?.trim() ?? "";
  return cleaned || null;
}
